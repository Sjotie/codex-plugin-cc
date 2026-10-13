import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  reconcileJobWorkerState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

// Never let these tests write into a real plugin data dir when the shell
// happens to have CLAUDE_PLUGIN_DATA set.
process.env.CLAUDE_PLUGIN_DATA = makeTempDir("codex-plugin-data-");

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("dead-worker reconciliation preserves the complete canonical terminal job", () => {
  const workspace = makeTempDir();
  const jobId = "task-terminal-race";
  const terminalJob = {
    id: jobId,
    status: "completed",
    phase: "done",
    pid: null,
    completedAt: "2026-07-20T15:00:00.000Z",
    result: { rawOutput: "Preserve this result." },
    rendered: "Preserve this result.\n"
  };
  writeJobFile(workspace, jobId, terminalJob);

  const reconciliation = reconcileJobWorkerState(workspace, {
    id: jobId,
    status: "running",
    phase: "verifying",
    pid: 2_147_483_647
  });

  assert.equal(reconciliation.outcome, "terminal");
  assert.deepEqual(reconciliation.storedJob, terminalJob);
  assert.equal(reconciliation.job.status, "completed");
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("saveState keeps the newest resumable task per session and active jobs when pruning", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const now = Date.now();
  const at = (minutes) => new Date(now - (70 - minutes) * 60_000).toISOString();
  const makeJob = (job) => {
    const logFile = resolveJobLogFile(workspace, job.id);
    const jobFile = resolveJobFile(workspace, job.id);
    fs.writeFileSync(logFile, `log ${job.id}\n`, "utf8");
    fs.writeFileSync(jobFile, `${JSON.stringify({ id: job.id, status: job.status })}\n`, "utf8");
    return { createdAt: job.updatedAt, logFile, ...job };
  };

  // Oldest: an even older resumable task from the stale session (only the
  // newest resumable task per session is protected), then the stale
  // session's newest resumable task and an active job from another session.
  const jobs = [
    makeJob({
      id: "task-stale-older",
      jobClass: "task",
      status: "completed",
      sessionId: "sess-stale",
      threadId: "thr_stale_older",
      updatedAt: at(0)
    }),
    makeJob({
      id: "task-stale",
      jobClass: "task",
      status: "completed",
      sessionId: "sess-stale",
      threadId: "thr_stale",
      updatedAt: at(1)
    }),
    makeJob({
      id: "task-active",
      jobClass: "task",
      status: "running",
      sessionId: "sess-active",
      updatedAt: at(2)
    }),
    // 51 newer jobs from other sessions fill the cap on their own.
    ...Array.from({ length: 51 }, (_, index) =>
      makeJob({
        id: `job-new-${index}`,
        jobClass: "task",
        status: "completed",
        sessionId: "sess-busy",
        updatedAt: at(10 + index)
      })
    )
  ];

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`,
    "utf8"
  );

  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs });

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const savedIds = new Set(savedState.jobs.map((job) => job.id));
  assert.equal(savedState.jobs.length, 50, "the overall cap still applies");
  assert.equal(savedIds.has("task-stale"), true, "newest resumable task per session survives");
  assert.equal(savedIds.has("task-active"), true, "an active job survives");
  assert.equal(savedIds.has("task-stale-older"), false, "only the newest resumable task per session is kept");
  assert.equal(fs.existsSync(resolveJobFile(workspace, "task-stale")), true);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "task-active")), true);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "task-stale-older")), false);
});

test("saveState prunes resumable tasks from old sessions but keeps a recent one", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const now = Date.now();
  const daysAgo = (days) => new Date(now - days * 24 * 60 * 60_000).toISOString();
  const makeJob = (job) => {
    const logFile = resolveJobLogFile(workspace, job.id);
    fs.writeFileSync(logFile, `log ${job.id}\n`, "utf8");
    fs.writeFileSync(
      resolveJobFile(workspace, job.id),
      `${JSON.stringify({ id: job.id, status: job.status })}\n`,
      "utf8"
    );
    return { createdAt: job.updatedAt, logFile, ...job };
  };

  const jobs = [
    // One recent resumable task: six days old, inside the seven-day limit.
    makeJob({
      id: "task-recent",
      jobClass: "task",
      status: "completed",
      sessionId: "sess-recent",
      threadId: "thr_recent",
      updatedAt: daysAgo(6)
    }),
    // 200 old sessions, each with a resumable task outside the limit.
    ...Array.from({ length: 200 }, (_, index) =>
      makeJob({
        id: `task-old-${index}`,
        jobClass: "task",
        status: "completed",
        sessionId: `sess-old-${index}`,
        threadId: `thr_old_${index}`,
        updatedAt: daysAgo(8)
      })
    ),
    // Newer non-resumable jobs fill the cap on their own.
    ...Array.from({ length: 60 }, (_, index) =>
      makeJob({
        id: `job-new-${index}`,
        jobClass: "task",
        status: "completed",
        sessionId: "sess-busy",
        updatedAt: new Date(now - (60 - index) * 60_000).toISOString()
      })
    )
  ];

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`,
    "utf8"
  );
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs });

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const savedIds = new Set(savedState.jobs.map((job) => job.id));
  assert.equal(savedState.jobs.length, 50, "old sessions are pruned back to the cap");
  assert.equal(savedIds.has("task-recent"), true, "a recent resumable task survives");
  assert.equal(
    savedState.jobs.filter((job) => job.id.startsWith("task-old-")).length,
    0,
    "resumable tasks older than the limit are not protected"
  );
  assert.equal(fs.existsSync(resolveJobFile(workspace, "task-recent")), true);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "task-old-0")), false);
});

