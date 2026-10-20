// The seal of the fence (I6) and the guided recovery (#1916, design §11:
// N10, N10b, N11, N20, N24, N27–N31, N32a–c). Real old writers (O1, O2), real
// new processes, and an external oracle over every section, old and new.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { probeKernelLock, scenario } from "./fenced-lock/scenario.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const COMBOS = [
  ["o1", "o1"],
  ["o1", "o2"],
  ["o2", "o1"],
  ["o2", "o2"]
];

function paths(s) {
  process.env.CLAUDE_PLUGIN_DATA = s.pluginData;
  const stateDir = resolveStateDir(s.workspace);
  return { stateDir, fence: path.join(stateDir, "state.lock"), db: path.join(stateDir, "state.lock.db") };
}

function record(s) {
  try {
    return JSON.parse(fs.readFileSync(path.join(paths(s).fence, "fence.json"), "utf8"));
  } catch {
    return null;
  }
}

// An idle process that looks like an old plugin process: argv names a plugin
// script, and it never loads the new module (no protocol marker).
function idleOld(s, t, { script = "codex-companion.mjs", sub = "task-worker", body = "sleep 60; :" } = {}) {
  const child = spawn("sh", ["-c", body, `/plugin/scripts/${script}`, sub], { stdio: "ignore" });
  s.expose(child.pid);
  const exit = new Promise((r) => child.once("exit", (code, sig) => r({ code, signal: sig })));
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await exit;
  });
  return { child, pid: child.pid, exit };
}

// Old writers in this file are exposed to the scans of new processes.
function old(s, role, impl, opts = {}) {
  const w = s.start(role, { impl, ...opts });
  s.expose(w.pid);
  return w;
}

async function acquireOnce(s, role, deadlineMs = 400) {
  const a = s.actor(role, { op: "acquire", deadlineMs });
  await a.exit;
  return s.result(role);
}

function noOverlap(s, roles) {
  for (const role of roles) assert.equal(s.has(`${role}.overlap`), false, `${role} overlapped another section`);
  // The oracle log: no "enter" of one role between "enter" and "exit" of another.
  const log = fs.existsSync(path.join(s.barriers, "oracle.log")) ? fs.readFileSync(path.join(s.barriers, "oracle.log"), "utf8") : "";
  const open = new Set();
  for (const line of log.split("\n").filter(Boolean)) {
    const [what, role] = line.split(" ");
    if (what === "enter") {
      assert.equal(open.size, 0, `section of ${role} began while ${[...open].join(", ")} was inside: ${log}`);
      open.add(role);
    } else {
      open.delete(role);
    }
  }
}

async function legacyX(s, impl = "o1") {
  const dead = s.start("dead", { impl, mode: "crash" });
  assert.equal((await dead.exit).code, 0);
}

async function statusOf(s, role = "st") {
  const a = s.actor(role, { op: "status" });
  await a.exit;
  return s.result(role);
}

async function adopt(s, role, gates = [], extra = {}) {
  const st = await statusOf(s, `${role}-status`);
  assert.equal(st.kind, "file", "precondition: an old lock file on state.lock");
  const args = { expectDev: st.legacy.dev, expectIno: st.legacy.ino, expectSha: st.legacy.sha256, ...extra };
  return s.actor(role, { op: "adopt", args }, gates);
}

// ---------------------------------------------------------------------------
// N27: the seal itself
// ---------------------------------------------------------------------------

test("N27a: with no old process the seal comes in the same holding as the fence", async (t) => {
  const s = scenario(t);
  const r = await acquireOnce(s, "w");
  assert.equal(r.acquired, true);
  const rec = record(s);
  assert.deepEqual(rec.residues, []);
  assert.deepEqual(rec.S0, []);
  assert.equal(typeof rec.sealedAt, "string");
  assert.equal(rec.verdict, "initial");
});

