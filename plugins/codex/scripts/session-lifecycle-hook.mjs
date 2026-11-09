#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { isTerminalJobStatus, isWaitingJobStatus } from "./lib/job-status.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  BROKER_SHUTDOWN_ACCEPTED,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { loadState, beginSessionStateLockStart, completeSessionStateLockStart, activateFixedHookAdmission, completeFixedSessionEndAdmission, resolveStateFile, STATE_LOCK_ADMISSION_ENV, updateJobRecord } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { unprovenRunningVersionNotice } from "./lib/session-admission.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

let envFileTmpSeq = 0;
const ENV_LOCK_WAIT_MS = 2000;
const ENV_LOCK_RETRY_MS = 5;
const ENV_LOCK_MAX_AGE_MS = 30000;
const WIN32_RENAME_RETRIES = 3;
const WIN32_RENAME_BACKOFF_MS = 10;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveEnvFileTarget(envFile) {
  try {
    const lstat = fs.lstatSync(envFile);
    if (lstat.isDirectory()) {
      fs.readFileSync(envFile, "utf8");
    }
    if (!lstat.isSymbolicLink()) {
      return envFile;
    }
    try {
      return fs.realpathSync(envFile);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      return path.resolve(path.dirname(envFile), fs.readlinkSync(envFile));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return envFile;
  }
}

function isLockHolderAlive(lockFile) {
  let stat;
  let raw = "";
  try {
    stat = fs.statSync(lockFile);
    if (Date.now() - stat.mtimeMs > ENV_LOCK_MAX_AGE_MS) {
      return false;
    }
    raw = fs.readFileSync(lockFile, "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    return true;
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return Date.now() - stat.mtimeMs < 100;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function evictStaleLock(lockFile) {
  const claimFile = `${lockFile}.stale.${process.pid}.${++envFileTmpSeq}`;
  try {
    fs.renameSync(lockFile, claimFile);
  } catch {
    return false;
  }
  if (isLockHolderAlive(claimFile)) {
    try {
      fs.renameSync(claimFile, lockFile);
    } catch {
      try {
        fs.unlinkSync(claimFile);
      } catch {
        // Ignore cleanup errors.
      }
    }
    return false;
  }
  try {
    fs.unlinkSync(claimFile);
  } catch {
    // Ignore cleanup errors.
  }
  return true;
}

function withEnvFileLock(targetFile, fn) {
  const lockFile = `${targetFile}.lock`;
  const ownerContent = `${process.pid}\n`;
  const deadline = Date.now() + ENV_LOCK_WAIT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      fs.writeFileSync(lockFile, ownerContent, { encoding: "utf8", flag: "wx" });
      if (fs.readFileSync(lockFile, "utf8") === ownerContent) {
        acquired = true;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (!isLockHolderAlive(lockFile) && evictStaleLock(lockFile)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw error;
      }
      sleepMs(ENV_LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lockFile, "utf8") === ownerContent) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // Ignore cleanup errors if the lock file was already removed.
    }
  }
}

function commitEnvFile(tmpFile, targetFile, content, mode) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmpFile, targetFile);
      return;
    } catch (error) {
      const transientWin32 =
        process.platform === "win32" &&
        (error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES");
      if (!transientWin32) {
        throw error;
      }
      if (attempt < WIN32_RENAME_RETRIES) {
        sleepMs(WIN32_RENAME_BACKOFF_MS * (attempt + 1));
        continue;
      }
      fs.writeFileSync(targetFile, content, { encoding: "utf8", ...(mode !== null ? { mode } : {}) });
      if (mode !== null) {
        fs.chmodSync(targetFile, mode);
      }
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore temp cleanup failure after in-place fallback.
      }
      return;
    }
  }
}

function appendEnvVar(name, value, { allowEmpty = false } = {}) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile || value == null || (!allowEmpty && value === "")) {
    return;
  }

  const targetFile = resolveEnvFileTarget(envFile);
  withEnvFileLock(targetFile, () => {
    let existing = "";
    let mode = null;
    try {
      const stat = fs.statSync(targetFile);
      mode = stat.mode & 0o7777;
      existing = fs.readFileSync(targetFile, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    const lines = existing === "" ? [] : existing.split("\n");
    if (lines.length > 0 && lines.at(-1) === "") {
      lines.pop();
    }

    const prefix = `export ${name}=`;
    const nextLine = `${prefix}${shellEscape(value)}`;
    let replaced = false;
    const updated = [];
    for (const line of lines) {
      if (line.startsWith(prefix)) {
        if (!replaced) {
          updated.push(nextLine);
          replaced = true;
        }
      } else {
        updated.push(line);
      }
    }
    if (!replaced) {
      updated.push(nextLine);
    }

    const content = `${updated.join("\n")}\n`;
    const tmpFile = path.join(
      path.dirname(targetFile),
      `.${path.basename(targetFile)}.${process.pid}.${++envFileTmpSeq}.tmp`
    );
    try {
      fs.writeFileSync(tmpFile, content, { encoding: "utf8", ...(mode !== null ? { mode } : {}) });
      if (mode !== null) {
        fs.chmodSync(tmpFile, mode);
      }
      commitEnvFile(tmpFile, targetFile, content, mode);
    } catch (error) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors after a failed write or rename.
      }
      throw error;
    }
  });
}

const SESSION_ENDED_MESSAGE = "Stopped because the Claude session ended.";

