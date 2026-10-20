// Artifact authority and commit-before-prune (#1916, design §6, tests A1–A9).
// Real processes run the operation under test; STATE_LOCK_TEST_IMPL picks the
// new code (default) or a released old protocol (o1, o2) for those processes.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { IMPL, scenario } from "./fenced-lock/scenario.mjs";
import { stateMjsFor } from "./fenced-lock/old-trees.mjs";
import { loadState, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile } from "../plugins/codex/scripts/lib/state.mjs";

const ACTOR = fileURLToPath(new URL("./fenced-lock/job-actor.mjs", import.meta.url));
const LIB_DIR = path.dirname(stateMjsFor(IMPL));
const isNew = IMPL === "new";

function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

function actor(s, role, op, gates = []) {
  const child = spawn(process.execPath, [ACTOR], {
    env: s.childEnv({
      ACTOR_LIB_DIR: LIB_DIR,
      ACTOR_WORKSPACE: s.workspace,
      ACTOR_BARRIERS: s.barriers,
      ACTOR_ROLE: role,
      ACTOR_OP: JSON.stringify(op),
      ACTOR_GATES: JSON.stringify(gates)
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const exit = new Promise((resolve) => child.once("exit", (code, sig) => resolve({ code, signal: sig, stderr })));
  return { child, exit };
}

function use(s) {
  process.env.CLAUDE_PLUGIN_DATA = s.pluginData;
  return {
    stateDir: resolveStateDir(s.workspace),
    index: () => loadState(s.workspace).jobs,
    json: (id) => fs.existsSync(resolveJobFile(s.workspace, id)),
    log: (id) => fs.existsSync(resolveJobLogFile(s.workspace, id)),
    readJson: (id) => JSON.parse(fs.readFileSync(resolveJobFile(s.workspace, id), "utf8"))
  };
}

// Write a state directory directly (format version 1): every job gets its JSON and log.
function seed(s, jobs) {
  const u = use(s);
  fs.mkdirSync(path.join(u.stateDir, "jobs"), { recursive: true });
  const indexed = jobs.map((job) => {
    const logFile = resolveJobLogFile(s.workspace, job.id);
    fs.writeFileSync(resolveJobFile(s.workspace, job.id), `${JSON.stringify({ ...job, ...(job.json ?? {}) }, null, 2)}\n`);
    fs.writeFileSync(logFile, `log ${job.id}\n`);
    const { json, ...rest } = job;
    void json;
    return { ...rest, logFile };
  });
  fs.writeFileSync(
    resolveStateFile(s.workspace),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: indexed }, null, 2)}\n`
  );
  return u;
}

function at(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function terminalJobs(count, prefix, minutesAgo) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(3, "0")}`,
    status: "completed",
    phase: "completed",
    jobClass: "review",
    updatedAt: at(minutesAgo - i * 0.01),
    createdAt: at(minutesAgo)
  }));
}

test("A1: a reconcile from a stale snapshot does not drop a job added concurrently", async (t) => {
  const s = scenario(t);
  const u = seed(s, [{ id: "a", status: "running", phase: "running", pid: deadPid(), updatedAt: at(5) }]);
  const reader = actor(s, "reader", { op: "listJobs" }, [
    { fn: "readFileSync", match: "state\\.json$", when: "after", nth: 1, action: "pause", name: "snapshot" }
  ]);
  await s.wait("reader.paused.snapshot");
  const writer = actor(s, "writer", { op: "upsert", withArtifacts: true, jobs: [{ id: "b", status: "completed", phase: "completed", updatedAt: at(1) }] });
  assert.equal((await writer.exit).code, 0, s.errors().join("\n"));
  s.signal("reader.resume.snapshot");
  assert.equal((await reader.exit).code, 0, s.errors().join("\n"));
  const ids = u.index().map((job) => job.id).sort();
  assert.deepEqual(ids, ["a", "b"], "the concurrently added job must stay in the index");
  assert.equal(u.json("b") && u.log("b"), true, "and keep its JSON and log");
  assert.equal(u.index().find((job) => job.id === "a").status, "failed");
});

test("A2: a crash during the prune never leaves the index pointing at deleted artifacts", async (t) => {
  const s = scenario(t);
  const u = seed(s, terminalJobs(50, "old", 60));
  const adder = actor(s, "adder", { op: "upsert", withArtifacts: true, jobs: [{ id: "new-1", status: "completed", phase: "completed", updatedAt: at(0) }] }, [
    { fn: "unlinkSync", match: "/jobs/old-.*\\.(json|log)$", when: "after", nth: 1, action: "kill", name: "prune" }
  ]);
  assert.equal((await adder.exit).signal, "SIGKILL", "the adder must die at its first prune unlink");
  const missing = u.index().filter((job) => !u.json(job.id) || !u.log(job.id)).map((job) => job.id);
  assert.deepEqual(missing, [], "every indexed job keeps its JSON and log");
});

test("A3: a failing prune unlink after the commit keeps the commit and reports success", async (t) => {
  const s = scenario(t);
  const u = seed(s, terminalJobs(50, "old", 60));
  const adder = actor(s, "adder", { op: "upsert", withArtifacts: true, jobs: [{ id: "new-1", status: "completed", phase: "completed", updatedAt: at(0) }] }, [
    { fn: "unlinkSync", match: "/jobs/old-.*\\.(json|log)$", when: "before", nth: 1, action: "fail:EACCES", name: "prune" }
  ]);
  const result = await adder.exit;
  assert.equal(result.code, 0, `the caller must see success: ${s.errors().join("\n")}`);
  assert.ok(u.index().some((job) => job.id === "new-1"), "the commit stays");
  assert.match(result.stderr, /committed; cleanup failed/);
});