test("N27b: an old process from before the fence holds the seal; the timeout names it; the record keeps no argv", async (t) => {
  const s = scenario(t);
  const o = idleOld(s, t, { sub: "task --json secret prompt text" });
  const r = await acquireOnce(s, "w");
  assert.equal(r.acquired, false);
  assert.match(r.message, new RegExp(`pid ${o.pid} \\(codex-companion\\.mjs task --json secret prompt text`));
  assert.match(r.message, /state-lock stop-old/);
  const rec = record(s);
  assert.equal(rec.S0.length, 1);
  assert.deepEqual(Object.keys(rec.S0[0]).sort(), ["comm", "pid", "reason", "script", "start", "sub", "uid"]);
  assert.doesNotMatch(JSON.stringify(rec), /sleep 60/, "only script and the first argument, not the whole argv");
  o.child.kill("SIGKILL");
  await o.exit;
  assert.equal((await acquireOnce(s, "w2")).acquired, true);
});

test("N27c: a recorded process that became a zombie counts as gone", async (t) => {
  const s = scenario(t);
  // sh forks the old-looking child and then becomes sleep, which never reaps it.
  const parent = spawn("sh", ["-c", `sh -c 'sleep 2; :' /plugin/scripts/codex-companion.mjs task-worker & echo $!; exec sleep 30`], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  t.after(() => parent.kill("SIGKILL"));
  const pid = Number((await new Promise((r) => parent.stdout.once("data", r))).toString().trim());
  s.expose(pid);
  assert.equal((await acquireOnce(s, "w1")).acquired, false, "alive: the seal waits");
  await new Promise((r) => setTimeout(r, 2_300));
  const state = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0];
  assert.equal(state, "Z", "precondition: the child is a zombie");
  assert.equal((await acquireOnce(s, "w2")).acquired, true);
});

test("N27e: a crash after rename(P→F) and before the record: the next acquire scans, the lost old writer is in S0", async (t) => {
  const s = scenario(t);
  const { fence } = paths(s);
  const o = old(s, "o", "o1");
  await s.wait("o.entered");
  fs.unlinkSync(fence); // o loses its file while in its section (as in R-e)
  const w1 = s.actor("w1", { op: "write" }, [{ fn: "renameSync", match: "state\\.lock$", when: "after", nth: 1, action: "kill", name: "fence" }]);
  assert.equal((await w1.exit).signal, "SIGKILL");
  assert.equal(record(s), null, "precondition: a fence without a record");
  const r = await acquireOnce(s, "w2");
  assert.equal(r.acquired, false);
  assert.ok(record(s).S0.some((p) => p.pid === o.pid), "the scan after the crash records the old writer");
  const w3 = s.start("w3");
  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal(s.has("w3.entered"), false);
  s.signal("o.release");
  await o.exit;
  await s.wait("w3.entered");
  s.signal("w3.release");
  assert.equal((await w3.exit).code, 0, s.errors().join("\n"));
  noOverlap(s, ["o", "w3"]);
});

test("N27g: a crash while writing the record or the seal never leaves half a record", async (t) => {
  for (const nth of [1, 2]) {
    const s = scenario(t);
    const w = s.actor(`w${nth}`, { op: "write" }, [
      { fn: "renameSync", match: "fence\\.json$", when: "before", nth, action: "kill", name: "record" }
    ]);
    assert.equal((await w.exit).signal, "SIGKILL");
    const raw = fs.existsSync(path.join(paths(s).fence, "fence.json")) ? fs.readFileSync(path.join(paths(s).fence, "fence.json"), "utf8") : null;
    if (raw !== null) assert.doesNotThrow(() => JSON.parse(raw));
    assert.equal((await acquireOnce(s, `x${nth}`)).acquired, true);
  }
});

// ---------------------------------------------------------------------------
// N20: R-e, closed by the seal
// ---------------------------------------------------------------------------

