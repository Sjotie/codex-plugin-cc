// The fence and the kernel lock of the new state lock (#1916, design §11:
// N2–N9, N12–N19, N25, N26), with real old writers (O1 c5fc9a5, O2 81333c0)
// and real new processes. New code only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { probeKernelLock, scenario } from "./fenced-lock/scenario.mjs";
import { loadState, openStateLock, resolveStateDir, resolveStateFile } from "../plugins/codex/scripts/lib/state.mjs";

const NODE20 = path.join(os.homedir(), ".local/share/mise/installs/node/20.20.2/bin/node");
const NODE22 = path.join(os.homedir(), ".local/share/mise/installs/node/22.23.3/bin/node");

function paths(s) {
  process.env.CLAUDE_PLUGIN_DATA = s.pluginData;
  const stateDir = resolveStateDir(s.workspace);
  return { stateDir, fence: path.join(stateDir, "state.lock"), db: path.join(stateDir, "state.lock.db") };
}

async function quickNew(s, role) {
  const w = s.start(role, { impl: "new", mode: "quick" });
  const r = await w.exit;
  assert.equal(r.code, 0, `${role}: ${r.stderr}${s.errors().join("\n")}`);
}

function jobs(s) {
  process.env.CLAUDE_PLUGIN_DATA = s.pluginData;
  return loadState(s.workspace)
    .jobs.map((job) => job.id)
    .sort();
}

test("N3: a stopped owner makes a waiter time out with its pid; nothing is removed", async (t) => {
  const s = scenario(t);
  const { fence, db } = paths(s);
  const h = s.actor("h", { op: "hold" });
  await s.wait("h.held");
  process.kill(h.pid, "SIGSTOP");
  t.after(() => {
    try {
      process.kill(h.pid, "SIGCONT");
    } catch {
      // already gone
    }
  });
  const lock = openStateLock(s.workspace);
  assert.throws(() => lock.acquire({ deadlineMs: 400 }), (error) => {
    assert.equal(error.code, "ESTATELOCKTIMEOUT");
    assert.match(error.message, new RegExp(`pid ${h.pid}`));
    return true;
  });
  assert.equal(fs.lstatSync(fence).isDirectory(), true);
  assert.equal(fs.existsSync(db), true);
  process.kill(h.pid, "SIGCONT");
  s.signal("h.release");
  assert.equal((await h.exit).code, 0);
});

test("N4: diagnosis in the holding process keeps the kernel lock (an external process stays BUSY)", async (t) => {
  const s = scenario(t);
  const { db } = paths(s);
  const h = s.actor("h", { op: "hold", diagnose: true });
  await s.wait("h.held");
  assert.equal(probeKernelLock(db), "held");
  s.signal("h.release");
  assert.equal((await h.exit).code, 0);
  assert.equal(probeKernelLock(db), "free");
});

test("N4-neg: a holder that opens and closes state.lock.db with fs loses the kernel lock (P5)", async (t) => {
  const s = scenario(t);
  const { db } = paths(s);
  const h = s.actor("h", { op: "hold", violateP5: true });
  await s.wait("h.held");
  assert.equal(probeKernelLock(db), "free", "only an external process can see that the lock is gone");
  s.signal("h.release");
  await h.exit;
});

test("N5: two new writers on an empty path make one fence and never overlap", async (t) => {
  const s = scenario(t);
  const { stateDir, fence } = paths(s);
  const a = s.start("a", { gates: { publication: "pause" } });
  await s.wait("a.paused.publication");
  const b = s.start("b");
  assert.equal(await s.wait(["b.contended", "b.entered"]), "b.contended");
  s.signal("a.resume.publication");
  await s.wait("a.entered");
  s.signal("a.release");
  await s.wait("b.entered");
  s.signal("b.release");
  assert.equal((await a.exit).code, 0);
  assert.equal((await b.exit).code, 0);
  assert.equal(s.has("a.overlap") || s.has("b.overlap"), false);
  assert.equal(fs.lstatSync(fence).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(stateDir).filter((n) => n.startsWith("state.lock.prep-")), []);
});

