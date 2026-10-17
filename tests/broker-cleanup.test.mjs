// #1962: the broker removes its own session directory on every way out, and the next
// start removes the directories of brokers that died without being able to.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  ensureBrokerSession,
  sendBrokerShutdown,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import {
  isBrokerSessionDirName,
  removeBrokerSessionDir,
  sweepOrphanedBrokerSessionDirs
} from "../plugins/codex/scripts/lib/broker-session-cleanup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");
const HOUR = 60 * 60 * 1000;
const POSIX = { skip: process.platform === "win32" };

function makeSessionDir(base) {
  return fs.mkdtempSync(path.join(base, "cxc-"));
}

function age(dir, ms = 2 * HOUR) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(dir, when, when);
}

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid;
}

function listenOn(dir, t) {
  const server = net.createServer((socket) => socket.end());
  t.after(() => server.close());
  const endpoint = createBrokerEndpoint(dir);
  return new Promise((resolve) => server.listen(endpoint.slice("unix:".length), () => resolve(server)));
}

// The readiness probe's own connection may not be closed yet, which makes the broker answer "busy".
async function shutdownBroker(endpoint) {
  let outcome = await sendBrokerShutdown(endpoint);
  for (let i = 0; i < 20 && outcome !== "accepted"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    outcome = await sendBrokerShutdown(endpoint);
  }
  return outcome;
}

function startBroker(t, { binDir, sessionDir, isolatePath = false }) {
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawn(
    process.execPath,
    [BROKER, "serve", "--endpoint", endpoint, "--cwd", makeTempDir(), "--pid-file", path.join(sessionDir, "broker.pid")],
    { env: { ...(isolatePath ? { ...process.env, PATH: binDir } : buildEnv(binDir)), CODEX_COMPANION_BROKER_TMPDIR: path.dirname(sessionDir) }, stdio: "ignore" }
  );
  t.after(() => {
    if (child.exitCode === null) {
      child.kill();
    }
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, endpoint, exited };
}

test("session directory names: only mkdtemp-shaped cxc- names qualify", () => {
  assert.equal(isBrokerSessionDirName("cxc-Ab12Zz"), true);
  for (const name of ["cxc-", "cxc-short", "cxc-Ab12Zz9", "xcxc-Ab12Zz", "cxc-Ab12Z/", "cxc-Ab12Z."]) {
    assert.equal(isBrokerSessionDirName(name), false, name);
  }
});

test("a broker removes its session directory on a shutdown request", POSIX, async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionDir = makeSessionDir(makeTempDir());
  const { endpoint, exited } = startBroker(t, { binDir, sessionDir });
  assert.equal(await waitForBrokerEndpoint(endpoint, 10000), true);
  assert.ok(fs.existsSync(path.join(sessionDir, "broker.pid")));

  assert.equal(await shutdownBroker(endpoint), "accepted");
  assert.equal((await exited).code, 0);
  assert.equal(fs.existsSync(sessionDir), false);
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`a broker removes its session directory on ${signal}`, POSIX, async (t) => {
    const binDir = makeTempDir();
    installFakeCodex(binDir);
    const sessionDir = makeSessionDir(makeTempDir());
    const { child, endpoint, exited } = startBroker(t, { binDir, sessionDir });
    assert.equal(await waitForBrokerEndpoint(endpoint, 10000), true);

    child.kill(signal);
    await exited;
    assert.equal(fs.existsSync(sessionDir), false);
  });
}

test("a broker still starting (no app-server yet) removes its session directory when stopped", POSIX, async (t) => {
  // No codex on PATH: the broker never gets past connecting to its app-server.
  const sessionDir = makeSessionDir(makeTempDir());
  const { child, exited } = startBroker(t, { binDir: makeTempDir(), sessionDir, isolatePath: true });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(sessionDir, "broker.pid")); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(fs.existsSync(path.join(sessionDir, "broker.pid")) || child.exitCode !== null);

  if (child.exitCode === null) {
    child.kill("SIGTERM");
  }
  await exited;
  assert.equal(fs.existsSync(sessionDir), false);
});

test("a second broker on the same directory refuses to start and leaves the first one untouched", POSIX, async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionDir = makeSessionDir(makeTempDir());
  const first = startBroker(t, { binDir, sessionDir });
  assert.equal(await waitForBrokerEndpoint(first.endpoint, 10000), true);

  const second = startBroker(t, { binDir, sessionDir });
  const { code } = await second.exited;
  assert.notEqual(code, 0);

  assert.equal(fs.readFileSync(path.join(sessionDir, "broker.pid"), "utf8").trim(), String(first.child.pid));
  assert.equal(await waitForBrokerEndpoint(first.endpoint, 2000), true);
  assert.equal(await shutdownBroker(first.endpoint), "accepted");
  await first.exited;
  assert.equal(fs.existsSync(sessionDir), false);
});

