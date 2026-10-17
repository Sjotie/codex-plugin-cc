#!/usr/bin/env node

/** @typedef {import("./lib/app-server-protocol").BrokerInitializeResponse} BrokerInitializeResponse */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { APPS_POLICY_ID } from "./lib/app-policy.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { readBrokerPidFile, removeBrokerSessionDir } from "./lib/broker-session-cleanup.mjs";
import { isProcessAlive } from "./lib/process.mjs";

// Set by the process that created the session directory, in case its TMPDIR differs from ours.
const BROKER_TMPDIR_ENV = "CODEX_COMPANION_BROKER_TMPDIR";
const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const BROKER_IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS";
const DEFAULT_BROKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const BROKER_ORPHAN_GRACE_ENV = "CODEX_COMPANION_BROKER_ORPHAN_GRACE_MS";
// Codex can send turn/completed ~0.5 s after the final answer, when the
// companion has already inferred completion and disconnected.
const DEFAULT_BROKER_ORPHAN_GRACE_MS = 10 * 1000;

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

/**
 * The one writer of the broker's `initialize` answer; its parameter is the type
 * the client reads (app-server.mjs), so the wire reply is checked at build time.
 * @param {net.Socket} socket
 * @param {unknown} id
 * @param {BrokerInitializeResponse} result
 */