for (const impl of ["o1", "o2"]) {
  test(`N6 (${impl}): a new writer waits for an old owner in its section, then fences; no overlap`, async (t) => {
    const s = scenario(t);
    const { fence } = paths(s);
    const old = s.start("old", { impl });
    s.expose(old.pid);
    await s.wait("old.entered");
    const w = s.start("w");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.has("w.entered"), false, "the new writer must wait for the old owner");
    s.signal("old.release");
    assert.equal((await old.exit).code, 0);
    await s.wait("w.entered");
    s.signal("w.release");
    assert.equal((await w.exit).code, 0, s.errors().join("\n"));
    assert.equal(s.has("w.overlap") || s.has("old.overlap"), false);
    assert.equal(fs.lstatSync(fence).isDirectory(), true);
    assert.deepEqual(jobs(s), ["old", "w"]);
  });

  test(`N7 (${impl}): an old writer against the fence fails closed and leaves nothing behind`, async (t) => {
    const s = scenario(t);
    const { stateDir } = paths(s);
    await quickNew(s, "first");
    const before = fs.readFileSync(resolveStateFile(s.workspace), "utf8");
    const old = s.start("old", { impl, mode: "quick" });
    const r = await old.exit;
    assert.equal(r.code, 1, "the old writer must fail");
    assert.match(fs.readFileSync(path.join(s.barriers, "old.error"), "utf8"), /Timed out waiting for state lock/);
    assert.equal(s.has("old.entered"), false);
    assert.equal(fs.readFileSync(resolveStateFile(s.workspace), "utf8"), before, "new data intact");
    assert.deepEqual(fs.readdirSync(stateDir).filter((n) => /^state\.lock\.\d+$/.test(n)), [], "no pending file left");
  });

  test(`N8 (${impl}): an old reaper paused before unlinking a dead lock never lets a new writer overlap`, async (t) => {
    const s = scenario(t);
    const dead = s.start("dead", { impl, mode: "crash" });
    assert.equal((await dead.exit).code, 0);
    const reaper = s.start("reaper", { impl, gates: { "stale-unlink": "pause" } });
    s.expose(reaper.pid);
    await s.wait("reaper.paused.stale-unlink");
    const w = s.start("w");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.has("w.entered"), false);
    s.signal("reaper.resume.stale-unlink");
    await s.wait("reaper.entered");
    s.signal("reaper.release");
    assert.equal((await reaper.exit).code, 0);
    await s.wait("w.entered");
    s.signal("w.release");
    assert.equal((await w.exit).code, 0, s.errors().join("\n"));
    assert.equal(s.has("w.overlap") || s.has("reaper.overlap"), false);
  });

  test(`N9 (${impl}): an old owner whose lock was taken away releases against the fence; fence and new owner stay`, async (t) => {
    const s = scenario(t);
    const { fence } = paths(s);
    const old = s.start("old", { impl });
    s.expose(old.pid);
    await s.wait("old.entered");
    fs.renameSync(fence, `${fence}.taken-away`); // its lock disappears (outside the protocol)
    const w = s.start("w");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(fs.lstatSync(fence).isDirectory(), true, "the new writer published a fence");
    assert.equal(s.has("w.entered"), false, "but waits for the seal while the old owner lives");
    s.signal("old.release");
    assert.equal((await old.exit).code, 0);
    assert.equal(fs.lstatSync(fence).isDirectory(), true, "the old release did not remove the fence");
    await s.wait("w.entered");
    s.signal("w.release");
    assert.equal((await w.exit).code, 0, s.errors().join("\n"));
    assert.equal(s.has("w.overlap") || s.has("old.overlap"), false);
  });
}

