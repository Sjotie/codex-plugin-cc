// A real writer process for the state-lock race tests (#1916). It loads
// either the new state.mjs or a released old one (O1, O2) and writes one job
// through updateState, the way every plugin process does.
//
// Gates sit on syscalls of this test process only (fs and the SQLite exec of
// the lock); nothing here is in the product. A gate either pauses the writer
// until the test lets it go, or kills it with SIGKILL at that exact point.
//
// Environment:
//   WRITER_STATE_MJS   state.mjs to load
//   WRITER_WORKSPACE   workspace whose state directory is used
//   WRITER_BARRIERS    directory for the event files
//   WRITER_ROLE        name of this writer (also the job id)
//   WRITER_MODE        owner (hold the section until <role>.release), quick, crash
//                      (exit inside the section, skipping every finally)
//   WRITER_GATES       JSON {point: "pause" | "kill" | {action, nth}}
//   WRITER_LINK_ERROR  make link() to state.lock fail with this code
//
// Gate points:
//   attempt       right before an attempt to take the lock (O1 open(wx), O2 link, new BEGIN EXCLUSIVE)
//   publication   the moment before the lock becomes visible (O1 after open(wx), before the PID
//                 write; O2 before link; new before rename(prep -> state.lock))
//   linked        O2 only: after a successful link, before the pending file is removed
//   stale-unlink  old only: before unlinking a lock judged stale
//   in-section    inside the critical section
//   release       old: before the release unlink; new: before COMMIT of the lock transaction
//
// Events written to WRITER_BARRIERS: <role>.paused.<point>, <role>.entered,
// <role>.contended, <role>.fenced, <role>.overlap, <role>.done, <role>.error
import "./scan-scope.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const env = process.env;
const role = env.WRITER_ROLE;
const barriers = env.WRITER_BARRIERS;
const workspace = env.WRITER_WORKSPACE;
const mode = env.WRITER_MODE ?? "owner";
const gates = JSON.parse(env.WRITER_GATES ?? "{}");

const original = {
  openSync: fs.openSync,
  linkSync: fs.linkSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  existsSync: fs.existsSync,
  appendFileSync: fs.appendFileSync,
  mkdirSync: fs.mkdirSync,
  readdirSync: fs.readdirSync
};
const eventPath = (name) => path.join(barriers, name);
const signal = (name) => original.writeFileSync.call(fs, eventPath(`${role}.${name}`), "");
const waitFor = (name) => {
  const deadline = Date.now() + 30_000;
  while (!original.existsSync.call(fs, eventPath(name))) {
    if (Date.now() >= deadline) throw new Error(`writer ${role} timed out waiting for ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};

// A gate is "pause" or "kill" (first occurrence of the point) or {action, nth}.
const seen = new Map();
function gate(point) {
  const spec = gates[point];
  if (!spec) return;
  const count = (seen.get(point) ?? 0) + 1;
  seen.set(point, count);
  const { action, nth = 1 } = typeof spec === "string" ? { action: spec } : spec;
  if (count !== nth) return;
  if (action === "kill") {
    process.kill(process.pid, "SIGKILL");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  }
  signal(`paused.${point}`);
  waitFor(`${role}.resume.${point}`);
}

const { resolveStateDir, updateState, writeJobFile, resolveJobLogFile } = await import(
  pathToFileURL(env.WRITER_STATE_MJS).href
);
const stateDir = resolveStateDir(workspace);
const lockPath = path.join(stateDir, "state.lock");
const pendingPrefix = `${lockPath}.`;
let mutationFinished = false;

fs.openSync = function (file, flags, ...rest) {
  if (String(file) === lockPath && flags === "wx") gate("attempt");
  try {
    const fd = original.openSync.call(this, file, flags, ...rest);
    if (String(file) === lockPath && flags === "wx") gate("publication");
    return fd;
  } catch (error) {
    if (String(file) === lockPath && error.code === "EEXIST") signal("contended");
    throw error;
  }
};
fs.linkSync = function (from, to, ...rest) {
  if (String(to) === lockPath) {
    if (env.WRITER_LINK_ERROR) {
      throw Object.assign(new Error("fixture: hard links unsupported"), { code: env.WRITER_LINK_ERROR });
    }
    gate("attempt");
    gate("publication");
  }
  try {
    const result = original.linkSync.call(this, from, to, ...rest);
    if (String(to) === lockPath) gate("linked");
    return result;
  } catch (error) {
    if (String(to) === lockPath && error.code === "EEXIST") signal("contended");
    throw error;
  }
};
fs.renameSync = function (from, to, ...rest) {
  if (String(to) === lockPath && String(from).startsWith(pendingPrefix)) gate("publication");
  return original.renameSync.call(this, from, to, ...rest);
};
fs.unlinkSync = function (file, ...rest) {
  if (String(file) === lockPath) gate(mutationFinished ? "release" : "stale-unlink");
  return original.unlinkSync.call(this, file, ...rest);
};
fs.readFileSync = function (file, ...rest) {
  try {
    return original.readFileSync.call(this, file, ...rest);
  } catch (error) {
    if (String(file) === lockPath && error.code === "EISDIR") signal("fenced");
    throw error;
  }
};

// The new lock: gate on the SQLite transaction of state.lock.db.
try {
  const { DatabaseSync } = await import("node:sqlite");
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    const statement = String(sql).trim().toUpperCase();
    if (statement.startsWith("BEGIN")) gate("attempt");
    if (statement === "COMMIT" && mutationFinished) gate("release");
    try {
      return exec.call(this, sql);
    } catch (error) {
      if (statement.startsWith("BEGIN") && (error.errcode & 0xff) === 5) signal("contended");
      throw error;
    }
  };
} catch {
  // No node:sqlite (old Node): only the old protocols can run here.
}

// [state, start time] of a process from one read of /proc/<pid>/stat, or null.
function procStat(pid) {
  try {
    const stat = original.readFileSync.call(fs, `/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], start: fields[19] };
  } catch {
    return null;
  }
}