for (const [impl] of [["o1"], ["o2"]]) {
  test(`N20 (${impl}): an old writer that lost its file in an old-old race when the first fence appears holds the seal`, async (t) => {
    const s = scenario(t);
    await legacyX(s, impl);
    const r = old(s, "r", impl, { gates: { "stale-unlink": "pause" } });
    await s.wait("r.paused.stale-unlink");
    const o = old(s, "o", impl);
    await s.wait("o.entered"); // o reaped the dead lock and holds its own
    s.signal("r.resume.stale-unlink"); // r deletes o's lock and enters too (old-old, today's bug)
    await s.wait("r.entered");
    s.signal("r.release");
    await r.exit; // r releases: F is empty while o is still in its section
    const w = s.start("w");
    await new Promise((r2) => setTimeout(r2, 400));
    assert.equal(s.has("w.entered"), false, "the new writer waits for the seal");
    assert.ok(record(s)?.S0.some((p) => p.pid === o.pid), "o is in S0");
    s.signal("o.release");
    await o.exit;
    await s.wait("w.entered");
    s.signal("w.release");
    assert.equal((await w.exit).code, 0, s.errors().join("\n"));
    assert.equal(s.has("w.overlap"), false);
  });
}

// ---------------------------------------------------------------------------
// N10, N10b, N11, N24: adopt-legacy
// ---------------------------------------------------------------------------

test("N10: adopt-legacy refuses on wrong values or an undrained machine, and adopts with the right ones", async (t) => {
  const s = scenario(t);
  const { stateDir, fence } = paths(s);
  await legacyX(s);
  const st = await statusOf(s);
  for (const [field, value] of [
    ["expectDev", "1"],
    ["expectIno", "1"],
    ["expectSha", "0".repeat(64)]
  ]) {
    const a = s.actor(`bad-${field}`, { op: "adopt", args: { expectDev: st.legacy.dev, expectIno: st.legacy.ino, expectSha: st.legacy.sha256, [field]: value } });
    await a.exit;
    assert.equal(s.result(`bad-${field}`).code, "ADOPT_MISMATCH");
    assert.equal(fs.lstatSync(fence).isFile(), true, "nothing moved");
  }
  const idle = idleOld(s, t);
  const undrained = await adopt(s, "undrained");
  await undrained.exit;
  assert.equal(s.result("undrained").code, "ADOPT_NOT_DRAINED");
  idle.child.kill("SIGKILL");
  await idle.exit;
  const good = await adopt(s, "good");
  await good.exit;
  const r = s.result("good");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.match, true);
  assert.equal(r.log.state, "moved");
  assert.equal(r.seal.sealed, true, "sealed in the same holding (S0 empty)");
  assert.equal(fs.lstatSync(fence).isDirectory(), true);
  assert.equal(fs.readdirSync(stateDir).filter((n) => /^state\.lock\.quarantine-[^.]*$/.test(n)).length, 1);
});

test("N10b: with fd0 held from before the drain, a new empty file on state.lock is never taken for X", async (t) => {
  const s = scenario(t);
  const { fence } = paths(s);
  fs.mkdirSync(paths(s).stateDir, { recursive: true });
  fs.writeFileSync(fence, ""); // an empty old lock X
  const d = await adopt(s, "d", [{ fn: "lstatSync", match: "state\\.lock$", when: "before", nth: 2, action: "pause", name: "verify" }]);
  await s.wait("d.paused.verify");
  const o = old(s, "o", "o1", { gates: { publication: "pause" } }); // reaps the empty X, pauses before its pid write
  await s.wait("o.paused.publication");
  s.signal("d.resume.verify");
  await d.exit;
  assert.equal(s.result("d").code, "ADOPT_CHANGED");
  assert.equal(fs.lstatSync(fence).isFile(), true, "nothing moved");
  s.signal("o.resume.publication");
  await s.wait("o.entered");
  s.signal("o.release");
  await o.exit;
});

test("N11: adopt moves a live old writer that took state.lock in the window; it finishes behind the fence and holds the seal", async (t) => {
  const s = scenario(t);
  const { fence } = paths(s);
  await legacyX(s);
  const d = await adopt(s, "d", [{ fn: "renameSync", match: "quarantine-[^/.]*$", when: "before", nth: 1, action: "pause", name: "move" }]);
  await s.wait("d.paused.move");
  const y = old(s, "y", "o1"); // reaps the dead X and enters with its own file
  await s.wait("y.entered");
  s.signal("d.resume.move");
  await d.exit;
  const r = s.result("d");
  assert.equal(r.ok, false);
  assert.equal(r.match, false);
  assert.equal(r.code, "ADOPT_MOVED_OTHER_OBJECT");
  assert.ok(r.log.y, "the log names the moved object");
  assert.equal(fs.lstatSync(fence).isDirectory(), true, "the fence stands at once");
  const w = s.start("w");
  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal(s.has("w.entered"), false, "W waits for the seal while Y lives");
  s.signal("y.release");
  assert.equal((await y.exit).code, 0, "Y finishes; its release hits the fence and is ignored");
  await s.wait("w.entered");
  s.signal("w.release");
  assert.equal((await w.exit).code, 0, s.errors().join("\n"));
  noOverlap(s, ["y", "w"]);
});

