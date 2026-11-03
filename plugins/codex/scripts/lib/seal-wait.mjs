// #4648: a writer that finds the state lock fence unsealed waits for old
// plugin processes from before the fence (fenced-lock.mjs, #1916). Those are
// alive by pid and start time, not stale, and could still write state, so the
// fence is right to wait. What this module adds, in the consumer only:
//   - a command that starts work checks the fence once, up front, and waits
//     for those processes up to a total of 60 s (a pre-flight; nothing later
//     in the run waits), saying on stderr what it waits for;
//   - when the wait still fails, the error names each such process (user,
//     parent, age, working directory), says they are not stale, and gives the
//     two routes: wait, or state-lock stop-old.
// A caller that passes its own deadlineMs (the single-attempt final publication
// in tracked-jobs.mjs) gets the plain lock behaviour: no wait, no diagnosis.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { StateLockRefused, StateLockTimeout } from "./fenced-lock.mjs";

// Total time a start command spends on the lock, the ordinary 10 s deadline
// included.
export const DEFAULT_SEAL_WAIT_MS = 60_000;
export const MAX_SEAL_WAIT_MS = 300_000;
export const SEAL_WAIT_ENV = "CODEX_COMPANION_SEAL_WAIT_MS";

// The total for commands that start work: the environment overrides the default
// (0 switches the wait off).
export function startCommandSealWaitMs(env = {}) {
  const raw = env[SEAL_WAIT_ENV];
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_SEAL_WAIT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, MAX_SEAL_WAIT_MS) : DEFAULT_SEAL_WAIT_MS;
}

// user, parent, age and working directory of one blocker, from ps (macOS and
// Linux) and /proc/<pid>/cwd (Linux). Every field is best effort: null when the
// process is gone or unreadable.
export function describeProcess(pid) {
  const out = { user: null, ppid: null, running: null, cwd: null };
  try {
    const text = execFileSync("ps", ["-o", "ppid=,etime=,user=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const [ppid, etime, ...user] = text.split(/\s+/);
    out.ppid = /^\d+$/.test(ppid ?? "") ? Number(ppid) : null;
    out.running = etime || null;
    out.user = user.join(" ") || null;
  } catch {
    // gone or not readable
  }
  try {
    out.cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // not Linux, or not ours to read
  }
  return out;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function blockersOf(lock) {
  try {
    const waiting = lock.status()?.waitingOn;
    return waiting?.kind === "processes" && Array.isArray(waiting.processes) && waiting.processes.length > 0 ? waiting.processes : null;
  } catch {
    return null;
  }
}

function blockerLine(p, describe) {
  const d = describe(p.pid) ?? {};
  const what = p.script ? `${p.script}${p.sub ? ` ${p.sub}` : ""}` : `${p.comm ?? "unknown process"}${p.reason ? `, ${p.reason}` : ""}`;
  const bits = [
    d.user ? `user ${d.user}` : null,
    Number.isInteger(d.ppid) ? `parent ${d.ppid}` : null,
    d.running ? `running ${d.running}` : null,
    d.cwd ? `cwd ${d.cwd}` : null
  ].filter(Boolean);
  return `pid ${p.pid} (${what}${bits.length ? `; ${bits.join(", ")}` : ""})`;
}

export function sealBlockedMessage(blockers, { describe = describeProcess, companionScript = null, cwd = null, waitedMs = 0 } = {}) {
  const many = blockers.length !== 1;
  const list = blockers.map((p) => blockerLine(p, describe)).join("; ");
  const stop =
    companionScript && cwd
      ? ` To stop exactly these processes (this ends their work; add --include-unidentified for ones that could not be identified): node ${shellQuote(companionScript)} state-lock stop-old --cwd ${shellQuote(cwd)}.`
      : "";
  return (
    `The state lock fence is not sealed: ${blockers.length} old plugin process${many ? "es" : ""} from before the fence ` +
    `${many ? "are" : "is"} still running and could still write state, so new work waits for ${many ? "them" : "it"}` +
    `${waitedMs >= 1000 ? ` (waited ${Math.round(waitedMs / 1000)} s)` : ""}. ` +
    `${many ? "They are" : "It is"} not stale: alive by pid and start time. ${list}. ` +
    `Wait for ${many ? "them" : "it"} to finish, then the lock seals by itself and the command can be run again.${stop}`
  );
}

// acquire with the diagnosis. lock: an openFencedLock result. waitMs: the total
// time to spend on the lock when old processes hold the fence (0 = the ordinary
// deadline only). An explicit deadlineMs means the caller paces its own attempts:
// plain acquire.
export function acquireWithSealWait(lock, options = {}) {
  const {
    deadlineMs,
    waitMs = 0,
    describe: describeOne = describeProcess,
    log = (line) => process.stderr.write(`${line}\n`),
    companionScript = null,
    cwd = null
  } = options;
  if (deadlineMs !== undefined) return lock.acquire({ deadlineMs });

  // One ps per process however often it is shown.
  const seen = new Map();
  const describe = (pid) => {
    if (!seen.has(pid)) seen.set(pid, describeOne(pid));
    return seen.get(pid);
  };

  const started = performance.now();
  let error;
  try {
    return lock.acquire({});
  } catch (caught) {
    if (!(caught instanceof StateLockTimeout) || caught instanceof StateLockRefused) throw caught;
    error = caught;
  }
  // The lock's own status decides whether this is a seal wait (old plugin
  // processes listed); a busy lock or a transient refusal keeps its own error.
  let blockers = blockersOf(lock);
  if (!blockers) throw error;

  if (waitMs - (performance.now() - started) > 0) {
    // Describing the blockers (ps) counts against the budget.
    const shown = blockers.map((p) => blockerLine(p, describe)).join("; ");
    const remainingMs = waitMs - (performance.now() - started);
    if (remainingMs > 0) {
      log(`state lock: waiting up to ${Math.ceil(remainingMs / 1000)} s more for old plugin processes from before the fence: ${shown}`);
      try {
        return lock.acquire({ deadlineMs: remainingMs });
      } catch (caught) {
        if (!(caught instanceof StateLockTimeout) || caught instanceof StateLockRefused) throw caught;
        error = caught;
      }
      // Still a seal wait? If the old processes are gone and something else
      // holds the lock now, say that plainly instead of naming stale blockers.
      blockers = blockersOf(lock);
      if (!blockers) throw error;
    }
  }
  const waitedMs = performance.now() - started;
  const message = `${sealBlockedMessage(blockers, { describe, companionScript, cwd, waitedMs })} (${error.message})`;
  throw Object.assign(new StateLockTimeout(message, error.reason), { refusal: error.refusal ?? null, blockers, cause: error });
}
