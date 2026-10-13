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
import { loadState, readJobFile, resolveJobFile, resolveStateFile, updateState, writeJobFile } from "./lib/state.mjs";
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

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

const SESSION_ENDED_MESSAGE = "Stopped because the Claude session ended.";

// The worker of an ending job may already have written its terminal result to
// the job file; otherwise the job is stopped here and recorded as cancelled.
function endedJobRecord(workspaceRoot, job, endedAt) {
  let storedJob = {};
  try {
    storedJob = readJobFile(resolveJobFile(workspaceRoot, job.id));
  } catch {
    // An absent or unreadable job file leaves the index entry as the only record.
  }
  if (isTerminalJobStatus(storedJob.status)) {
    return { ...job, ...storedJob };
  }
  return {
    ...storedJob,
    ...job,
    threadId: job.threadId ?? storedJob.threadId ?? null,
    turnId: job.turnId ?? storedJob.turnId ?? null,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt: endedAt,
    updatedAt: endedAt,
    errorMessage: SESSION_ENDED_MESSAGE
  };
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
  // needs the thread ids for --resume-last (#1576).
  const isEndingJob = (job) => job.sessionId === sessionId && isWaitingJobStatus(job.status);
  const endingJobs = loadState(workspaceRoot).jobs.filter(isEndingJob);
  if (endingJobs.length === 0) {
    return;
  }

  for (const job of endingJobs) {
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  // Use updateState so the read-modify-write is atomic under the state lock.
  // This prevents a concurrent upsertJob from being silently dropped (and its
  // artifacts deleted) when the stale snapshot loaded above is saved back.
  const endedAt = new Date().toISOString();
  const endedJobs = [];
  updateState(workspaceRoot, (currentState) => {
    currentState.jobs = currentState.jobs.map((job) => {
      if (!isEndingJob(job)) {
        return job;
      }
      const endedJob = endedJobRecord(workspaceRoot, job, endedAt);
      endedJobs.push(endedJob);
      return endedJob;
    });
  });
  for (const job of endedJobs) {
    if (job.errorMessage !== SESSION_ENDED_MESSAGE) {
      continue;
    }
    try {
      writeJobFile(workspaceRoot, job.id, job);
    } catch {
      // The index entry above already records the cancellation.
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

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
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
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
