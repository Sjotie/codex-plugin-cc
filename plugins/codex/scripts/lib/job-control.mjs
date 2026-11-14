import fs from "node:fs";
import path from "node:path";

import { getSessionRuntimeStatus } from "./codex.mjs";
import { isFailedJobStatus, isTerminalJobStatus, isWaitingJobStatus } from "./job-status.mjs";
import { isProcessAlive } from "./process.mjs";
import {
  getConfig,
  listJobs,
  readJobFile,
  reconcileJobWorkerState,
  resolveJobFile,
  resolveStateRoots,
  resolveStateDir,
  applyEffective,
  updateJobRecord,
  upsertJob
} from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 1000;
const DEFAULT_WAIT_REGISTRATION_GRACE_MS = 2000;
export const CANCELLATION_TERMINATION_FAILED_MESSAGE =
  "Cancellation requested but process termination failed; retry /codex:cancel.";

function validateExactJobId(jobId) {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(jobId)) {
    throw new Error(`Invalid job id "${jobId}".`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "error":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      isWaitingJobStatus(job.status) || isFailedJobStatus(job.status)
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      isTerminalJobStatus(job.status)
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  try {
    return readJobFile(jobFile);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    // A malformed job file is transient by contract now that writes are
    // atomic; treat it like "not yet readable" so pollers retry instead of
    // crashing the process that happened to catch a bad read.
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function hydrateIndexedJob(workspaceRoot, indexedJob) {
  try {
    const storedJob = readStoredJob(workspaceRoot, indexedJob.id);
    return storedJob ? { ...indexedJob, ...storedJob } : indexedJob;
  } catch {
    return indexedJob;
  }
}

function hydrateIndexedJobs(workspaceRoot, jobs) {
  return jobs.map((job) => hydrateIndexedJob(workspaceRoot, job));
}

export async function waitForTerminalJob(workspaceRoot, jobId, options = {}) {
  validateExactJobId(jobId);
  const timeoutMs = options.timeoutMs == null ? null : Math.max(0, Number(options.timeoutMs));
  const pollIntervalMs = Math.max(10, Number(options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS));
  const registrationGraceMs = Math.max(
    0,
    Number(options.registrationGraceMs ?? DEFAULT_WAIT_REGISTRATION_GRACE_MS)
  );
  if (
    (timeoutMs != null && !Number.isFinite(timeoutMs)) ||
    !Number.isFinite(pollIntervalMs) ||
    !Number.isFinite(registrationGraceMs)
  ) {
    throw new Error("Wait timing options must be finite non-negative numbers.");
  }
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  const deadline = timeoutMs == null ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  let missingSince = Date.now();
  let lastJob = null;
  let lastReadError = null;

  while (true) {
    try {
      let storedJob;
      try {
        storedJob = readJobFile(jobFile);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        storedJob = null;
      }
      if (storedJob) {
        const reconciliation = reconcileJobWorkerState(workspaceRoot, storedJob);
        if (reconciliation.outcome === "failed") {
          // Re-check under the lock: a cancel or the worker's own final record
          // may have landed since this read (design §6.2, A4).
          const failedRecord = reconciliation.job;
          const stalePid = storedJob.pid;
          storedJob = updateJobRecord(workspaceRoot, jobId, (existing) => {
            if (!existing || !isWaitingJobStatus(existing.status)) {
              return null;
            }
            // Only the same dead worker: a re-queued or respawned job keeps its record.
            if (existing.pid !== stalePid || isProcessAlive(existing.pid)) {
              return null;
            }
            return { ...existing, ...failedRecord };
          }) ?? storedJob;
        } else if (reconciliation.outcome === "terminal") {
          storedJob = reconciliation.storedJob;
          upsertJob(workspaceRoot, reconciliation.job);
        }
        lastJob = storedJob;
        lastReadError = null;
        missingSince = null;

        if (isTerminalJobStatus(storedJob.status)) {
          if (
            storedJob.status === "cancelled" &&
            Number.isInteger(storedJob.pid) &&
            storedJob.pid > 0 &&
            isProcessAlive(storedJob.pid)
          ) {
            // Cancellation is written before process termination. Wait until
            // it settles to pid:null or rolls back to a waiting status.
          } else {
            return { outcome: "terminal", job: storedJob };
          }
        } else if (!isWaitingJobStatus(storedJob.status)) {
          return { outcome: "invalid-status", job: storedJob };
        }
      } else if (missingSince == null) {
        missingSince = Date.now();
      }
    } catch (error) {
      lastReadError = error;
      if (missingSince == null) {
        missingSince = Date.now();
      }
    }

    const now = Date.now();
    if (missingSince != null && now - missingSince >= registrationGraceMs) {
      return {
        outcome: lastReadError ? "unreadable" : "not-found",
        job: lastJob,
        error: lastReadError
      };
    }
    if (now >= deadline) {
      return { outcome: "timeout", job: lastJob, timeoutMs };
    }

    const nextDeadline = Math.min(
      deadline,
      missingSince == null ? Number.POSITIVE_INFINITY : missingSince + registrationGraceMs
    );
    await sleep(Math.min(pollIntervalMs, Math.max(0, nextDeadline - now)));
  }
}

export function settleCancellationAfterTermination(
  workspaceRoot,
  job,
  existing,
  termination,
  terminationError = null,
  options = {}
) {
  const terminationFailed = Boolean(terminationError) || termination?.delivered !== true;
  const pid = job.pid ?? null;
  const isProcessAliveImpl = options.isProcessAliveImpl ?? isProcessAlive;

  if (!terminationFailed || !Number.isInteger(pid) || pid <= 0 || !isProcessAliveImpl(pid)) {
    return { processStopped: true, job: null, error: null };
  }

  const restoredJob = {
    ...existing,
    ...job,
    status: job.status,
    phase: job.phase ?? existing.phase ?? job.status,
    pid,
    errorMessage: CANCELLATION_TERMINATION_FAILED_MESSAGE
  };
  // JSON and index in one locked update, JSON first (design §6.2, A7).
  updateJobRecord(workspaceRoot, job.id, () => restoredJob, {
    completedAt: job.completedAt ?? null,
    cancelledAt: job.cancelledAt ?? null
  });

  return {
    processStopped: false,
    job: restoredJob,
    error: terminationError ?? new Error(CANCELLATION_TERMINATION_FAILED_MESSAGE)
  };
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(
    filterJobsForCurrentSession(hydrateIndexedJobs(workspaceRoot, listJobs(workspaceRoot)), options)
  );
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => isWaitingJobStatus(job.status))
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => isTerminalJobStatus(job.status)) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => isTerminalJobStatus(job.status) && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(hydrateIndexedJobs(workspaceRoot, listJobs(workspaceRoot)));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const hydratedJobs = hydrateIndexedJobs(workspaceRoot, listJobs(workspaceRoot));
  const jobs = sortJobsNewestFirst(reference ? hydratedJobs : filterJobsForCurrentSession(hydratedJobs));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => isTerminalJobStatus(job.status)
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => isWaitingJobStatus(job.status));
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => isWaitingJobStatus(job.status));

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}