test("a broker does not remove a pid file another broker took over", POSIX, async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionDir = makeSessionDir(makeTempDir());
  const { child, endpoint, exited } = startBroker(t, { binDir, sessionDir });
  assert.equal(await waitForBrokerEndpoint(endpoint, 10000), true);
  fs.writeFileSync(path.join(sessionDir, "broker.pid"), `${process.pid}\n`);

  child.kill("SIGTERM");
  await exited;
  assert.ok(fs.existsSync(path.join(sessionDir, "broker.pid")));
});

test("removeBrokerSessionDir only works on a direct child of the root", POSIX, () => {
  const root = makeTempDir();
  const outside = makeTempDir();
  const inside = makeSessionDir(root);
  const nested = fs.mkdtempSync(path.join(fs.mkdtempSync(path.join(outside, "sub-")), "cxc-"));
  assert.equal(removeBrokerSessionDir(nested, { root: outside }), false);
  assert.equal(removeBrokerSessionDir(nested, { root }), false);
  assert.ok(fs.existsSync(nested));
  assert.equal(removeBrokerSessionDir(inside, { root }), true);
  assert.equal(fs.existsSync(inside), false);
});

test("removeBrokerSessionDir refuses symlinks, files and other names", POSIX, () => {
  const base = makeTempDir();
  const target = makeTempDir();
  fs.writeFileSync(path.join(target, "keep"), "x");
  const link = path.join(base, "cxc-LinkLn");
  fs.symlinkSync(target, link);
  assert.equal(removeBrokerSessionDir(link), false);
  assert.ok(fs.existsSync(path.join(target, "keep")));

  const file = path.join(base, "cxc-FileFl");
  fs.writeFileSync(file, "x");
  assert.equal(removeBrokerSessionDir(file), false);
  assert.ok(fs.existsSync(file));

  const other = path.join(base, "project-data");
  fs.mkdirSync(other);
  assert.equal(removeBrokerSessionDir(other), false);
  assert.ok(fs.existsSync(other));
});

test("removeBrokerSessionDir with keepLog leaves only broker.log", () => {
  const root = makeTempDir();
  const dir = makeSessionDir(root);
  fs.writeFileSync(path.join(dir, "broker.pid"), "1\n");
  fs.writeFileSync(path.join(dir, "broker.log"), "why it died\n");
  assert.equal(removeBrokerSessionDir(dir, { keepLog: true, root }), true);
  assert.deepEqual(fs.readdirSync(dir), ["broker.log"]);

  const bare = makeSessionDir(root);
  fs.writeFileSync(path.join(bare, "broker.pid"), "1\n");
  removeBrokerSessionDir(bare, { keepLog: true, root });
  assert.equal(fs.existsSync(bare), false);
});

test("a broker that exits with an error keeps its log but nothing else, and the sweep then clears it", POSIX, async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const base = makeTempDir();
  const sessionDir = makeSessionDir(base);
  const logFd = fs.openSync(path.join(sessionDir, "broker.log"), "a");
  const endpoint = createBrokerEndpoint(sessionDir);
  // Starting on a --cwd that does not exist makes the app-server child fail, so the broker exits non-zero.
  const child = spawn(
    process.execPath,
    [BROKER, "serve", "--endpoint", endpoint, "--cwd", path.join(base, "missing"), "--pid-file", path.join(sessionDir, "broker.pid")],
    { env: { ...buildEnv(binDir), CODEX_COMPANION_BROKER_TMPDIR: base }, stdio: ["ignore", logFd, logFd] }
  );
  t.after(() => child.kill());
  const { code } = await new Promise((resolve) => child.once("exit", (c) => resolve({ code: c })));
  fs.closeSync(logFd);
  assert.notEqual(code, 0);
  assert.deepEqual(fs.readdirSync(sessionDir), ["broker.log"]);
  assert.notEqual(fs.readFileSync(path.join(sessionDir, "broker.log"), "utf8"), "");

  age(sessionDir);
  await sweepOrphanedBrokerSessionDirs({ tmpdir: base });
  assert.equal(fs.existsSync(sessionDir), false);
});

test("sweep removes a dead, old directory", async () => {
  const base = makeTempDir();
  const dir = makeSessionDir(base);
  fs.writeFileSync(path.join(dir, "broker.pid"), `${await deadPid()}\n`);
  fs.writeFileSync(path.join(dir, "broker.log"), "boom\n");
  age(dir);

  const result = await sweepOrphanedBrokerSessionDirs({ tmpdir: base });
  assert.deepEqual(result.removed, [dir]);
  assert.equal(fs.existsSync(dir), false);
});

