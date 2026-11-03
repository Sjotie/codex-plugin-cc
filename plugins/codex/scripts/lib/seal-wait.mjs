// #4648: a writer that finds the state lock fence unsealed waits for old
// plugin processes from before the fence (fenced-lock.mjs, #1916). Those are
// alive by pid and start time, not stale, and could still write state, so the
// fence is right to wait. What this module adds, in the consumer only:
//   - commands that start work (task, review, ...) wait longer than the
//     ordinary 10 s and say so on stderr while they wait;
//   - when the wait still fails, the error names each blocker (user, parent,
//     age, working directory) and the two routes: wait, or state-lock stop-old.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { StateLockRefused, StateLockTimeout } from "./fenced-lock.mjs";

export const DEFAULT_SEAL_WAIT_MS = 50_000;
export const MAX_SEAL_WAIT_MS = 300_000;
export const SEAL_WAIT_ENV = "CODEX_COMPANION_SEAL_WAIT_MS";

// What the companion adds to the ordinary lock deadline for a command that
// starts work. Hooks and read paths keep 0.
let sealWaitMs = 0;

export function setStateLockSealWait(ms) {
  sealWaitMs = Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_SEAL_WAIT_MS) : 0;
}

export function getStateLockSealWait() {
  return sealWaitMs;
}

// The wait for commands that start work: the environment overrides the default
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
    const text = execFileSync("ps", ["-o", "user=,ppid=,etime=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    const [user, ppid, etime] = text.split(/\s+/);
    out.user = user ?? null;
    out.ppid = ppid === undefined ? null : Number(ppid);
    out.running = etime ?? null;
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
    d.ppid === null || d.ppid === undefined ? null : `parent ${d.ppid}`,
    d.running ? `running ${d.running}` : null,
    d.cwd ? `cwd ${d.cwd}` : null
  ].filter(Boolean);
  return `pid ${p.pid} (${what}${bits.length ? `; ${bits.join(", ")}` : ""})`;
}

export function sealBlockedMessage(blockers, { describe = describeProcess, companionScript = null, cwd = null, waitedMs = 0 } = {}) {
  const list = blockers.map((p) => blockerLine(p, describe)).join("; ");
  const stop = companionScript && cwd ? ` To stop exactly these processes (this ends their work): node "${companionScript}" state-lock stop-old --cwd "${cwd}".` : "";
  return (
    `The state lock fence is not sealed: ${blockers.length} old plugin process${blockers.length === 1 ? "" : "es"} from before the fence ` +
    `${blockers.length === 1 ? "is" : "are"} still running and could still write state, so new work waits for ${blockers.length === 1 ? "it" : "them"}` +
    `${waitedMs > 0 ? ` (waited ${Math.round(waitedMs / 1000)} s)` : ""}. ` +
    `${blockers.length === 1 ? "It is" : "They are"} not stale: alive by pid and start time. ${list}. ` +
    `Wait for them to finish, then the lock seals by itself and the command can be run again.${stop}`
  );
}

// acquire with the diagnosis. lock: openFencedLock result; options.deadlineMs as
// for lock.acquire. Returns the handle or throws the original error, or for a
// seal blocked by old processes a StateLockTimeout that names them.
export function acquireWithSealWait(lock, options = {}) {
  const {
    deadlineMs,
    waitMs = sealWaitMs,
    describe = describeProcess,
    log = (line) => process.stderr.write(`${line}\n`),
    companionScript = null,
    cwd = null
  } = options;
  const acquireOptions = deadlineMs === undefined ? {} : { deadlineMs };
  let error;
  try {
    return lock.acquire(acquireOptions);
  } catch (caught) {
    if (!(caught instanceof StateLockTimeout) || caught instanceof StateLockRefused) throw caught;
    error = caught;
  }
  let blockers = blockersOf(lock);
  if (!blockers) throw error;

  let waited = 0;
  if (waitMs > 0) {
    log(
      `state lock: waiting up to ${Math.round(waitMs / 1000)} s for old plugin processes from before the fence: ` +
        `${blockers.map((p) => blockerLine(p, describe)).join("; ")}`
    );
    const started = performance.now();
    try {
      return lock.acquire({ deadlineMs: waitMs });
    } catch (caught) {
      if (!(caught instanceof StateLockTimeout) || caught instanceof StateLockRefused) throw caught;
      error = caught;
      waited = performance.now() - started;
    }
    blockers = blockersOf(lock) ?? blockers;
  }
  const message = `${sealBlockedMessage(blockers, { describe, companionScript, cwd, waitedMs: waited })} (${error.message})`;
  throw Object.assign(new StateLockTimeout(message, error.reason), { refusal: error.refusal ?? null, blockers });
}
