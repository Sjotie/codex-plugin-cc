// Real-process races on the state lock (#1916, design §11 T1–T6, N1).
//
// Run against the new code (default) or a released old protocol:
//   STATE_LOCK_TEST_IMPL=o1 node --test tests/state-lock-races.test.mjs   (c5fc9a5, sjotie.13–.21)
//   STATE_LOCK_TEST_IMPL=o2 node --test tests/state-lock-races.test.mjs   (81333c0, sjotie.22)
// The old protocols must fail T2–T5 (O2 also T6); the new code must pass all.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { IMPL, probeKernelLock, scenario } from "./fenced-lock/scenario.mjs";
import { loadState, resolveJobFile, resolveJobLogFile, resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const isNew = IMPL === "new";

function outcome(s, roles) {
  process.env.CLAUDE_PLUGIN_DATA = s.pluginData;
  return {
    overlap: roles.some((role) => s.has(`${role}.overlap`)),
    jobs: loadState(s.workspace)
      .jobs.map((job) => job.id)
      .sort(),
    artifacts: Object.fromEntries(
      roles.map((id) => [
        id,
        { json: fs.existsSync(resolveJobFile(s.workspace, id)), log: fs.existsSync(resolveJobLogFile(s.workspace, id)) }
      ])
    )
  };
}

function preserved(roles) {
  return {
    overlap: false,
    jobs: [...roles].sort(),
    artifacts: Object.fromEntries(roles.map((id) => [id, { json: true, log: true }]))
  };
}

function paths(s) {
  process.env.CLAUDE_PLUGIN_DATA = s.pluginData;
  const stateDir = resolveStateDir(s.workspace);
  return { stateDir, lockPath: path.join(stateDir, "state.lock"), dbPath: path.join(stateDir, "state.lock.db") };
}

// Let both writers finish in the order they entered, whatever the protocol did.
async function finishBoth(s, first, second) {
  for (const w of [first, second]) {
    if (!s.has(`${w.role}.entered`)) {
      await s.wait([`${w.role}.entered`, `${w.role}.error`]);
    }
    s.signal(`${w.role}.release`);
    const result = await w.exit;
    assert.equal(result.code, 0, `${w.role} failed: ${result.stderr}${s.errors().join("\n")}`);
  }
}

test("T1: a healthy owner excludes a waiter and both writes survive", async (t) => {
  const s = scenario(t);
  const b = s.start("b");
  await s.wait("b.entered");
  const a = s.start("a");
  assert.equal(await s.wait(["a.contended", "a.entered"]), "a.contended");
  await finishBoth(s, b, a);
  assert.deepEqual(outcome(s, ["a", "b"]), preserved(["a", "b"]));
});

test("T2: a dead owner and a delayed stale reaper never put two writers in the section", async (t) => {
  const s = scenario(t);
  const dead = s.start("dead", { mode: "crash" });
  assert.equal((await dead.exit).code, 0);

  const a = s.start("a", { gates: { "stale-unlink": "pause" } });
  const first = await s.wait(["a.paused.stale-unlink", "a.entered"]);
  const b = s.start("b");
  await s.wait(["b.entered", "b.contended"]);
  if (first === "a.paused.stale-unlink") s.signal("a.resume.stale-unlink");
  await s.wait(["a.entered", "a.contended"]);
  const order = s.has("b.entered") && !s.has("a.entered") ? [b, a] : [a, b];
  await finishBoth(s, ...order);
  assert.deepEqual(outcome(s, ["a", "b"]), preserved(["a", "b"]));
});

test("T3: a delayed release leaves the successor's ownership intact", async (t) => {
  const s = scenario(t);
  const { lockPath, dbPath } = paths(s);
  const a = s.start("a", { mode: "quick", gates: { release: "pause" } });
  await s.wait("a.paused.release");
  if (!isNew) {
    // Old protocol: A's ownership is reclaimed while its release is delayed
    // (the stale reaper of T2 does this); the rename isolates the release.
    fs.renameSync(lockPath, `${lockPath}.retired`);
  }
  const b = s.start("b");
  const seen = await s.wait(["b.entered", "b.contended"]);
  if (isNew) assert.equal(seen, "b.contended", "B must wait while A still holds the lock");
  const before = isNew ? null : fs.lstatSync(lockPath);
  s.signal("a.resume.release");
  assert.equal((await a.exit).code, 0);
  await s.wait("b.entered");
  if (isNew) {
    assert.equal(probeKernelLock(dbPath), "held", "B must still hold the kernel lock after A's release");
  } else {
    assert.equal(fs.existsSync(lockPath), true, "A's release must leave B's lock in place");
    assert.equal(fs.lstatSync(lockPath).ino, before.ino, "B must still own the same lock object");
  }
  s.signal("b.release");
  assert.equal((await b.exit).code, 0);
});

for (const [id, linkError] of [
  ["T4", undefined],
  ["T5", "ENOTSUP"]
]) {
  test(`${id}: a contender paused at publication cannot enter beside the owner${linkError ? ` (link ${linkError})` : ""}`, async (t) => {
    const s = scenario(t);
    const a = s.start("a", { gates: { publication: "pause" }, linkError });
    await s.wait("a.paused.publication");
    const b = s.start("b", { linkError });
    await s.wait(["b.entered", "b.contended"]);
    s.signal("a.resume.publication");
    await s.wait(["a.entered", "a.contended"]);
    const order = s.has("b.entered") && !s.has("a.entered") ? [b, a] : [a, b];
    await finishBoth(s, ...order);
    assert.deepEqual(outcome(s, ["a", "b"]), preserved(["a", "b"]));
  });
}

test("T6: a contender killed mid-attempt leaves no lock candidate behind", async (t) => {
  const s = scenario(t);
  const { stateDir } = paths(s);
  const b = s.start("b");
  await s.wait("b.entered");
  const a = s.start("a", { gates: { attempt: "kill" } });
  assert.equal((await a.exit).signal, "SIGKILL");
  s.signal("b.release");
  assert.equal((await b.exit).code, 0);
  const candidates = fs.readdirSync(stateDir).filter((name) => /^state\.lock\.(\d+|prep-.*)$/.test(name));
  assert.deepEqual(candidates, [], "a killed contender must not leave a pending or prep file");
});

test("N1: an owner killed inside the section frees the lock at once; state is the last commit", async (t) => {
  const s = scenario(t);
  const first = s.start("first", { mode: "quick" });
  assert.equal((await first.exit).code, 0);
  const a = s.start("a", { gates: { "in-section": "kill" } });
  assert.equal((await a.exit).signal, "SIGKILL");
  const startedAt = Date.now();
  const b = s.start("b", { mode: "quick" });
  assert.equal((await b.exit).code, 0, s.errors().join("\n"));
  assert.ok(Date.now() - startedAt < 5_000, "the next writer must not wait for a timeout");
  const jobs = outcome(s, ["first", "b"]).jobs;
  assert.deepEqual(jobs, ["b", "first"]);
});

// The oracle itself (review of 4ad0c73, N28): a mark of a living holder is an
// overlap, a mark left by a holder that died in its section is not.
test("oracle: a living holder's section mark is an overlap; a dead holder's mark is logged as dead, not counted", { skip: process.platform !== "linux" && "Linux /proc" }, async (t) => {
  const startOf = (pid) => {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  };
  for (const living of [true, false]) {
    const s = scenario(t);
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    const held = new Promise((r) => holder.once("exit", r));
    t.after(async () => {
      if (holder.exitCode == null && holder.signalCode == null) holder.kill("SIGKILL");
      await held;
    });
    await new Promise((r) => setTimeout(r, 30));
    fs.mkdirSync(path.join(s.barriers, "sections"));
    fs.writeFileSync(path.join(s.barriers, "sections", "x"), `x ${holder.pid} ${startOf(holder.pid)}`);
    if (!living) {
      holder.kill("SIGKILL");
      await held;
    }
    const w = s.start("w", { mode: "quick" });
    assert.equal((await w.exit).code, 0, s.errors().join("\n"));
    const log = fs.readFileSync(path.join(s.barriers, "oracle.log"), "utf8");
    if (living) {
      assert.equal(s.has("w.overlap"), true, "a living holder's mark must count as overlap");
    } else {
      assert.equal(s.has("w.overlap"), false, `a dead holder's mark is no overlap: ${log}`);
      assert.match(log, /^dead x /m);
    }
  }
});