// Bounds of the lookup below: it runs while an error is being reported and must stay quick.
const JOB_LOOKUP_MAX_STATE_DIRS = 2000;
const JOB_LOOKUP_MAX_FILE_BYTES = 1024 * 1024;

// Reads a job file without following symlinks and without blocking on special files. Returns the
// parsed JSON, or null when it is not a small regular file of the current user.
function readJobFileStrict(file, uid) {
  let fd;
  try {
    // O_NONBLOCK keeps open() from waiting on a FIFO; O_NOFOLLOW refuses a symlink as last component.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > JOB_LOOKUP_MAX_FILE_BYTES || (uid !== null && stat.uid !== uid)) return null;
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing to release.
      }
    }
  }
}

// Where state holds a job file for this id: { workspaceRoot, stateDir } per hit. Job state is kept
// per workspace root, so a lookup from another working directory finds nothing even while the job
// runs. Read-only (no lock). It looks only at real (non-symlink) state directories and a real
// jobs/ directory owned by the current user, reads only small regular job files, looks at no more
// than JOB_LOOKUP_MAX_STATE_DIRS directories, and ignores anything it cannot read. Never throws:
// it runs while an error is being reported.
export function findJobLocations(jobId) {
  const found = [];
  try {
    validateExactJobId(jobId);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    let looked = 0;
    for (const root of resolveStateRoots()) {
      let entries;
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue; // a symlink to a directory is not a directory here
        if (++looked > JOB_LOOKUP_MAX_STATE_DIRS) return found;
        const stateDir = path.join(root, entry.name);
        try {
          const stateStat = fs.lstatSync(stateDir);
          const jobsStat = fs.lstatSync(path.join(stateDir, "jobs"));
          if (!stateStat.isDirectory() || !jobsStat.isDirectory()) continue;
          if (uid !== null && (stateStat.uid !== uid || jobsStat.uid !== uid)) continue;
        } catch {
          continue;
        }
        const job = readJobFileStrict(path.join(stateDir, "jobs", `${jobId}.json`), uid);
        if (typeof job?.workspaceRoot === "string" && job.workspaceRoot) {
          found.push({ workspaceRoot: job.workspaceRoot, stateDir });
        }
      }
    }
  } catch {
    return [];
  }
  return found;
}

