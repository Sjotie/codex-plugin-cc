import fs from "node:fs";
import process from "node:process";

import { StateLockRefused, StateLockTimeout } from "./fenced-lock.mjs";
import { isTerminalJobStatus } from "./job-status.mjs";
import {
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  updateJobRecord,
  upsertJob
} from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
// How long the final result publication keeps trying while the session
// admission refusal is transient (a SessionStart attempt pending, or its
// receipt not yet recorded), e.g. across a compact. Only that last
// publication waits; every other state write keeps the ordinary deadline.
export const FINAL_PUBLISH_ADMISSION_WAIT_ENV = "CODEX_COMPANION_FINAL_PUBLISH_WAIT_MS";
const DEFAULT_FINAL_PUBLISH_ADMISSION_WAIT_MS = 180_000;
const MAX_FINAL_PUBLISH_ADMISSION_WAIT_MS = 900_000;
const ORDINARY_LOCK_DEADLINE_MS = 10_000;
const LOCK_RETRY_MS = 50;
const ADMISSION_RETRY_MS = 500;

function finalPublishAdmissionWaitMs() {
  const raw = process.env[FINAL_PUBLISH_ADMISSION_WAIT_ENV];
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, MAX_FINAL_PUBLISH_ADMISSION_WAIT_MS) : DEFAULT_FINAL_PUBLISH_ADMISSION_WAIT_MS;
}