test("the resumable age limit is configurable with CODEX_COMPANION_RESUMABLE_TASK_MAX_AGE_MS", () => {
  const workspace = makeTempDir();
  const now = Date.now();
  const jobs = [
    {
      id: "task-recent",
      jobClass: "task",
      status: "completed",
      sessionId: "sess-recent",
      threadId: "thr_recent",
      createdAt: new Date(now - 60 * 60_000).toISOString(),
      updatedAt: new Date(now - 60 * 60_000).toISOString()
    },
    ...Array.from({ length: 50 }, (_, index) => ({
      id: `job-new-${index}`,
      jobClass: "task",
      status: "completed",
      sessionId: "sess-busy",
      createdAt: new Date(now - (50 - index) * 60_000).toISOString(),
      updatedAt: new Date(now - (50 - index) * 60_000).toISOString()
    }))
  ];

  const previous = process.env.CODEX_COMPANION_RESUMABLE_TASK_MAX_AGE_MS;
  process.env.CODEX_COMPANION_RESUMABLE_TASK_MAX_AGE_MS = "1000";
  try {
    saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs });
  } finally {
    if (previous == null) {
      delete process.env.CODEX_COMPANION_RESUMABLE_TASK_MAX_AGE_MS;
    } else {
      process.env.CODEX_COMPANION_RESUMABLE_TASK_MAX_AGE_MS = previous;
    }
  }

  const savedIds = new Set(
    JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8")).jobs.map((job) => job.id)
  );
  assert.equal(savedIds.has("task-recent"), false, "an hour-old task is outside a one-second limit");
});

test("writeJobFile writes atomically and leaves no temp residue", () => {
  const workspace = makeTempDir();
  const jobId = "task-atomic-write";
  const jobFile = writeJobFile(workspace, jobId, { id: jobId, status: "queued" });

  const parsed = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(parsed.id, jobId);
  const residue = fs.readdirSync(path.dirname(jobFile)).filter((name) => name.includes(".tmp"));
  assert.deepEqual(residue, []);
});

test("readStoredJob treats a half-written job file as transient instead of throwing", async () => {
  const { readStoredJob } = await import("../plugins/codex/scripts/lib/job-control.mjs");
  const workspace = makeTempDir();
  const jobId = "task-torn-read";
  const jobFile = resolveJobFile(workspace, jobId);
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  // Simulate the torn read a 25ms-polling worker can catch mid-rewrite.
  fs.writeFileSync(jobFile, '{"id":"task-torn-read","status":"que', "utf8");

  assert.equal(readStoredJob(workspace, jobId), null);

  writeJobFile(workspace, jobId, { id: jobId, status: "queued" });
  assert.equal(readStoredJob(workspace, jobId).status, "queued");
});
