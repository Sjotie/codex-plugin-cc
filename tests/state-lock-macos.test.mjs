// Native macOS checks. M2's Claude hook/Bash routes are a separate live probe;
// the second test here proves only the ordinary-shell part of that scenario.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OLD_PROTOCOLS } from "./fenced-lock/old-trees.mjs";
import { matchPluginArgv } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// A mutation run supplies its own module; normal runs use the release candidate.
const LIB = process.env.FENCED_LOCK_MACOS_LIB ?? path.join(ROOT, "plugins/codex/scripts/lib");
const { drainCheck, openFencedLock } = await import(pathToFileURL(path.join(LIB, "fenced-lock.mjs")));
const native = { skip: process.platform !== "darwin" && "native macOS only", timeout: 30_000 };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fenced-lock-macos-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function waitFile(file) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `no fixture readiness: ${path.basename(file)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function child(t, script, args, env = {}) {
  const proc = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  proc.stderr.on("data", (c) => { stderr += c; });
  const exit = new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await exit;
  });
  return { proc, exit };
}

test("M1: lsof proves the loaded protocol before and after its marker is unlinked", native, async (t) => {
  const root = fixture(t);
  const lib = path.join(root, "lib");
  fs.mkdirSync(lib);
  for (const file of ["fenced-lock.mjs", "fenced-lock.protocol-1"]) fs.copyFileSync(path.join(LIB, file), path.join(lib, file));
  const script = path.join(root, "scripts", "codex-companion.mjs");
  fs.mkdirSync(path.dirname(script));
  const ready = path.join(root, "ready");
  fs.writeFileSync(script, `import fs from 'node:fs'; await import('../lib/fenced-lock.mjs'); fs.writeFileSync(process.argv[2], ''); setInterval(() => {}, 1000);`);
  const { proc } = child(t, script, [ready]);
  await waitFile(ready);
  const scan = () => drainCheck({ argvMatch: matchPluginArgv }).processes.find((p) => p.pid === proc.pid);
  assert.equal(scan()?.verdict, "new", "live marker");
  fs.unlinkSync(path.join(lib, "fenced-lock.protocol-1"));
  assert.equal(scan()?.verdict, "new", "unlinked but still open marker");
});

test("M2 shell precondition: the real O2 writer remains in S0 after losing its lock path", native, async (t) => {
  const root = fixture(t);
  const old = path.join(root, "old");
  fs.mkdirSync(old);
  const tar = execFileSync("git", ["archive", OLD_PROTOCOLS.o2.ref, "plugins/codex"], { cwd: ROOT });
  execFileSync("tar", ["-x", "-C", old], { input: tar });
  const state = path.join(old, "plugins/codex/scripts/lib/state.mjs");
  assert.equal(createHash("sha256").update(fs.readFileSync(state)).digest("hex"), OLD_PROTOCOLS.o2.stateSha256);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const script = path.join(root, "scripts", "codex-companion.mjs");
  fs.mkdirSync(path.dirname(script));
  const ready = path.join(root, "ready");
  fs.writeFileSync(script, `import fs from 'node:fs'; const m = await import(${JSON.stringify(pathToFileURL(state).href)}); m.updateState(process.argv[2], s => { fs.writeFileSync(process.argv[3], m.resolveStateDir(process.argv[2])); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); return s; });`);
  const { proc, exit } = child(t, script, [workspace, ready], { CLAUDE_PLUGIN_DATA: path.join(root, "data") });
  await waitFile(ready);
  const fence = path.join(fs.readFileSync(ready, "utf8"), "state.lock");
  fs.unlinkSync(fence);
  // Restrict the match to our writer, while retaining the real ps/lsof reader.
  // Unknown argv still follows the module's conservative rule.
  const lock = openFencedLock(fence, { argvMatch: (a) => a.includes(script) ? matchPluginArgv(a) : null });
  assert.equal(lock.tryAcquire(), null);
  const record = () => JSON.parse(fs.readFileSync(path.join(fence, "fence.json"), "utf8"));
  assert.ok(record().S0.some((p) => p.pid === proc.pid && p.start), "the live O2 writer must be recorded");
  assert.equal(record().sealedAt, null);
  assert.equal(lock.seal({ domainDeclaration: "test fixture: only this test writer can access this temporary state" }).result, "waiting");
  proc.kill("SIGKILL");
  await exit;
  assert.equal(lock.seal().result, "sealed");
  const handle = lock.tryAcquire();
  assert.ok(handle, "after the old writer exits the new writer enters");
  lock.release(handle);
});