// The result is already in the job log. Each try is one complete lock
// attempt (everything validated again under the authority); between tries
// the event loop runs, so signals are handled. A definitive refusal stops at
// once; a transient one keeps trying up to the wait above, anything else up
// to the ordinary deadline.
async function publishFinal(logFile, publish) {
  const waitMs = finalPublishAdmissionWaitMs();
  const start = performance.now();
  for (;;) {
    try {
      return publish({ deadlineMs: 0 });
    } catch (error) {
      const elapsed = performance.now() - start;
      const lockWait = error instanceof StateLockTimeout && !(error instanceof StateLockRefused);
      if (lockWait && (elapsed < ORDINARY_LOCK_DEADLINE_MS || (error.refusal === "transient" && elapsed < waitMs))) {
        await new Promise((resolve) => setTimeout(resolve, elapsed < ORDINARY_LOCK_DEADLINE_MS ? LOCK_RETRY_MS : ADMISSION_RETRY_MS));
        continue;
      }
      appendLogLine(logFile, `The result above was not published to the job record: ${error instanceof Error ? error.message : String(error)}`);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { finalPublicationFailed: true });
    }
  }
}

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    // Write the job file and the index in one locked transaction: an
    // unlocked rewrite can overwrite a concurrent terminal or cancellation
    // update with the stale copy it read before that update landed.
    updateJobRecord(workspaceRoot, jobId, (existing) => {
      if (!existing || isTerminalJobStatus(existing.status)) {
        return null;
      }
      return {
        ...existing,
        ...patch
      };
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function stopTrackedJobIfCancelled(job, logFile) {
  const storedJob = readStoredJobOrNull(job.workspaceRoot, job.id);
  if (storedJob?.status !== "cancelled") {
    return null;
  }

  // Failure metadata from an earlier attempt of this job does not describe the cancelled run.
  const staleFailure = Boolean(storedJob.failure);
  const errorMessage = staleFailure ? "Cancelled by user." : (storedJob.errorMessage ?? "Cancelled by user.");
  upsertJob(job.workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: storedJob.pid ?? null,
    failure: null,
    errorMessage,
    completedAt: storedJob.completedAt ?? nowIso()
  });
  if (staleFailure) {
    updateJobRecord(job.workspaceRoot, job.id, (existing) =>
      existing?.status === "cancelled" ? { ...existing, failure: null, errorMessage } : null
    );
  }
  appendLogLine(logFile, "Stopped after cancellation.");
  return {
    exitStatus: 0,
    threadId: storedJob.threadId ?? null,
    turnId: storedJob.turnId ?? null,
    payload: { status: "cancelled" },
    rendered: "",
    summary: storedJob.summary ?? "Cancelled by user."
  };
}

function persistUnexpectedProcessExit(job, logFile, errorMessage) {
  try {
    let persisted = false;
    updateJobRecord(job.workspaceRoot, job.id, (existing) => {
      if (existing && ["completed", "failed", "error", "cancelled"].includes(existing.status)) {
        return null;
      }
      persisted = true;
      return {
        ...(existing ?? job),
        status: "failed",
        phase: "failed",
        pid: null,
        completedAt: nowIso(),
        errorMessage,
        logFile: logFile ?? existing?.logFile ?? job.logFile ?? null
      };
    });
    if (persisted) {
      appendLogLine(logFile, errorMessage);
    }
  } catch {
    // Exit reporting is best-effort. Dead-worker reconciliation remains the
    // fail-safe when the process cannot persist its own terminal record.
  }
}

function installProcessExitReporter(job, logFile) {
  let settled = false;
  const signalHandlers = new Map();

  const report = (errorMessage) => {
    if (settled) {
      return;
    }
    settled = true;
    persistUnexpectedProcessExit(job, logFile, errorMessage);
  };

  const onExit = (code) => {
    report(`Codex companion process exited with code ${code} before reporting a terminal result.`);
  };
  process.once("exit", onExit);

  for (const [signal, exitCode] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143]
  ]) {
    const handler = () => {
      report(`Codex companion process received ${signal} before reporting a terminal result.`);
      process.exit(exitCode);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  return () => {
    settled = true;
    process.removeListener("exit", onExit);
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  };
}

export async function runTrackedJob(job, runner, options = {}) {
  const logFile = options.logFile ?? job.logFile ?? null;
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile
  };
  const settleProcessExitReporter = installProcessExitReporter(job, logFile);
  const storedAtStart = updateJobRecord(job.workspaceRoot, job.id, (existing) => {
    if (existing?.status === "cancelled") {
      return null;
    }
    return {
      ...existing,
      ...runningRecord
    };
  });
  if (storedAtStart?.status === "cancelled") {
    settleProcessExitReporter();
    return stopTrackedJobIfCancelled(job, logFile);
  }

  try {
    const execution = await runner();
    const cancelledDuringRun = stopTrackedJobIfCancelled(job, logFile);
    if (cancelledDuringRun) {
      settleProcessExitReporter();
      return cancelledDuringRun;
    }
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    // Log first: a publication refused by the state lock must not lose the result.
    appendLogBlock(logFile, "Final output", execution.rendered);
    const completedRecord = await publishFinal(logFile, (lockOptions) => updateJobRecord(job.workspaceRoot, job.id, (existing) => {
      if (existing?.status === "cancelled") {
        return null;
      }
      return {
        ...runningRecord,
        ...existing,
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: execution.summary ?? existing?.summary ?? runningRecord.summary,
        pid: null,
        phase: completionStatus === "completed" ? "done" : "failed",
        completedAt,
        result: execution.payload,
        rendered: execution.rendered,
        // Explicit values so a failure from an earlier attempt of this job never survives a later result.
        failure: execution.failure ?? null,
        errorMessage: execution.failure ? (execution.failure.message ?? null) : null
      };
    }, null, lockOptions));
    if (completedRecord?.status === "cancelled") {
      settleProcessExitReporter();
      return stopTrackedJobIfCancelled(job, logFile);
    }
    settleProcessExitReporter();
    return execution;
  } catch (error) {
    // The result could not be published: do not wait a second time to
    // publish a failure over it. The log keeps the result. After a timeout
    // the exit reporter still makes its ordinary attempt to mark the job
    // failed; after a definitive refusal no write of this process can pass.
    if (error?.finalPublicationFailed) {
      if (error instanceof StateLockRefused) settleProcessExitReporter();
      throw error;
    }
    const cancelledDuringRun = stopTrackedJobIfCancelled(job, logFile);
    if (cancelledDuringRun) {
      settleProcessExitReporter();
      return cancelledDuringRun;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    appendLogLine(logFile, `Failed: ${errorMessage}`);
    const failedRecord = await publishFinal(logFile, (lockOptions) => updateJobRecord(job.workspaceRoot, job.id, (existing) => {
      if (existing?.status === "cancelled") {
        return null;
      }
      return {
        ...(existing ?? runningRecord),
        status: "failed",
        phase: "failed",
        errorMessage,
        failure: { class: "runner_error", classifiedFrom: "exception", type: error?.name ?? null, code: error?.code == null ? null : String(error.code), message: errorMessage, details: null, turnStatus: null },
        pid: null,
        completedAt,
        logFile: options.logFile ?? job.logFile ?? existing?.logFile ?? null
      };
    }, null, lockOptions));
    if (failedRecord?.status === "cancelled") {
      settleProcessExitReporter();
      return stopTrackedJobIfCancelled(job, logFile);
    }
    settleProcessExitReporter();
    throw error;
  }
}