// Looser than the single-job lookup: this scan decides which thread to resume, and an
// incomplete scan refuses the automatic choice, so it must cover a long-lived host's dirs.
const SIBLING_SCAN_MAX_STATE_DIRS = 20000;

// #4212: state lives per workspace root, but one Claude session can work from several roots
// (a fresh workroot per review round). The job records of this session in the other roots'
// state dirs, so --resume-last can find a thread a sibling root holds. Same checks as
// findJobLocations (real state and jobs/ directories of the current user, small regular
// files, no locks, no writes); newest state dirs first, at most JOB_LOOKUP_MAX_STATE_DIRS of
// them, and `incomplete` says when dirs were left out or unreadable. Each index entry is overlaid
// with its job file like the own root's listing does, so a lagging index does not hide a
// finished task; a job file of another session or job is ignored. Never throws.
export function listSessionJobsInOtherWorkspaces(cwd, sessionId, options = {}) {
  const maxDirs = options.maxStateDirs ?? SIBLING_SCAN_MAX_STATE_DIRS;
  const result = { jobs: [], incomplete: false };
  if (!sessionId) return result;
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    let ownDir = null;
    try {
      ownDir = fs.realpathSync(resolveStateDir(cwd));
    } catch {
      // No own state dir yet: nothing to exclude.
    }
    // One lstat per directory entry orders them by recent activity; the rest of the checks
    // run only for the newest maxDirs. Anything the scan cannot read or does not reach makes
    // it incomplete, so the caller can refuse an automatic choice instead of guessing.
    const dirs = [];
    for (const root of resolveStateRoots()) {
      let entries;
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const stateDir = path.join(root, entry.name);
        try {
          const stat = fs.lstatSync(stateDir);
          if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) continue;
          dirs.push({ stateDir, mtimeMs: stat.mtimeMs });
        } catch {
          continue;
        }
      }
    }
    dirs.sort((left, right) => right.mtimeMs - left.mtimeMs);
    result.incomplete = dirs.length > maxDirs;
    for (const { stateDir } of dirs.slice(0, maxDirs)) {
      try {
        const jobsStat = fs.lstatSync(path.join(stateDir, "jobs"));
        if (!jobsStat.isDirectory() || (uid !== null && jobsStat.uid !== uid)) continue;
        if (ownDir !== null && fs.realpathSync(stateDir) === ownDir) continue;
        fs.lstatSync(path.join(stateDir, "state.json"));
      } catch {
        continue; // not a workspace state dir
      }
      const index = readJobFileStrict(path.join(stateDir, "state.json"), uid);
      if (index === null || typeof index !== "object") {
        result.incomplete = true; // a state dir we could not read may hold a running or newer task
        continue;
      }
      for (const job of Array.isArray(index.jobs) ? index.jobs : []) {
        if (job?.sessionId !== sessionId || typeof job.id !== "string") continue;
        const record = /^[A-Za-z0-9._-]+$/.test(job.id)
          ? readJobFileStrict(path.join(stateDir, "jobs", `${job.id}.json`), uid)
          : null;
        const sameJob = record && record.id === job.id && record.sessionId === sessionId && record.jobClass === job.jobClass;
        result.jobs.push(sameJob ? applyEffective(job, { source: "json", record }) : job);
      }
    }
  } catch {
    result.incomplete = true;
  }
  return result;
}

// Why a resume is refused while a task of this Claude session still runs, and how to go on.
export function describeRunningTaskBlock(taskId, workspaceRoot) {
  // "${CLAUDE_PLUGIN_ROOT}" stays literal: it is shell text for the reader to run, not a value to fill in here.
  const companion = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs"';
  return (
    `Task ${taskId} is still running. A running task of this Claude session blocks resuming; ` +
    `wait for it with \`${companion} wait ${taskId} --timeout 480\` (run from ${workspaceRoot}) or stop it ` +
    `with \`${companion} cancel ${taskId}\` (/codex:cancel ${taskId}), then resume. /codex:status shows its progress.`
  );
}