test("A4: a waiter that finds a dead worker does not overwrite a concurrent cancel", async (t) => {
  const s = scenario(t);
  const u = seed(s, [{ id: "j", status: "running", phase: "running", pid: deadPid(), jobClass: "task", updatedAt: at(1) }]);
  const waiter = actor(s, "waiter", { op: "waitTerminal", jobId: "j" }, [
    { fn: "readFileSync", match: "/jobs/j\\.json$", when: "after", nth: 2, action: "pause", name: "read" }
  ]);
  await s.wait("waiter.paused.read");
  const canceller = actor(s, "canceller", { op: "cancelRecord", jobId: "j" });
  assert.equal((await canceller.exit).code, 0, s.errors().join("\n"));
  s.signal("waiter.resume.read");
  assert.equal((await waiter.exit).code, 0, s.errors().join("\n"));
  assert.equal(u.readJson("j").status, "cancelled", "the terminal cancel record must survive");
});

function a7Setup(s, t) {
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  t.after(() => {
    if (sleeper.exitCode == null) sleeper.kill("SIGKILL");
  });
  const cancelled = { id: "j", status: "cancelled", phase: "cancelled", pid: sleeper.pid, jobClass: "task", updatedAt: at(120), completedAt: at(120) };
  const u = seed(s, [cancelled]);
  return { u, sleeper, cancelled };
}

async function a7Crash(s, cancelled) {
  const running = { ...cancelled, status: "running", phase: "running", completedAt: null };
  const restorer = actor(s, "restorer", { op: "settleCancel", job: running, existing: cancelled }, [
    { fn: "renameSync", match: "/jobs/j\\.json$", when: "after", nth: 1, action: "kill", name: "json" }
  ]);
  assert.equal((await restorer.exit).signal, "SIGKILL");
}

test("A7: a restored running job whose index still says cancelled survives retention pressure", async (t) => {
  const s = scenario(t);
  const { u, cancelled } = a7Setup(s, t);
  await a7Crash(s, cancelled);
  assert.equal(u.readJson("j").status, "running", "precondition: JSON ahead of the index");
  const adder = actor(s, "adder", { op: "addMany", jobs: terminalJobs(51, "new", 1) });
  assert.equal((await adder.exit).code, 0, s.errors().join("\n"));
  assert.equal(u.json("j") && u.log("j"), true, "the live job keeps its JSON and log");
  const indexed = u.index().find((job) => job.id === "j");
  assert.equal(indexed?.status, "running", "the index gets the running status back in that commit");
});

test("A8: once the restored job's worker dies, the reconcile fails it in JSON and index", async (t) => {
  const s = scenario(t);
  const { u, sleeper, cancelled } = a7Setup(s, t);
  await a7Crash(s, cancelled);
  sleeper.kill("SIGKILL");
  await new Promise((resolve) => sleeper.once("exit", resolve));
  const lister = actor(s, "lister", { op: "listJobs" });
  assert.equal((await lister.exit).code, 0, s.errors().join("\n"));
  assert.equal(u.readJson("j").status, "failed");
  assert.equal(u.index().find((job) => job.id === "j")?.status, "failed");
});

test("A9: an index member with an unreadable JSON is never pruned", async (t) => {
  const s = scenario(t);
  const u = seed(s, [{ id: "broken", status: "completed", phase: "completed", updatedAt: at(240) }]);
  fs.writeFileSync(resolveJobFile(s.workspace, "broken"), "{ not json");
  const adder = actor(s, "adder", { op: "addMany", jobs: terminalJobs(51, "new", 1) });
  assert.equal((await adder.exit).code, 0, s.errors().join("\n"));
  assert.ok(u.index().some((job) => job.id === "broken"), "the member stays in the index");
  assert.equal(u.log("broken"), true, "and keeps its log");
});

test("A6: assertOwned before the job-record rename refuses when the fence was removed", { skip: !isNew && "new protocol only" }, async (t) => {
  const s = scenario(t);
  const u = seed(s, [{ id: "j", status: "running", phase: "running", pid: process.pid, updatedAt: at(1) }]);
  const before = { json: fs.readFileSync(resolveJobFile(s.workspace, "j"), "utf8"), index: fs.readFileSync(resolveStateFile(s.workspace), "utf8") };
  const fence = path.join(u.stateDir, "state.lock");
  const updater = actor(s, "updater", { op: "cancelRecord", jobId: "j" }, [
    { fn: "writeFileSync", match: "/jobs/j\\.json\\..*tmp$", when: "after", nth: 1, action: "pause", name: "rename" }
  ]);
  await s.wait("updater.paused.rename");
  fs.renameSync(fence, `${fence}.moved-by-hand`); // outside the protocol
  s.signal("updater.resume.rename");
  await updater.exit;
  assert.match(fs.readFileSync(path.join(s.barriers, "updater.error"), "utf8"), /ESTATELOCKLOST/);
  assert.equal(fs.readFileSync(resolveJobFile(s.workspace, "j"), "utf8"), before.json);
  assert.equal(fs.readFileSync(resolveStateFile(s.workspace), "utf8"), before.index);
  const temps = fs.readdirSync(path.join(u.stateDir, "jobs")).filter((name) => name.includes(".tmp"));
  assert.deepEqual(temps, []);
});