test("N24a: two adopters serialize on A; the second sees the fence and refuses", async (t) => {
  const s = scenario(t);
  const { fence } = paths(s);
  await legacyX(s);
  const a = await adopt(s, "a", [{ fn: "lstatSync", match: "state\\.lock$", when: "before", nth: 2, action: "pause", name: "verify" }]);
  await s.wait("a.paused.verify");
  const b = await adopt(s, "b");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.has("b.done"), false, "B waits on A");
  s.signal("a.resume.verify");
  await a.exit;
  await b.exit;
  assert.equal(s.result("a").ok, true);
  assert.equal(s.result("b").code, "ADOPT_NOT_LEGACY");
  assert.equal(fs.lstatSync(fence).isDirectory(), true);
});

test("N24c: an adopter killed between its two renames: the next writer fences lazily and waits for the moved live writer", async (t) => {
  const s = scenario(t);
  const { fence } = paths(s);
  await legacyX(s);
  const d = await adopt(s, "d", [
    { fn: "renameSync", match: "quarantine-[^/.]*$", when: "before", nth: 1, action: "pause", name: "move" },
    { fn: "renameSync", match: "quarantine-[^/.]*$", when: "after", nth: 1, action: "kill", name: "between" }
  ]);
  await s.wait("d.paused.move");
  const y = old(s, "y", "o2");
  await s.wait("y.entered");
  s.signal("d.resume.move");
  assert.equal((await d.exit).signal, "SIGKILL");
  assert.equal(fs.existsSync(fence), false, "precondition: empty path, Y's file in Q");
  const w = s.start("w");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(s.has("w.entered"), false);
  assert.ok(record(s)?.S0.some((p) => p.pid === y.pid));
  s.signal("y.release");
  await y.exit;
  await s.wait("w.entered");
  s.signal("w.release");
  assert.equal((await w.exit).code, 0, s.errors().join("\n"));
  noOverlap(s, ["y", "w"]);
});

// ---------------------------------------------------------------------------
// N28, N29: the counterexamples of the v2.3 and v2.4 reviews
// ---------------------------------------------------------------------------