function sendInitializeResult(socket, id, result) {
  send(socket, { id, result });
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

// A second broker started on the same pid file must not take it over: it would fail on the
// socket and its exit hook would then remove the directory of the broker that is still running.
function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  const holder = readBrokerPidFile(path.dirname(pidFile));
  if (holder && holder !== process.pid && isProcessAlive(holder)) {
    throw new Error(`A broker (pid ${holder}) is already running for ${path.dirname(pidFile)}.`);
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function resolveTimeoutMs(value, fallbackMs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMs;
  }
  return Math.max(1, Math.floor(parsed));
}

async function main() {
  // #1962: the session directory (pid file, socket, log) is this broker's own. Remove it on
  // every way out, including signals and a failed start. After an error exit broker.log stays,
  // since it holds the reason; the next start's sweep removes that directory. SIGKILL is
  // covered by the same sweep. Registered first so no later startup step can skip it, and it
  // acts only on a pid file this process wrote and no other broker has taken over since.
  let ownedPidFile = null;
  process.on("exit", (code) => {
    if (!ownedPidFile) {
      return;
    }
    const dir = path.dirname(ownedPidFile);
    const holder = readBrokerPidFile(dir);
    if (holder && holder !== process.pid) {
      return;
    }
    removeBrokerSessionDir(dir, { keepLog: code !== 0, root: process.env[BROKER_TMPDIR_ENV] || os.tmpdir() });
  });

  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);
  ownedPidFile = pidFile;
  // Until the server exists there is nothing to shut down gracefully, but a signal during
  // the app-server connect must still end in a normal exit so the hook above runs.
  const exitBeforeServer = () => process.exit(0);
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, exitBeforeServer);
  }

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  // The turn the stream was started for (turn/start, review/start); unknown
  // for thread/compact/start, which then ends on any turn/completed of its threads.
  let activeStreamTurnId = null;
  let activeRequestThreadId = null;
  const sockets = new Set();
  const idleTimeoutMs = resolveTimeoutMs(process.env[BROKER_IDLE_TIMEOUT_ENV], DEFAULT_BROKER_IDLE_TIMEOUT_MS);
  const orphanGraceMs = resolveTimeoutMs(process.env[BROKER_ORPHAN_GRACE_ENV], DEFAULT_BROKER_ORPHAN_GRACE_MS);
  let idleTimer = null;
  let shutdownPromise = null;
  // Turns running on the app-server, by thread. A client that dies mid-stream
  // (worker SIGTERM/SIGKILL, host restart) leaves its turn running with nobody
  // reading it, and the app-server holds ~/.codex/thread-writer-locks/<thread>.lock
  // until it exits: every other app-server (direct fallback, `codex resume`, a
  // fresh broker) is refused with "already has an active writer" (#398).
  const runningTurns = new Map();
  let retireWhenIdle = false;

  function cancelIdleShutdown() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function isFullyIdle() {
    return sockets.size === 0 && !activeRequestSocket && !activeStreamSocket;
  }

  function isBusyForShutdown(requestingSocket) {
    return Boolean(
      activeRequestSocket ||
        activeStreamSocket ||
        [...sockets].some((socket) => socket !== requestingSocket)
    );
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      const threadIds = activeStreamThreadIds;
      activeStreamSocket = null;
      activeStreamThreadIds = null;
      activeStreamTurnId = null;
      abandonStream(threadIds);
    }
  }

  // The client that owned a stream on these threads is gone. A client may
  // leave after the final answer but before turn/completed, so wait a grace
  // period and only then interrupt a turn still running on those threads,
  // unless another client has taken the thread over meanwhile. After an
  // interrupt, retire the broker once it is idle: only the app-server exiting
  // releases the thread lock (it keeps a thread loaded after thread/unsubscribe).
  function abandonStream(threadIds, startedTurn = null) {
    const turnAtLeave = new Map(
      [...(threadIds ?? [])].map((threadId) => [
        threadId,
        runningTurns.get(threadId) ?? (startedTurn?.threadId === threadId ? startedTurn.turnId : null) ?? null
      ])
    );
    if (turnAtLeave.size === 0) {
      return;
    }
    setTimeout(() => {
      let interrupted = false;
      for (const [threadId, turnIdAtLeave] of turnAtLeave) {
        const turnId = runningTurns.get(threadId);
        const takenOver = turnIdAtLeave
          ? turnId !== turnIdAtLeave
          : Boolean(activeStreamThreadIds?.has(threadId) || (activeRequestSocket && activeRequestThreadId === threadId));
        if (!turnId || takenOver) {
          continue;
        }
        appClient.request("turn/interrupt", { threadId, turnId }).catch(() => {});
        interrupted = true;
      }
      if (interrupted) {
        retireWhenIdle = true;
        scheduleIdleShutdown(server);
      }
    }, orphanGraceMs).unref?.();
  }

  // Returns false for a turn/completed of a turn that is no longer the
  // thread's current one, e.g. an interrupted orphan finishing after another
  // client took the thread over.
  function trackTurn(message) {
    const threadId = message.params?.threadId;
    const turnId = message.params?.turn?.id;
    if (!threadId || !turnId) {
      return true;
    }
    if (message.method === "turn/started") {
      runningTurns.set(threadId, turnId);
    } else if (message.method === "turn/completed") {
      const currentTurnId = runningTurns.get(threadId);
      if (currentTurnId && currentTurnId !== turnId) {
        return false;
      }
      runningTurns.delete(threadId);
    }
    return true;
  }

  function isForeignCompletion(message) {
    const threadId = message.params?.threadId;
    const turnId = message.params?.turn?.id;
    return Boolean(
      message.method === "turn/completed" &&
        activeStreamTurnId &&
        turnId &&
        turnId !== activeStreamTurnId &&
        activeStreamThreadIds?.has(threadId)
    );
  }

  function routeNotification(message) {
    // A turn/completed on the stream's threads for another turn (an orphan
    // finishing after this client took the thread over) is not this stream's.
    if (!trackTurn(message) || isForeignCompletion(message)) {
      return;
    }
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        activeStreamTurnId = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  function shutdown(server) {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        cancelIdleShutdown();
        const serverClosed = new Promise((resolve) => server.close(resolve));
        if (listenTarget.kind === "unix") {
          fs.rmSync(listenTarget.path, { force: true });
        }
        for (const socket of sockets) {
          socket.end();
        }
        await appClient.close().catch(() => {});
        await serverClosed;
        // The pid file goes last: while it names this live process the start-sweep treats the
        // directory as alive, so a half-closed broker is never taken for dead.
        if (pidFile && [null, process.pid].includes(readBrokerPidFile(path.dirname(pidFile)))) {
          fs.rmSync(pidFile, { force: true });
        }
      })();
    }
    return shutdownPromise;
  }

  function scheduleIdleShutdown(server) {
    cancelIdleShutdown();
    if (!isFullyIdle() || shutdownPromise) {
      return;
    }

    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!isFullyIdle() || shutdownPromise) {
        return;
      }
      shutdown(server).then(
        () => process.exit(0),
        (error) => {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          process.exit(1);
        }
      );
    }, retireWhenIdle ? orphanGraceMs : idleTimeoutMs);
    idleTimer.unref?.();
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    if (shutdownPromise) {
      socket.destroy();
      return;
    }
    cancelIdleShutdown();
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          sendInitializeResult(socket, message.id, {
            userAgent: "codex-companion-broker",
            appPolicy: APPS_POLICY_ID
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          if (isBusyForShutdown(socket)) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
            });
            continue;
          }
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        activeRequestThreadId = message.params?.threadId ?? null;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming && !sockets.has(socket)) {
            // The client left while the stream was starting. Claiming the
            // stream for a closed socket would keep the broker busy forever.
            abandonStream(
              buildStreamThreadIds(message.method, message.params ?? {}, result),
              message.method === "turn/start" ? { threadId: message.params?.threadId, turnId: result?.turn?.id } : null
            );
          } else if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            activeStreamTurnId = result?.turn?.id ?? null;
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          // A lost child connection is transport failure, not an RPC refusal.
          // Keep that distinction when it happens before the start response.
          if (appClient.exitResolved && error.data === undefined && error.rpcCode === undefined) {
            socket.destroy();
            continue;
          }
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    const releaseSocket = () => {
      const removed = sockets.delete(socket);
      clearSocketOwnership(socket);
      if (removed) {
        scheduleIdleShutdown(server);
      }
    };
    socket.on("close", releaseSocket);
    socket.on("error", releaseSocket);
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    process.off(signal, exitBeforeServer);
  }

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, async () => {
      await shutdown(server);
      process.exit(0);
    });
  }

  server.on("listening", () => scheduleIdleShutdown(server));
  // The broker proxies every request to the single app-server child spawned
  // above. If that child exits, request() writes to a closed stdin and its
  // promise never resolves, so a caller hangs forever while ensureBrokerSession
  // keeps reusing the still-listening socket. Terminate so the next connect
  // spawns a fresh, working broker. (Upstream PR #453, reapplied on PR #491.)
  appClient.exitPromise.then(() => {
    if (!shutdownPromise) {
      process.stderr.write(`Codex app-server child closed: ${appClient.exitError?.message ?? "exit 0"}\n`);
      shutdown(server).finally(() => process.exit(1));
    }
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