// Records an ending job as cancelled in its job file and the index together,
// under the state lock, the same way workers publish their own results. A job
// whose worker already wrote a terminal result keeps it. Returns the pid to stop.
function endSessionJob(workspaceRoot, jobId) {
  let pid = null;
  updateJobRecord(workspaceRoot, jobId, (stored) => {
    if (isTerminalJobStatus(stored?.status)) {
      return stored;
    }
    // Read the index under the same lock: a worker may have published its
    // thread id there after the snapshot and before writing its job file.
    const indexed = loadState(workspaceRoot).jobs.find((job) => job.id === jobId) ?? {};
    pid = stored?.pid ?? indexed.pid ?? null;
    const endedAt = new Date().toISOString();
    return {
      ...indexed,
      ...stored,
      threadId: indexed.threadId ?? stored?.threadId ?? null,
      turnId: indexed.turnId ?? stored?.turnId ?? null,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt: endedAt,
      errorMessage: SESSION_ENDED_MESSAGE
    };
  });
  return pid;
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  // The session's queued and running jobs end with it, but every job keeps its
  // record: a session resumed under the same id (e.g. after a host restart)
  // needs the thread ids for --resume-last (#1576). Cancel first, then stop the
  // worker, so a queued worker that starts in between sees the cancellation.
  const endingJobs = loadState(workspaceRoot).jobs.filter(
    (job) => job.sessionId === sessionId && isWaitingJobStatus(job.status)
  );
  for (const job of endingJobs) {
    let pid = job.pid ?? null;
    try {
      pid = endSessionJob(workspaceRoot, job.id);
    } catch (error) {
      // No persisted cancellation means no process signal or broker teardown.
      // In particular a revoked/unreadable admission aborts this hook.
      throw error;
    }
    try {
      terminateProcessTree(pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }
}

function hasActiveJobFromAnotherSession(cwd, sessionId) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return false;
  }

  return loadState(workspaceRoot).jobs.some(
    (job) =>
      isWaitingJobStatus(job.status) &&
      (!sessionId || !job.sessionId || job.sessionId !== sessionId)
  );
}

function clearSessionAdmission() {
  // Clear a previous attempt before any proof work. If preparation throws or
  // crashes, sourcing this file grants no permission, even on resume.
  if (process.platform === "darwin") {
    if (!process.env.CLAUDE_ENV_FILE) throw new Error("SessionStart has no environment file; state writes refused");
    appendEnvVar(STATE_LOCK_ADMISSION_ENV, "", { allowEmpty: true });
  }
}

function handleSessionStart(input, started) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  if (process.platform === "darwin") {
    // Compact keeps the capability C, so its envelope is the one Bash already
    // holds; every other source exports a new C. The attempt T is ready now.
    const published = completeSessionStateLockStart(input.cwd, input.session_id, input, started);
    // Claude records this exact stdout with the observed child exit code.
    // Ready-state alone never authorizes a consumer before that receipt.
    // Written before the exports: if they fail, the failed receipt carries
    // this attempt's token, so waiting holders of C stop at once.
    // An unproven running version cannot be admitted later anyway; say so now
    // to the user and the agent instead of only at the first refused write.
    // The proven route keeps its measured output unchanged.
    // Claude records a systemMessage as its own hook_system_message record
    // (measured on 2.1.308); the receipt check then refuses at once instead
    // of waiting, which is right: the notice only appears when it would
    // refuse anyway (unproven version or broken manifest).
    // Once per new capability: a compact keeps C and would only repeat it.
    const notice = input.source === "compact" ? null : unprovenRunningVersionNotice();
    const context = `Codex Companion session context refreshed at ${new Date().toISOString()}.`;
    process.stdout.write(`${JSON.stringify({ continue: true, suppressOutput: true,
      ...(notice ? { systemMessage: notice } : {}),
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: notice ? `${context}\n${notice}` : context },
      codexStateLockAdmission: published.token })}\n`);
    appendEnvVar("CLAUDE_CODE_SESSION_ID", process.env.CLAUDE_CODE_SESSION_ID);
    appendEnvVar(STATE_LOCK_ADMISSION_ENV, JSON.stringify(published.envelope));
  }
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;

  cleanupSessionJobs(cwd, sessionId);
  if (!brokerEndpoint || hasActiveJobFromAnotherSession(cwd, sessionId)) {
    return;
  }

  const shutdownOutcome = await sendBrokerShutdown(brokerEndpoint);
  if (shutdownOutcome !== BROKER_SHUTDOWN_ACCEPTED) {
    return;
  }

  // A new broker may replace broker.json after the old listener closes.
  // Remove only resources captured from the broker that accepted shutdown.
  teardownBrokerSession({
    ...brokerSession,
    endpoint: brokerEndpoint,
    killProcess: terminateProcessTree
  });
}

async function main() {
  // The registered hook names its event in argv, so even malformed stdin
  // invalidates an earlier export before JSON parsing can fail.
  let started = null;
  if (process.argv[2] === "SessionStart") {
    started = beginSessionStateLockStart();
    clearSessionAdmission();
  }
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    if (process.argv[2] !== "SessionStart") throw new Error("SessionStart requires its fixed registered command");
    handleSessionStart(input, started);
    return;
  }

  if (eventName === "SessionEnd") {
    const admission = activateFixedHookAdmission(input, "SessionEnd");
    await handleSessionEnd(input);
    completeFixedSessionEndAdmission(admission);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
