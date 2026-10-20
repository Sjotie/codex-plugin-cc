// One job operation in a real process, against the new or a released old
// state.mjs, for the artifact tests (#1916, design §6, tests A1–A9).
//
// Environment:
//   ACTOR_LIB_DIR    directory holding state.mjs and job-control.mjs to load
//   ACTOR_WORKSPACE  workspace
//   ACTOR_BARRIERS   directory for event files
//   ACTOR_ROLE       name of this actor
//   ACTOR_OP         JSON {op, ...args}
//   ACTOR_GATES      JSON [{fn, match, when: "before"|"after", nth, action, name}]
//                    fn: readFileSync | writeFileSync | renameSync | unlinkSync; match: regex on the path
//                    (renameSync: the target); action: pause | kill | fail:<CODE>
//
// Events: <role>.paused.<name>, <role>.done (with the JSON result), <role>.error
import "./scan-scope.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const env = process.env;
const role = env.ACTOR_ROLE;
const barriers = env.ACTOR_BARRIERS;
const workspace = env.ACTOR_WORKSPACE;
const op = JSON.parse(env.ACTOR_OP);
const gates = JSON.parse(env.ACTOR_GATES ?? "[]").map((g) => ({ ...g, seen: 0, re: new RegExp(g.match) }));

const write = fs.writeFileSync;
const exists = fs.existsSync;
const eventPath = (name) => path.join(barriers, name);
const signal = (name, body = "") => write.call(fs, eventPath(`${role}.${name}`), body);
const waitFor = (name) => {
  const deadline = Date.now() + 30_000;
  while (!exists.call(fs, eventPath(name))) {
    if (Date.now() >= deadline) throw new Error(`actor ${role} timed out waiting for ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};

function fire(gate) {
  if (gate.action === "kill") {
    process.kill(process.pid, "SIGKILL");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  }
  if (gate.action.startsWith("fail:")) {
    const code = gate.action.slice(5);
    throw Object.assign(new Error(`fixture: ${code}`), { code });
  }
  signal(`paused.${gate.name}`);
  waitFor(`${role}.resume.${gate.name}`);
}

for (const fn of ["readFileSync", "writeFileSync", "renameSync", "unlinkSync"]) {
  const original = fs[fn];
  fs[fn] = function (first, second, ...rest) {
    const target = String(fn === "renameSync" ? second : first);
    const matching = gates.filter((g) => g.fn === fn && g.re.test(target));
    for (const g of matching) {
      g.seen += 1;
      if (g.when === "before" && g.seen === (g.nth ?? 1)) fire(g);
    }
    const result = original.call(this, first, second, ...rest);
    for (const g of matching) {
      if (g.when === "after" && g.seen === (g.nth ?? 1)) fire(g);
    }
    return result;
  };
}

const lib = (name) => import(pathToFileURL(path.join(env.ACTOR_LIB_DIR, name)).href);

try {
  const state = await lib("state.mjs");
  const control = await lib("job-control.mjs");
  let result = null;
  switch (op.op) {
    case "listJobs":
      result = state.listJobs(workspace).map((job) => ({ id: job.id, status: job.status }));
      break;
    case "upsert":
      for (const job of op.jobs) {
        if (op.withArtifacts) {
          state.writeJobFile(workspace, job.id, job);
          write.call(fs, state.resolveJobLogFile(workspace, job.id), `log ${job.id}\n`);
        }
        state.upsertJob(workspace, { ...job, ...(op.withArtifacts ? { logFile: state.resolveJobLogFile(workspace, job.id) } : {}) });
      }
      break;
    case "addMany":
      // One commit that adds many jobs (with artifacts): retention pressure.
      for (const job of op.jobs) {
        state.writeJobFile(workspace, job.id, job);
        write.call(fs, state.resolveJobLogFile(workspace, job.id), `log ${job.id}\n`);
      }
      state.updateState(workspace, (s) => {
        for (const job of op.jobs) s.jobs.unshift({ ...job, logFile: state.resolveJobLogFile(workspace, job.id) });
      });
      break;
    case "cancelRecord":
      state.updateJobRecord(workspace, op.jobId, (existing) => ({ ...existing, status: "cancelled", phase: "cancelled", completedAt: new Date().toISOString() }));
      break;
    case "requeue":
      state.updateJobRecord(workspace, op.jobId, (existing) => ({ ...existing, status: "queued", phase: "queued", pid: null, completedAt: null }));
      break;
    case "settleCancel":
      result = control.settleCancellationAfterTermination(workspace, op.job, op.existing, { delivered: false });
      result = { processStopped: result.processStopped };
      break;
    case "waitTerminal":
      result = await control.waitForTerminalJob(workspace, op.jobId, { timeoutMs: 5_000, pollIntervalMs: 10 });
      result = { outcome: result.outcome, status: result.job?.status ?? null };
      break;
    default:
      throw new Error(`unknown op ${op.op}`);
  }
  signal("done", JSON.stringify(result));
} catch (error) {
  signal("error", String(error?.stack ?? error));
  process.exitCode = 1;
}
