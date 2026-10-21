#!/usr/bin/env node

import fs from "node:fs";
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

function appendEnvVar(name, value, { allowEmpty = false } = {}) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || (!allowEmpty && value === "")) {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
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
    appendEnvVar("CLAUDE_CODE_SESSION_ID", process.env.CLAUDE_CODE_SESSION_ID);
    appendEnvVar(STATE_LOCK_ADMISSION_ENV, JSON.stringify(published.envelope));
    // Claude records this exact stdout with the observed child exit code.
    // Ready-state alone never authorizes a consumer before that receipt.
    process.stdout.write(`${JSON.stringify({ continue: true, suppressOutput: true,
      hookSpecificOutput: { hookEventName: "SessionStart",
        additionalContext: `Codex Companion session context refreshed at ${new Date().toISOString()}.` },
      codexStateLockAdmission: published.token })}\n`);
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