test("sweep removes an old directory without a pid file when nothing answers", async () => {
  const base = makeTempDir();
  const dir = makeSessionDir(base);
  fs.writeFileSync(path.join(dir, "broker.log"), "x");
  age(dir);
  await sweepOrphanedBrokerSessionDirs({ tmpdir: base });
  assert.equal(fs.existsSync(dir), false);
});

test("sweep keeps a directory whose broker answers on its socket, even with a dead pid file and old mtime", POSIX, async (t) => {
  const base = makeTempDir();
  const dir = makeSessionDir(base);
  fs.writeFileSync(path.join(dir, "broker.pid"), `${await deadPid()}\n`);
  await listenOn(dir, t);
  age(dir);

  const result = await sweepOrphanedBrokerSessionDirs({ tmpdir: base });
  assert.deepEqual(result.removed, []);
  assert.ok(fs.existsSync(dir));
});

test("sweep keeps a directory whose pid is alive, even without a reachable socket", async () => {
  const base = makeTempDir();
  const dir = makeSessionDir(base);
  fs.writeFileSync(path.join(dir, "broker.pid"), `${process.pid}\n`);
  age(dir);
  await sweepOrphanedBrokerSessionDirs({ tmpdir: base });
  assert.ok(fs.existsSync(dir));
});

test("sweep keeps a directory younger than the threshold even when its broker looks dead", async () => {
  const base = makeTempDir();
  const dir = makeSessionDir(base);
  fs.writeFileSync(path.join(dir, "broker.pid"), `${await deadPid()}\n`);
  await sweepOrphanedBrokerSessionDirs({ tmpdir: base });
  assert.ok(fs.existsSync(dir));
});

test("sweep never follows a symlink and ignores names that do not match", POSIX, async () => {
  const base = makeTempDir();
  const target = makeTempDir();
  fs.writeFileSync(path.join(target, "keep"), "x");
  const link = path.join(base, "cxc-LinkLn");
  fs.symlinkSync(target, link);
  const lookalike = path.join(base, "cxc-notaname-at-all");
  fs.mkdirSync(lookalike);
  age(target);
  age(lookalike);

  await sweepOrphanedBrokerSessionDirs({ tmpdir: base });
  assert.ok(fs.existsSync(path.join(target, "keep")));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(lookalike));
});

test("sweep leaves a directory owned by another uid alone", async () => {
  const base = makeTempDir();
  const dir = makeSessionDir(base);
  age(dir);
  const owner = fs.lstatSync(dir).uid;
  await sweepOrphanedBrokerSessionDirs({ tmpdir: base, uid: owner + 1 });
  assert.ok(fs.existsSync(dir));
});

test("sweep probes the Windows pipe endpoint derived from the directory name", POSIX, async () => {
  // A named pipe path does not exist on POSIX, so the probe reports it unreachable; this checks
  // the win32 branch (no broker.sock lookup, no throw) rather than a real pipe.
  const base = makeTempDir();
  const dir = makeSessionDir(base);
  fs.writeFileSync(path.join(dir, "broker.pid"), `${await deadPid()}\n`);
  age(dir);
  const result = await sweepOrphanedBrokerSessionDirs({ tmpdir: base, platform: "win32" });
  assert.deepEqual(result.removed, [dir]);
});

test("a missing temp directory is not an error", async () => {
  const result = await sweepOrphanedBrokerSessionDirs({ tmpdir: path.join(makeTempDir(), "nope") });
  assert.deepEqual(result, { removed: [], kept: 0 });
});

test("ensureBrokerSession sweeps dead directories before starting and its broker cleans up after itself", POSIX, async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const base = makeTempDir();
  const dead = makeSessionDir(base);
  fs.writeFileSync(path.join(dead, "broker.pid"), `${await deadPid()}\n`);
  age(dead);
  const live = makeSessionDir(base);
  await listenOn(live, t);
  age(live);

  const session = await ensureBrokerSession(makeTempDir(), { env: buildEnv(binDir), sweep: { tmpdir: base } });
  assert.ok(session);
  t.after(() => sendBrokerShutdown(session.endpoint));
  assert.equal(fs.existsSync(dead), false);
  assert.ok(fs.existsSync(live));

  const outcome = await shutdownBroker(session.endpoint);
  assert.equal(outcome, "accepted");
  for (let i = 0; i < 100 && fs.existsSync(session.sessionDir); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.existsSync(session.sessionDir), false);
});
