import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StateLockTimeout, StateLockUnavailable, openFencedLock } from "./fenced-lock.mjs";
import { isTerminalJobStatus, isWaitingJobStatus } from "./job-status.mjs";
import { isProcessAlive } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const RESUMABLE_TASK_MAX_AGE_ENV = "CODEX_COMPANION_RESUMABLE_TASK_MAX_AGE_MS";
const DEFAULT_RESUMABLE_TASK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const UNREPORTED_PROCESS_EXIT_MESSAGE = "Process exited without reporting.";

const LOCK_NAME = "state.lock";
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_TIMEOUT_MS = 10000;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

// ---------------------------------------------------------------------------
// State lock (#1916): a fence directory on state.lock plus a kernel lock on
// state.lock.db, through the shared fenced-lock module. Old plugin versions
// cannot take or remove the fence; a fence admits new writers only once it is
// sealed (no old plugin process from before the fence still alive).
// ---------------------------------------------------------------------------

const PLUGIN_SCRIPT_RE = /[\\/]scripts[\\/](codex-companion|session-lifecycle-hook|stop-review-gate-hook|app-server-broker)\.mjs$/;
const COMPANION_SCRIPT = fileURLToPath(new URL("../codex-companion.mjs", import.meta.url));

// A plugin process is one whose argv names one of the plugin's scripts (design §5).
export function matchPluginArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const m = PLUGIN_SCRIPT_RE.exec(argv[i]);
    if (m) return { script: `${m[1]}.mjs`, sub: String(argv[i + 1] ?? "").slice(0, 64) || null };
  }
  return null;
}

function stateLockOptions(cwd) {
  return {
    argvMatch: matchPluginArgv,
    // O2 leaves state.lock.<pid>; with two names it reads as "already mine" (design §4.1).
    residueMatch: (name) => /^state\.lock\.[0-9]+$/.test(name),
    // The old broker only imports resolveStateDir from state.mjs (bouwvoorwaarde 4).
    noLockPathScripts: new Set(["app-server-broker.mjs"]),
    deadlineMs: LOCK_TIMEOUT_MS,
    retryMs: LOCK_RETRY_DELAY_MS,
    ownerInfo: () => ({ script: path.basename(process.argv[1] ?? "") }),
    timeoutHint: `see: node "${COMPANION_SCRIPT}" state-lock status --cwd "${cwd}"`,
    fenceReadme: `Do not remove: this is the fence of the Codex plugin state lock (#1916). Status: node "${COMPANION_SCRIPT}" state-lock status --cwd "${cwd}"\n`
  };
}

export function resolveLockPath(cwd) {
  return path.join(resolveStateDir(cwd), LOCK_NAME);
}

export function openStateLock(cwd) {
  return openFencedLock(resolveLockPath(cwd), stateLockOptions(cwd));
}

// For state-lock --all: a state directory found on disk, without a workspace.
export function openStateLockAt(stateDir) {
  return openFencedLock(path.join(stateDir, LOCK_NAME), stateLockOptions(stateDir));
}

// Every directory that can hold state directories: the plugin data dir of
// this process (when set) and the /tmp fallback.
export function resolveStateRoots() {
  const roots = [];
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  if (pluginDataDir) roots.push(path.join(pluginDataDir, "state"));
  roots.push(FALLBACK_STATE_ROOT_DIR);
  return roots;
}

// Diagnosis for state-lock status (design §6.3, §6.5): job files without an
// index entry (orphans, e.g. after a crash between commit and prune), and
// index members whose JSON cannot be read (never pruned).
export function artifactReport(stateDir) {
  const jobsDir = path.join(stateDir, JOBS_DIR_NAME);
  let indexed = [];
  try {
    indexed = JSON.parse(fs.readFileSync(path.join(stateDir, STATE_FILE_NAME), "utf8")).jobs ?? [];
  } catch {
    indexed = [];
  }
  const ids = new Set(indexed.map((job) => job.id));
  let names = [];
  try {
    names = fs.readdirSync(jobsDir);
  } catch {
    names = [];
  }
  const orphans = names.filter((name) => /\.(json|log)$/.test(name) && !ids.has(name.replace(/\.(json|log)$/, "")));
  const unreadable = indexed
    .filter((job) => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(jobsDir, `${job.id}.json`), "utf8"));
        return !record || record.id !== job.id;
      } catch (error) {
        return error?.code !== "ENOENT";
      }
    })
    .map((job) => job.id);
  return { indexed: indexed.length, orphans, unreadable };
}