test("N12: unfence while a new writer waits: no overlap, the writer finishes", async (t) => {
  const s = scenario(t);
  const h = s.actor("h", { op: "hold" });
  await s.wait("h.held");
  const w = s.start("w", { mode: "quick" });
  const u = s.actor("u", { op: "unfence" });
  await s.wait(["w.contended"]);
  s.signal("h.release");
  assert.equal((await h.exit).code, 0);
  assert.equal((await u.exit).code, 0, s.errors().join("\n"));
  assert.equal((await w.exit).code, 0, s.errors().join("\n"));
  assert.equal(s.result("u").result, "unfenced");
  assert.equal(s.has("w.overlap"), false);
});

test("N13: unfence while the lock is held waits and never renames under a holder", async (t) => {
  const s = scenario(t);
  const { fence } = paths(s);
  const h = s.actor("h", { op: "hold" });
  await s.wait("h.held");
  const before = fs.lstatSync(fence).ino;
  const u = s.actor("u", { op: "unfence", args: { deadlineMs: 300 } });
  assert.equal((await u.exit).code, 0);
  assert.equal(s.result("u").result, "busy");
  assert.equal(fs.lstatSync(fence).ino, before);
  s.signal("h.release");
  await h.exit;
});

for (const [id, what] of [
  ["N14", "fence"],
  ["N14b", "db"]
]) {
  test(`${id}: ${what === "fence" ? "rm -rf state.lock" : "mv state.lock.db"} inside the section gives ESTATELOCKLOST before the rename`, async (t) => {
    const s = scenario(t);
    const p = paths(s);
    await quickNew(s, "first");
    const before = fs.readFileSync(resolveStateFile(s.workspace), "utf8");
    const w = s.start("w", { mode: "quick", gates: { "in-section": "pause" } });
    await s.wait("w.paused.in-section");
    if (what === "fence") fs.rmSync(p.fence, { recursive: true, force: true });
    else fs.renameSync(p.db, `${p.db}.moved-by-hand`);
    s.signal("w.resume.in-section");
    assert.equal((await w.exit).code, 1);
    assert.match(fs.readFileSync(path.join(s.barriers, "w.error"), "utf8"), /ESTATELOCKLOST/);
    assert.equal(fs.readFileSync(resolveStateFile(s.workspace), "utf8"), before);
  });
}

test("N15: a crash in publishFence leaves only a prep directory; the next writer fences", async (t) => {
  const s = scenario(t);
  const { stateDir, fence } = paths(s);
  const a = s.start("a", { mode: "quick", gates: { publication: "kill" } });
  assert.equal((await a.exit).signal, "SIGKILL");
  assert.deepEqual(
    fs
      .readdirSync(stateDir)
      .filter((n) => n.startsWith("state.lock") && n !== "state.lock.db-journal") // SQLite's own journal, rolled back on the next open (§8)
      .map((n) => n.replace(/prep-.*/, "prep-*"))
      .sort(),
    ["state.lock.db", "state.lock.prep-*"]
  );
  await quickNew(s, "b");
  assert.equal(fs.lstatSync(fence).isDirectory(), true);
});

test("N16: waiting on a live old lock polls gently and never holds A while sleeping", async (t) => {
  const s = scenario(t);
  const { db } = paths(s);
  const old = s.start("old", { impl: "o2" });
  await s.wait("old.entered");
  const waiter = s.actor("waiter", { op: "acquire", deadlineMs: 2_000, countBegins: true });
  let freeSeen = false;
  const end = Date.now() + 1_500;
  while (Date.now() < end && !freeSeen) {
    freeSeen = probeKernelLock(db) === "free";
  }
  await waiter.exit;
  const r = s.result("waiter");
  assert.equal(r.acquired, false);
  assert.ok(r.begins <= 60, `at most ~25 attempts per second, saw ${r.begins} in 2 s`);
  assert.equal(freeSeen, true, "an external tryAcquire succeeds between two attempts");
  s.signal("old.release");
  await old.exit;
});

