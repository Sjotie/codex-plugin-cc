#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

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

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
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

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
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

  function routeNotification(message) {
    if (!trackTurn(message)) {
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
        if (pidFile) {
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
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
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
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
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

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.on("listening", () => scheduleIdleShutdown(server));
  // The broker proxies every request to the single app-server child spawned
  // above. If that child exits, request() writes to a closed stdin and its
  // promise never resolves, so a caller hangs forever while ensureBrokerSession
  // keeps reusing the still-listening socket. Terminate so the next connect
  // spawns a fresh, working broker. (Upstream PR #453, reapplied on PR #491.)
  appClient.exitPromise.then(() => {
    if (!shutdownPromise) {
      shutdown(server).finally(() => process.exit(1));
    }
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