for (const [hImpl, zImpl] of COMBOS) {
  test(`N29a (H ${hImpl}, Z ${zImpl}): Z takes F between the renames, H's prepared unlink removes it, the fence lands: W waits for Z and H`, async (t) => {
    const s = scenario(t);
    await legacyX(s);
    const d = await adopt(s, "d", [
      { fn: "lstatSync", match: "state\\.lock$", when: "before", nth: 2, action: "pause", name: "verify" },
      { fn: "renameSync", match: "state\\.lock$", when: "before", nth: 1, action: "pause", name: "publish" }
    ]);
    await s.wait("d.paused.verify"); // the drain is done
    const h = old(s, "h", hImpl, { gates: { "stale-unlink": "pause", attempt: { action: "pause", nth: 2 } } });
    await s.wait("h.paused.stale-unlink"); // H judged X dead
    s.signal("d.resume.verify");
    await s.wait("d.paused.publish"); // F moved to Q, the fence not yet published
    const z = old(s, "z", zImpl);
    await s.wait("z.entered"); // Z took the empty F
    s.signal("h.resume.stale-unlink"); // H removes Z's file
    await s.wait("h.paused.attempt");
    s.signal("d.resume.publish"); // F is empty: the fence lands while Z is in its section without a file
    await d.exit;
    const rec = record(s);
    assert.ok(rec.S0.some((p) => p.pid === z.pid) && rec.S0.some((p) => p.pid === h.pid), "S0 holds Z and H");
    const w = s.start("w");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.has("w.entered"), false);
    s.signal("h.resume.attempt");
    await s.wait("h.fenced"); // H meets the fence
    h.child.kill("SIGKILL");
    await h.exit;
    s.signal("z.release");
    await z.exit;
    await s.wait("w.entered");
    s.signal("w.release");
    assert.equal((await w.exit).code, 0, s.errors().join("\n"));
    noOverlap(s, ["z", "w"]);
  });

  test(`N29b (H ${hImpl}, Z ${zImpl}): Z takes F, the fence is lost, H resumes after: W waits until every old section ends`, async (t) => {
    const s = scenario(t);
    await legacyX(s);
    const d = await adopt(s, "d", [
      { fn: "lstatSync", match: "state\\.lock$", when: "before", nth: 2, action: "pause", name: "verify" },
      { fn: "renameSync", match: "state\\.lock$", when: "before", nth: 1, action: "pause", name: "publish" }
    ]);
    await s.wait("d.paused.verify");
    const h = old(s, "h", hImpl, { gates: { "stale-unlink": "pause" } });
    await s.wait("h.paused.stale-unlink");
    s.signal("d.resume.verify");
    await s.wait("d.paused.publish");
    const z = old(s, "z", zImpl);
    await s.wait("z.entered");
    s.signal("d.resume.publish"); // ENOTDIR: the fence is lost to Z
    await d.exit;
    assert.equal(s.result("d").fence, "lost");
    s.signal("h.resume.stale-unlink"); // H removes Z's file and enters (old-old, R-o)
    await s.wait(["h.entered", "h.contended"]);
    const w = s.start("w");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.has("w.entered"), false);
    if (s.has("h.entered")) {
      s.signal("h.release");
      await h.exit;
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.has("w.entered"), false, "Z is still in its section");
    s.signal("z.release");
    await z.exit;
    await s.wait("w.entered");
    s.signal("w.release");
    assert.equal((await w.exit).code, 0, s.errors().join("\n"));
    assert.equal(s.has("w.overlap"), false);
  });

  test(`N29c (H ${hImpl}, Z ${zImpl}): H resumes after the publication without Z: its unlink hits the fence, W waits for H`, async (t) => {
    const s = scenario(t);
    await legacyX(s);
    const d = await adopt(s, "d", [{ fn: "lstatSync", match: "state\\.lock$", when: "before", nth: 2, action: "pause", name: "verify" }]);
    await s.wait("d.paused.verify");
    const h = old(s, "h", hImpl, { gates: { "stale-unlink": "pause" } });
    await s.wait("h.paused.stale-unlink");
    s.signal("d.resume.verify");
    await d.exit;
    assert.ok(record(s).S0.some((p) => p.pid === h.pid));
    s.signal("h.resume.stale-unlink");
    await s.wait("h.fenced");
    assert.equal(fs.lstatSync(paths(s).fence).isDirectory(), true, "the unlink hit the fence");
    const r = await acquireOnce(s, "w1");
    assert.equal(r.acquired, false, "W waits while H lives");
    h.child.kill("SIGKILL");
    await h.exit;
    assert.equal((await acquireOnce(s, "w2")).acquired, true);
  });
}