test("N17: on Node 20 the lock is unavailable with the version; nothing is written", { skip: !fs.existsSync(NODE20) && "no Node 20" }, async (t) => {
  const s = scenario(t);
  const { stateDir } = paths(s);
  const a = s.actor("a", { op: "write" }, [], { nodePath: NODE20 });
  assert.equal((await a.exit).code, 1);
  assert.match(fs.readFileSync(path.join(s.barriers, "a.error"), "utf8"), /needs Node >= 22\.13 for node:sqlite \(running v20/);
  assert.deepEqual(fs.readdirSync(stateDir).filter((n) => n !== "jobs"), []);
});

test("N18: on Node 22 no ExperimentalWarning reaches stderr", { skip: !fs.existsSync(NODE22) && "no Node 22" }, async (t) => {
  const s = scenario(t);
  const w = s.start("w", { mode: "quick", nodePath: NODE22 });
  const r = await w.exit;
  assert.equal(r.code, 0, r.stderr + s.errors().join("\n"));
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
});

test("N19: a holder that starts a detached child and exits frees the lock", async (t) => {
  const s = scenario(t);
  const { db } = paths(s);
  const h = s.actor("h", { op: "hold", detachChild: true, exitHolding: true });
  assert.equal((await h.exit).code, 0);
  const child = Number(fs.readFileSync(path.join(s.barriers, "h.child"), "utf8"));
  t.after(() => {
    try {
      process.kill(child, "SIGKILL");
    } catch {
      // gone
    }
  });
  assert.equal(probeKernelLock(db), "free");
});

test("N25: the module keeps a reference to a held connection, also through a forced GC", async (t) => {
  const s = scenario(t);
  const { db } = paths(s);
  const h = s.actor("h", { op: "gcHold" }, [], { execArgs: ["--expose-gc"] });
  await s.wait("h.held");
  assert.equal(fs.readFileSync(path.join(s.barriers, "h.held"), "utf8"), "function", "gc ran");
  assert.equal(probeKernelLock(db), "held");
  s.signal("h.release");
  await h.exit;
});

test("N26: SIGKILL during the first commit on a new state.lock.db never leaves it unusable", async (t) => {
  for (let i = 0; i < 4; i++) {
    const s = scenario(t);
    const gate = i % 2 === 0 ? { fn: "sql", match: "^COMMIT$", when: "before" } : { fn: "sql", match: "^BEGIN", when: "after" };
    const a = s.actor(`a${i}`, { op: "write" }, [{ ...gate, nth: 1, action: "kill", name: "commit" }]);
    assert.equal((await a.exit).signal, "SIGKILL");
    await quickNew(s, `b${i}`);
  }
  // and a kill at a random moment
  for (let i = 0; i < 4; i++) {
    const s = scenario(t);
    const a = s.actor(`r${i}`, { op: "write" });
    await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 80)));
    a.child.kill("SIGKILL");
    await a.exit;
    await quickNew(s, `c${i}`);
  }
});

test("N2: an owner in another PID namespace keeps the lock (Linux)", { skip: process.platform !== "linux" && "Linux only" }, async (t) => {
  const probe = spawnSync("unshare", ["-r", "-p", "-f", "true"]);
  if (probe.status !== 0) {
    t.skip("unshare -r -p -f not available");
    return;
  }
  const s = scenario(t);
  const { db } = paths(s);
  await quickNew(s, "first"); // the fence and its seal come from the init namespace
  const actorPath = new URL("./fenced-lock/lock-actor.mjs", import.meta.url).pathname;
  const env = s.childEnv({
    ACTOR_WORKSPACE: s.workspace,
    ACTOR_BARRIERS: s.barriers,
    ACTOR_ROLE: "h",
    ACTOR_OP: JSON.stringify({ op: "hold" })
  });
  const child = spawn("unshare", ["-r", "-p", "-f", process.execPath, actorPath], { env, stdio: "ignore" });
  const exit = new Promise((r) => child.once("exit", r));
  try {
    await s.wait("h.held");
    assert.equal(probeKernelLock(db), "held");
    const lock = openStateLock(s.workspace);
    assert.throws(() => lock.acquire({ deadlineMs: 300 }), { code: "ESTATELOCKTIMEOUT" });
  } finally {
    s.signal("h.release");
    await exit;
  }
});