function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lock = openStateLock(cwd);
  const handle = lock.acquire();
  try {
    return fn({ lock, handle });
  } finally {
    lock.release(handle);
  }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function byNewestFirst(left, right) {
  return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
}

function isResumableTaskJob(job) {
  return job.jobClass === "task" && Boolean(job.threadId) && isTerminalJobStatus(job.status);
}

function resolveResumableTaskMaxAgeMs() {
  const parsed = Number(process.env[RESUMABLE_TASK_MAX_AGE_ENV]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RESUMABLE_TASK_MAX_AGE_MS;
  }
  return Math.max(1, Math.floor(parsed));
}

function isRecentJob(job, nowMs, maxAgeMs) {
  const updatedMs = Date.parse(job.updatedAt ?? "");
  return Number.isFinite(updatedMs) && nowMs - updatedMs < maxAgeMs;
}

function pruneJobs(jobs, protectedByEffective = new Set()) {
  const sorted = [...jobs].sort(byNewestFirst);
  if (sorted.length <= MAX_JOBS) {
    return sorted;
  }

  // Never prune an active job. Also keep the newest resumable task of a
  // session while it is recent: once a session id is set, --resume-last has
  // no fallback, so losing that one job loses the session's thread history.
  // The age limit (CODEX_COMPANION_RESUMABLE_TASK_MAX_AGE_MS, default seven
  // days) stops old sessions from staying in the index forever. Jobs
  // without a session id form one group, matching how they are visible to
  // --resume-last.
  const nowMs = Date.now();
  const maxResumableAgeMs = resolveResumableTaskMaxAgeMs();
  const protectedIds = new Set();
  const sessionsWithResumable = new Set();
  for (const job of sorted) {
    if (isWaitingJobStatus(job.status) || protectedByEffective.has(job.id)) {
      protectedIds.add(job.id);
    }
    const sessionKey = job.sessionId ?? "";
    if (
      !sessionsWithResumable.has(sessionKey) &&
      isResumableTaskJob(job) &&
      isRecentJob(job, nowMs, maxResumableAgeMs)
    ) {
      sessionsWithResumable.add(sessionKey);
      protectedIds.add(job.id);
    }
  }

  const retained = sorted.slice(0, MAX_JOBS);
  const retainedIds = new Set(retained.map((job) => job.id));
  for (const job of sorted) {
    if (!protectedIds.has(job.id) || retainedIds.has(job.id)) {
      continue;
    }
    // Swap the protected job in for the oldest job that is not protected;
    // only when every retained job is protected does the cap give way.
    let displacedIndex = -1;
    for (let index = retained.length - 1; index >= 0; index--) {
      if (!protectedIds.has(retained[index].id)) {
        displacedIndex = index;
        break;
      }
    }
    if (displacedIndex === -1) {
      retained.push(job);
    } else {
      retainedIds.delete(retained[displacedIndex].id);
      retained[displacedIndex] = job;
    }
    retainedIds.add(job.id);
  }
  return retained.sort(byNewestFirst);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// The effective status of an index member (design §6.5): its job JSON when
// that is readable and names the same id, the index copy when there is no
// JSON, and "unknown" otherwise. Unknown members are never pruned.
const EFFECTIVE_FIELDS = ["status", "phase", "pid", "completedAt", "threadId", "turnId", "summary", "errorMessage", "failure"];

function readEffective(cwd, job) {
  let raw;
  try {
    raw = fs.readFileSync(resolveJobFile(cwd, job.id), "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { source: "index" } : { source: "unknown" };
  }
  try {
    const record = JSON.parse(raw);
    if (record && record.id === job.id && typeof record.status === "string") {
      return { source: "json", record };
    }
  } catch {
    // unreadable: unknown
  }
  return { source: "unknown" };
}

// Field values from two separately parsed files: objects (failure) compare by content.
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyEffective(job, effective) {
  if (effective.source !== "json") {
    return job;
  }
  let next = job;
  for (const field of EFFECTIVE_FIELDS) {
    if (Object.hasOwn(effective.record, field) && !sameValue(effective.record[field], job[field])) {
      next = next === job ? { ...job } : next;
      next[field] = effective.record[field];
    }
  }
  return next;
}

function renameUnderLock(tempFile, target, ctx) {
  try {
    ctx.lock.assertOwned(ctx.handle);
    fs.renameSync(tempFile, target);
  } catch (error) {
    fs.rmSync(tempFile, { force: true });
    throw error;
  }
}

/**
 * Internal save; the caller holds the state lock (ctx). Commit before prune
 * (design §6.3): the index is renamed into place first, and only then are the
 * artifacts removed of exactly the jobs the prune dropped from the index read
 * under this lock. A crash in between leaves orphans, never an index entry
 * without its files.
 */
function saveStateLocked(cwd, state, ctx) {
  const current = loadState(cwd);
  ensureStateDir(cwd);
  let jobs = state.jobs ?? [];
  const protectedIds = new Set();
  if (jobs.length > MAX_JOBS) {
    // Only a commit that would prune needs the effective status (§6.5).
    jobs = jobs.map((job) => {
      const effective = readEffective(cwd, job);
      if (effective.source === "unknown") {
        protectedIds.add(job.id);
        return job;
      }
      return applyEffective(job, effective);
    });
  }
  const nextJobs = pruneJobs(jobs, protectedIds);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const stateFile = resolveStateFile(cwd);
  const tempFile = `${stateFile}.tmp.${process.pid}`;
  fs.writeFileSync(tempFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  renameUnderLock(tempFile, stateFile, ctx);

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  const offeredIds = new Set(jobs.map((job) => job.id));
  for (const job of current.jobs) {
    if (retainedIds.has(job.id) || !offeredIds.has(job.id)) {
      continue;
    }
    try {
      removeJobFile(resolveJobFile(cwd, job.id));
      removeFileIfExists(job.logFile);
    } catch (error) {
      process.stderr.write(`state: committed; cleanup failed for job ${job.id} (${error?.code ?? error?.message})\n`);
    }
  }
  return nextState;
}

// Replacing the index with a snapshot read outside the lock loses jobs that
// other writers added meanwhile, so saveState is internal (design §6.4).
// Change the index with updateState, which reads it under the lock.
function saveState(cwd, state) {
  return withStateLock(cwd, (ctx) => saveStateLocked(cwd, state, ctx));
}

// Tests only: write a full index (prune behaviour) under the lock.
export const __saveStateForTest = saveState;

export function updateState(cwd, mutate) {
  return withStateLock(cwd, (ctx) => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateLocked(cwd, state, ctx);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

// indexExtra: fields set on the index entry only, after the record (for the
// index copy of a restored job, which clears completedAt and cancelledAt).
export function updateJobRecord(cwd, jobId, mutate, indexExtra = null) {
  return withStateLock(cwd, (ctx) => {
    const jobFile = resolveJobFile(cwd, jobId);
    let existing = null;
    try {
      existing = readJobFile(jobFile);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    const nextJob = mutate(existing);
    if (nextJob == null) {
      return existing;
    }

    // The job JSON first, then the index (design §6.5).
    writeJobFileLocked(cwd, jobId, nextJob, ctx);
    const state = loadState(cwd);
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobId);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...nextJob,
        ...(indexExtra ?? {})
      });
    } else {
      state.jobs[existingIndex] = {
        ...state.jobs[existingIndex],
        ...nextJob,
        ...(indexExtra ?? {}),
        updatedAt: timestamp
      };
    }
    saveStateLocked(cwd, state, ctx);
    return nextJob;
  });
}

export function assignJobWorkerPid(cwd, jobId, pid) {
  let assigned = false;
  const job = updateJobRecord(cwd, jobId, (existing) => {
    if (!existing || isTerminalJobStatus(existing.status)) {
      return null;
    }
    assigned = true;
    return {
      ...existing,
      status: existing.phase === "spawning" ? "queued" : existing.status,
      phase: existing.phase === "spawning" ? "queued" : existing.phase,
      pid
    };
  });
  return { assigned, job };
}

export function reconcileJobWorkerState(cwd, job) {
  if (
    !isWaitingJobStatus(job.status) ||
    !Number.isInteger(job.pid) ||
    job.pid <= 0 ||
    isProcessAlive(job.pid)
  ) {
    return { outcome: "unchanged", job };
  }

  const jobFile = resolveJobFile(cwd, job.id);
  try {
    const storedJob = readJobFile(jobFile);
    if (isTerminalJobStatus(storedJob.status)) {
      return {
        outcome: "terminal",
        storedJob,
        job: {
          ...job,
          status: storedJob.status,
          phase: storedJob.phase ?? storedJob.status,
          pid: storedJob.pid ?? null,
          completedAt: storedJob.completedAt ?? job.completedAt,
          updatedAt: storedJob.updatedAt ?? storedJob.completedAt ?? job.updatedAt,
          ...(Object.hasOwn(storedJob, "threadId") ? { threadId: storedJob.threadId } : {}),
          ...(Object.hasOwn(storedJob, "turnId") ? { turnId: storedJob.turnId } : {}),
          ...(Object.hasOwn(storedJob, "summary") ? { summary: storedJob.summary } : {}),
          ...(Object.hasOwn(storedJob, "errorMessage") ? { errorMessage: storedJob.errorMessage } : {}),
          ...(Object.hasOwn(storedJob, "failure") ? { failure: storedJob.failure } : {})
        }
      };
    }
  } catch {
    // Fall through: an absent or unreadable job file cannot prove completion.
  }

  const completedAt = nowIso();
  return {
    outcome: "failed",
    job: {
      ...job,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      updatedAt: completedAt,
      errorMessage: UNREPORTED_PROCESS_EXIT_MESSAGE
    }
  };
}

function workerGone(job) {
  return isWaitingJobStatus(job.status) && Number.isInteger(job.pid) && job.pid > 0 && !isProcessAlive(job.pid);
}

// Every member's JSON is read: a file time cannot tell whether the index holds
// it (an unrelated commit makes state.json newer than a lagging job file).
function needsReconcile(cwd, job) {
  if (workerGone(job)) {
    return true;
  }
  const effective = readEffective(cwd, job);
  if (effective.source === "unknown") {
    return false;
  }
  const next = applyEffective(job, effective);
  return next !== job || workerGone(next);
}

// Reconcile under the lock, on the effective status of every member (design
// §6.2, §6.5): a waiting job whose worker is gone becomes failed (JSON first,
// then the index); an index that lags behind its JSON is brought up to date.
function reconcileUnderLock(cwd) {
  return withStateLock(cwd, (ctx) => {
    const state = loadState(cwd);
    state.jobs = state.jobs.map((job) => {
      const effective = readEffective(cwd, job);
      if (effective.source === "unknown") {
        return job;
      }
      let next = applyEffective(job, effective);
      if (workerGone(next)) {
        const completedAt = nowIso();
        const failed = {
          status: "failed",
          phase: "failed",
          pid: null,
          completedAt,
          updatedAt: completedAt,
          errorMessage: UNREPORTED_PROCESS_EXIT_MESSAGE
        };
        if (effective.source === "json") {
          writeJobFileLocked(cwd, job.id, { ...effective.record, ...failed }, ctx);
        }
        next = { ...next, ...failed };
      }
      return next;
    });
    return saveStateLocked(cwd, state, ctx).jobs;
  });
}

export function listJobs(cwd) {
  const state = loadState(cwd);
  // Lock-free first look: only take the lock when something needs a change.
  if (!state.jobs.some((job) => needsReconcile(cwd, job))) {
    return state.jobs;
  }
  try {
    return reconcileUnderLock(cwd);
  } catch (error) {
    if (!(error instanceof StateLockUnavailable || error instanceof StateLockTimeout)) {
      throw error;
    }
    // Reading never depends on the lock: show the effective status of every
    // job without writing, and say why nothing was reconciled.
    process.stderr.write(`state: job list not reconciled (${error.message})\n`);
    return state.jobs.map((job) => {
      const effective = readEffective(cwd, job);
      return effective.source === "unknown" ? job : applyEffective(job, effective);
    });
  }
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

// Job files are read lock-free by concurrent processes (most critically the
// freshly spawned task worker polling every 25ms in waitForStoredJob), so the
// write must be atomic: a plain writeFileSync exposes half-written JSON and a
// reader that catches that window dies on JSON.parse before ever starting the
// job ("Process exited without reporting.", observed 2026-07-29).
export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  const tempFile = `${jobFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, jobFile);
  return jobFile;
}

// The same write for an existing record, under the state lock: the rename
// only happens while this process still owns the lock (design §6.2).
function writeJobFileLocked(cwd, jobId, payload, ctx) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  const tempFile = `${jobFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameUnderLock(tempFile, jobFile, ctx);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