for (const variant of ["lost", "killed"]) {
  test(`N28 (${variant}): the Y/Z/H cascade of the v2.3 review never puts W next to an old section`, async (t) => {
    const s = scenario(t);
    await legacyX(s);
    const gates = [{ fn: "renameSync", match: "quarantine-[^/.]*$", when: "before", nth: 1, action: "pause", name: "move" }];
    gates.push(
      variant === "killed"
        ? { fn: "renameSync", match: "quarantine-[^/.]*$", when: "after", nth: 1, action: "kill", name: "between" }
        : { fn: "renameSync", match: "state\\.lock$", when: "before", nth: 1, action: "pause", name: "publish" }
    );
    const d = await adopt(s, "d", gates);
    await s.wait("d.paused.move");
    const y = old(s, "y", "o1"); // Y takes F in the window: the adopt moves a live Y
    await s.wait("y.entered");
    s.signal("d.resume.move");
    if (variant === "lost") await s.wait("d.paused.publish");
    else assert.equal((await d.exit).signal, "SIGKILL");
    const z = old(s, "z", "o2"); // Z takes the empty F
    await s.wait("z.entered");
    if (variant === "lost") {
      s.signal("d.resume.publish");
      await d.exit;
    }
    s.signal("y.release"); // Y's release removes Z's file (unconditional unlink)
    await y.exit;
    const h = old(s, "h", "o1", { gates: { attempt: { action: "pause", nth: 1 } } });
    await s.wait("h.paused.attempt");
    const w = s.start("w");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.has("w.entered"), false, "W waits: Z is in its section without a file");
    s.signal("h.resume.attempt");
    await s.wait(["h.entered", "h.fenced", "h.contended"]);
    if (s.has("h.entered")) {
      s.signal("h.release");
    }
    h.child.kill("SIGKILL");
    await h.exit;
    s.signal("z.release");
    await z.exit;
    await s.wait("w.entered");
    s.signal("w.release");
    assert.equal((await w.exit).code, 0, s.errors().join("\n"));
    assert.equal(s.has("w.overlap"), false, "no section of W overlapped an old section");
  });
}

// ---------------------------------------------------------------------------
// N31: the O2 acceptance branch on a residue with two names
// ---------------------------------------------------------------------------

async function residueSetup(s) {
  const k = s.start("k", { impl: "o2", gates: { linked: "kill" } });
  assert.equal((await k.exit).signal, "SIGKILL");
  const { stateDir, fence } = paths(s);
  const residue = fs.readdirSync(stateDir).find((n) => /^state\.lock\.\d+$/.test(n));
  assert.ok(residue, "precondition: O2 left state.lock.<pid>");
  assert.equal(fs.statSync(fence).nlink, 2);
  return { residue: path.join(stateDir, residue), k };
}

test("N31a: an old O2 writer with a reused pid cannot enter after the seal: the residue blocks, a new scan follows", async (t) => {
  const s = scenario(t);
  const { stateDir } = paths(s);
  const { residue } = await residueSetup(s);
  const d = await adopt(s, "d");
  await d.exit;
  assert.equal(s.result("d").log.nlink, 2);
  assert.deepEqual(s.result("d").log.residues, [path.basename(residue)]);
  assert.ok(record(s).residues.length > 0 && record(s).S0 === null, "no S0 while the residue exists");
  const r1 = await acquireOnce(s, "w1");
  assert.equal(r1.acquired, false);
  assert.match(r1.message, /O2-restbestand/);
  const kk = old(s, "kk", "o2", { gates: { attempt: "pause" } });
  await s.wait("kk.paused.attempt");
  fs.renameSync(residue, path.join(stateDir, `state.lock.${kk.pid}`)); // simulate pid reuse
  s.signal("kk.resume.attempt");
  await s.wait("kk.entered"); // the acceptance branch: in its section without a file on F
  assert.equal(fs.existsSync(path.join(stateDir, `state.lock.${kk.pid}`)), false, "its finally removed the residue");
  const w = s.start("w");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(s.has("w.entered"), false, "the new scan finds K′");
  assert.ok(record(s).S0.some((p) => p.pid === kk.pid));
  s.signal("kk.release");
  await kk.exit;
  await s.wait("w.entered");
  s.signal("w.release");
  assert.equal((await w.exit).code, 0, s.errors().join("\n"));
  noOverlap(s, ["kk", "w"]);
});

test("N31c: removing the residue by hand at any step of K′ never lets W overlap", async (t) => {
  for (const cut of ["before", "attempt"]) {
    const s = scenario(t);
    const { stateDir } = paths(s);
    const { residue } = await residueSetup(s);
    const d = await adopt(s, `d-${cut}`);
    await d.exit;
    if (cut === "before") fs.rmSync(residue); // the operator's hand step, before K′ starts
    const kk = old(s, "kk", "o2", { mode: "quick", gates: { attempt: "pause" } });
    await s.wait("kk.paused.attempt");
    if (cut === "attempt") {
      const named = path.join(stateDir, `state.lock.${kk.pid}`);
      fs.renameSync(residue, named); // K′ wrote into the residue (pid reuse) …
      fs.rmSync(named); // … and the operator removes it before K′'s link
    }
    s.signal("kk.resume.attempt");
    await s.wait(["kk.entered", "kk.error", "kk.fenced"]);
    const w = s.start("w", { mode: "quick" });
    kk.child.kill("SIGKILL");
    await kk.exit;
    assert.equal((await w.exit).code, 0, s.errors().join("\n"));
    noOverlap(s, ["kk", "w"]);
  }
});

