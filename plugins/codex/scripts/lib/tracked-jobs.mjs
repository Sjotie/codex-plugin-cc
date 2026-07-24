import fs from "node:fs";
import process from "node:process";

import {
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  updateJobRecord,
  upsertJob,
  writeJobFile
} from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

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

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
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

  upsertJob(job.workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: storedJob.pid ?? null,
    errorMessage: storedJob.errorMessage ?? "Cancelled by user.",
    completedAt: storedJob.completedAt ?? nowIso()
  });
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
    const completedRecord = updateJobRecord(job.workspaceRoot, job.id, (existing) => {
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
        rendered: execution.rendered
      };
    });
    if (completedRecord?.status === "cancelled") {
      settleProcessExitReporter();
      return stopTrackedJobIfCancelled(job, logFile);
    }
    settleProcessExitReporter();
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const cancelledDuringRun = stopTrackedJobIfCancelled(job, logFile);
    if (cancelledDuringRun) {
      settleProcessExitReporter();
      return cancelledDuringRun;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    const failedRecord = updateJobRecord(job.workspaceRoot, job.id, (existing) => {
      if (existing?.status === "cancelled") {
        return null;
      }
      return {
        ...(existing ?? runningRecord),
        status: "failed",
        phase: "failed",
        errorMessage,
        pid: null,
        completedAt,
        logFile: options.logFile ?? job.logFile ?? existing?.logFile ?? null
      };
    });
    if (failedRecord?.status === "cancelled") {
      settleProcessExitReporter();
      return stopTrackedJobIfCancelled(job, logFile);
    }
    settleProcessExitReporter();
    throw error;
  }
}