function startTime(pid) {
  return procStat(pid)?.start ?? "?";
}

function readMark(file) {
  try {
    const [r, pid, start] = original.readFileSync.call(fs, file, "utf8").split(" ");
    return Number.isInteger(Number(pid)) && Number(pid) > 0 ? { role: r, pid: Number(pid), start } : null;
  } catch {
    return null;
  }
}

function holderAlive({ pid, start }) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
  }
  if (start === "?") return true; // no /proc: alive is the conservative answer
  const now = procStat(pid);
  return Boolean(now) && now.state !== "Z" && now.start === start;
}

try {
  const logFile = mode === "crash" ? null : resolveJobLogFile(workspace, role);
  if (mode !== "crash") {
    writeJobFile(workspace, role, { id: role, status: "completed" });
    original.writeFileSync.call(fs, logFile, `result for ${role}\n`);
  }
  updateState(workspace, (state) => {
    if (mode === "crash") process.exit(0); // like process death: no finally runs
    // The oracle (crash-proof, review of 4ad0c73): every section writes its own
    // mark sections/<role> (role, pid, start time; written to a temp name and
    // renamed, so never half written), then lists the others. A mark of a
    // living holder is an overlap; a mark of a dead holder (gone, zombie,
    // other start time) is a section that ended in a crash: logged as "dead"
    // and never counted. Nobody removes another holder's mark.
    const sections = eventPath("sections");
    original.mkdirSync.call(fs, sections, { recursive: true });
    const own = path.join(sections, role);
    original.writeFileSync.call(fs, `${own}.tmp`, `${role} ${process.pid} ${startTime(process.pid)}`);
    original.renameSync.call(fs, `${own}.tmp`, own);
    for (const name of original.readdirSync.call(fs, sections)) {
      if (name === role || name.endsWith(".tmp")) continue;
      const holder = readMark(path.join(sections, name));
      if (!holder) continue; // that holder just left
      if (holderAlive(holder)) {
        signal("overlap");
      } else {
        original.appendFileSync.call(fs, eventPath("oracle.log"), `dead ${holder.role} ${process.hrtime.bigint()}\n`);
      }
    }
    original.appendFileSync.call(fs, eventPath("oracle.log"), `enter ${role} ${process.hrtime.bigint()}\n`);
    signal("entered");
    try {
      gate("in-section");
      state.jobs.push({ id: role, status: "completed", logFile, updatedAt: new Date().toISOString() });
      if (mode === "owner") waitFor(`${role}.release`);
    } finally {
      original.appendFileSync.call(fs, eventPath("oracle.log"), `exit ${role} ${process.hrtime.bigint()}\n`);
      original.unlinkSync.call(fs, own);
    }
    mutationFinished = true;
  });
  signal("done");
} catch (error) {
  original.writeFileSync.call(fs, eventPath(`${role}.error`), String(error?.stack ?? error));
  process.exitCode = 1;
}
