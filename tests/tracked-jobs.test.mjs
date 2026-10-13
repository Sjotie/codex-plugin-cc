import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  readJobFile,
  resolveJobFile,
  updateJobRecord,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { createJobProgressUpdater } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

const LIB_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "codex",
  "scripts",
  "lib"
);

function spawnAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, { encoding: "utf8" });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Exit ${code}: ${stderr}`));
    });
    child.on("error", reject);
  });
}

test("progress updater merges phase and thread ids into the job file and index", () => {
  const workspace = makeTempDir();
  const jobId = "task-progress";
  writeJobFile(workspace, jobId, { id: jobId, status: "running", phase: "starting" });
  updateJobRecord(workspace, jobId, (existing) => existing);

  const updateProgress = createJobProgressUpdater(workspace, jobId);
  updateProgress({ phase: "editing", threadId: "thr_1", turnId: "turn_1" });

  const stored = readJobFile(resolveJobFile(workspace, jobId));
  assert.equal(stored.status, "running");
  assert.equal(stored.phase, "editing");
  assert.equal(stored.threadId, "thr_1");
  assert.equal(stored.turnId, "turn_1");

  const indexed = loadState(workspace).jobs.find((job) => job.id === jobId);
  assert.equal(indexed.phase, "editing");
  assert.equal(indexed.threadId, "thr_1");
  assert.equal(indexed.turnId, "turn_1");
});

test("progress updater leaves a terminal job untouched", () => {
  const workspace = makeTempDir();
  const jobId = "task-terminal";
  writeJobFile(workspace, jobId, {
    id: jobId,
    status: "completed",
    phase: "done",
    threadId: "thr_done",
    turnId: "turn_done"
  });
  updateJobRecord(workspace, jobId, (existing) => existing);

  const updateProgress = createJobProgressUpdater(workspace, jobId);
  updateProgress({ phase: "editing", threadId: "thr_late", turnId: "turn_late" });

  const stored = readJobFile(resolveJobFile(workspace, jobId));
  assert.equal(stored.status, "completed");
  assert.equal(stored.phase, "done");
  assert.equal(stored.threadId, "thr_done");
  assert.equal(stored.turnId, "turn_done");

  const indexed = loadState(workspace).jobs.find((job) => job.id === jobId);
  assert.equal(indexed.phase, "done");
  assert.equal(indexed.threadId, "thr_done");
});

test("progress updater does not recreate a missing job file", () => {
  const workspace = makeTempDir();
  const updateProgress = createJobProgressUpdater(workspace, "task-gone");
  updateProgress({ phase: "editing", threadId: "thr_gone", turnId: "turn_gone" });
  assert.equal(fs.existsSync(resolveJobFile(workspace, "task-gone")), false);
});

// The progress updater used to upsert the index under the lock and then
// rewrite the job file without it. A terminal update landing between that
// read and write was overwritten by the stale copy, resurrecting a finished
// job as "running". The child below reports progress on a job with a large
// payload: once its index update is visible, its unlocked rewrite is still
// busy writing the stale copy, so the terminal update below deterministically
// lands inside the old window. With the locked updater the terminal update
// is serialized after the progress write and stays completed.
test("progress updates never overwrite a concurrent terminal update", async () => {
  const scriptDir = makeTempDir();
  const progressScript = path.join(scriptDir, "progress-child.mjs");
  fs.writeFileSync(
    progressScript,
    `
      import { createJobProgressUpdater } from ${JSON.stringify(path.join(LIB_DIR, "tracked-jobs.mjs"))};
      const [workspace, jobId] = process.argv.slice(2);
      const updateProgress = createJobProgressUpdater(workspace, jobId);
      updateProgress({ phase: "editing", threadId: "thr_race", turnId: "turn_race" });
    `,
    "utf8"
  );

  for (let round = 0; round < 3; round++) {
    const workspace = makeTempDir();
    const jobId = `task-race-${round}`;
    const payload = "x".repeat(16 * 1024 * 1024);
    writeJobFile(workspace, jobId, { id: jobId, status: "running", phase: "starting", payload });
    updateJobRecord(workspace, jobId, (existing) => existing);

    const child = spawnAsync([progressScript, workspace, jobId]);
    // Wait until the progress index update is visible; on the old code the
    // job-file rewrite is still in flight at this point.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const indexed = loadState(workspace).jobs.find((job) => job.id === jobId);
      if (indexed?.threadId === "thr_race") break;
      assert.ok(Date.now() < deadline, "progress update never reached the index");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    updateJobRecord(workspace, jobId, (existing) =>
      existing ? { ...existing, status: "completed", phase: "done", summary: "done", payload: "" } : null
    );
    await child;

    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.status, "completed", `${jobId} must stay completed`);
    assert.equal(stored.threadId, "thr_race", `${jobId} must keep the reported thread`);
    const indexed = loadState(workspace).jobs.find((job) => job.id === jobId);
    assert.equal(indexed.status, "completed", `${jobId} index must stay completed`);
    assert.equal(indexed.threadId, stored.threadId, `${jobId} index and file must agree on the thread`);
  }
});