test("N31f: a residue present before a lazy fence (no adopt) blocks the seal until it is gone", async (t) => {
  const s = scenario(t);
  const { stateDir } = paths(s);
  fs.mkdirSync(stateDir, { recursive: true });
  const residue = path.join(stateDir, "state.lock.4242");
  fs.writeFileSync(residue, "4242");
  fs.linkSync(residue, path.join(stateDir, "elsewhere-second-name"));
  const r = await acquireOnce(s, "w1");
  assert.equal(r.acquired, false);
  assert.match(r.message, /state\.lock\.4242/);
  fs.rmSync(residue);
  assert.equal((await acquireOnce(s, "w2")).acquired, true);
});

// ---------------------------------------------------------------------------
// N30a: completeness of the scan with many real old processes
// ---------------------------------------------------------------------------

test("N30a: every one of 100 old processes alive across the scan is in S0", async (t) => {
  const s = scenario(t);
  const olds = Array.from({ length: 100 }, () => idleOld(s, t));
  const r = await acquireOnce(s, "w");
  assert.equal(r.acquired, false);
  const recorded = new Set(record(s).S0.map((p) => p.pid));
  assert.deepEqual(olds.filter((o) => !recorded.has(o.pid)).map((o) => o.pid), []);
});

// ---------------------------------------------------------------------------
// N32a–c: no endless wait (D2)
// ---------------------------------------------------------------------------

test("N32a: an old broker is listed as no-lock-path and does not hold the seal", async (t) => {
  const s = scenario(t);
  const broker = idleOld(s, t, { script: "app-server-broker.mjs", sub: "serve" });
  assert.equal((await acquireOnce(s, "w")).acquired, true);
  const drain = s.actor("drain", { op: "drain" });
  await drain.exit;
  const entry = s.result("drain").processes.find((p) => p.pid === broker.pid);
  assert.equal(entry.verdict, "no-lock-path");
  assert.equal(s.result("drain").result, "drained");
});

test("N32b: a fence first made in a nested PID namespace is sealed by the first process in the init namespace", { skip: process.platform !== "linux" && "Linux only" }, async (t) => {
  if (spawnSync("unshare", ["-r", "-p", "-f", "true"]).status !== 0) {
    t.skip("unshare not available");
    return;
  }
  const s = scenario(t);
  const actorPath = new URL("./fenced-lock/lock-actor.mjs", import.meta.url).pathname;
  const env = s.childEnv({ ACTOR_WORKSPACE: s.workspace, ACTOR_BARRIERS: s.barriers, ACTOR_ROLE: "nested", ACTOR_OP: JSON.stringify({ op: "acquire", deadlineMs: 300 }) });
  const nested = spawnSync("unshare", ["-r", "-p", "-f", process.execPath, actorPath], { env });
  assert.equal(nested.status, 0);
  assert.equal(s.result("nested").acquired, false);
  assert.equal(record(s).verdict, "nested");
  assert.equal((await acquireOnce(s, "w")).acquired, true);
  assert.equal(record(s).verdict, "initial");
});

test("N32c: stop-old ends a stopped old process with SIGCONT and SIGTERM/SIGKILL; A is free during the grace", async (t) => {
  const s = scenario(t);
  const { db } = paths(s);
  const o = idleOld(s, t, { body: 'trap "" TERM; sleep 5; :' });
  assert.equal((await acquireOnce(s, "w1")).acquired, false);
  process.kill(o.pid, "SIGSTOP");
  const stopper = s.actor("stop", { op: "stopOld", args: { graceMs: 1_500 } });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(probeKernelLock(db), "free", "A is free during the grace");
  await stopper.exit;
  const r = s.result("stop");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.outcomes[0].outcome, "killed");
  assert.equal((await acquireOnce(s, "w2")).acquired, true);
});
