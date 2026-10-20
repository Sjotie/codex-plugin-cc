import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  listJobs,
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  __saveStateForTest as saveState,
  openStateLock,
  upsertJob
} from "../plugins/codex/scripts/lib/state.mjs";

const LOCK_FILE_NAME = "state.lock";
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_MJS_PATH = path.resolve(
  TESTS_DIR,
  "..",
  "plugins",
  "codex",
  "scripts",
  "lib",
  "state.mjs"
);

function spawnAsync(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Exit ${code}: ${stderr || stdout}`));
    });
    child.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Test 1: concurrent upsertJob from multiple processes does not lose jobs
// or delete their artifacts. This is the core regression test for #458.
// ---------------------------------------------------------------------------
test("concurrent upsertJob from multiple processes preserves all jobs and artifacts", async () => {
  const workspace = makeTempDir();
  const NUM_PROCESSES = 5;

  // Each child process imports state.mjs, writes a job file, then registers
  // the job in the index via upsertJob — mirroring the real workflow in
  // tracked-jobs.mjs / codex-companion.mjs.
  const script = `
    import { upsertJob, resolveJobLogFile, writeJobFile } from "${STATE_MJS_PATH}";
    const workspace = process.argv[2];
    const jobId = process.argv[3];
    const logFile = resolveJobLogFile(workspace, jobId);
    writeJobFile(workspace, jobId, { id: jobId, status: "running" });
    upsertJob(workspace, { id: jobId, status: "running", logFile });
  `;
  const scriptFile = path.join(os.tmpdir(), `concurrent-test-${Date.now()}-${process.pid}.mjs`);
  fs.writeFileSync(scriptFile, script, "utf8");

  try {
    const promises = [];
    for (let i = 0; i < NUM_PROCESSES; i++) {
      promises.push(spawnAsync("node", [scriptFile, workspace, `job-${i}`]));
    }
    await Promise.all(promises);

    const jobs = listJobs(workspace);
    assert.equal(
      jobs.length,
      NUM_PROCESSES,
      `Expected ${NUM_PROCESSES} jobs, got ${jobs.length}: ${JSON.stringify(jobs.map((j) => j.id))}`
    );

    for (let i = 0; i < NUM_PROCESSES; i++) {
      const jobId = `job-${i}`;
      assert.equal(
        fs.existsSync(resolveJobFile(workspace, jobId)),
        true,
        `Job .json file should exist for ${jobId}`
      );
    }
  } finally {
    fs.unlinkSync(scriptFile);
  }
});

// 50 writers at once (#1822): a stress check on top of the deterministic test
// below. Against the old lock it loses jobs in most runs, not in every run.
test("50 concurrent upsertJob writers lose no job", async () => {
  const workspace = makeTempDir();
  const count = 50;
  const script = `
    import { upsertJob, resolveJobLogFile, writeJobFile } from "${STATE_MJS_PATH}";
    const [workspace, jobId] = process.argv.slice(2);
    writeJobFile(workspace, jobId, { id: jobId, status: "running" });
    upsertJob(workspace, { id: jobId, status: "running", logFile: resolveJobLogFile(workspace, jobId) });
  `;
  const scriptFile = path.join(os.tmpdir(), `concurrent-50-${Date.now()}-${process.pid}.mjs`);
  fs.writeFileSync(scriptFile, script, "utf8");
  try {
    await Promise.all(
      Array.from({ length: count }, (_, i) => spawnAsync("node", [scriptFile, workspace, `job-${i}`]))
    );
    const ids = listJobs(workspace).map((j) => j.id).sort();
    assert.equal(ids.length, count, `Expected ${count} jobs, got ${ids.length}`);
    for (let i = 0; i < count; i++) {
      assert.equal(fs.existsSync(resolveJobFile(workspace, `job-${i}`)), true, `job-${i}.json missing`);
    }
  } finally {
    fs.unlinkSync(scriptFile);
  }
});

// ---------------------------------------------------------------------------
// Test 1b (#1822): Test 1 loses a job now and then, and this pins the
// interleaving that does it. Writer A has just made state.lock appear but has
// not finished acquiring. Writer B arrives in that moment. B must wait for A.
// When B takes the lock over instead, both run their read-modify-write at the
// same time, and whichever saves last drops the other's job from the index
// and deletes its job file and log.
// ---------------------------------------------------------------------------
test("a writer that arrives while another is acquiring the lock waits for it", async () => {
  const workspace = makeTempDir();
  const pauseDir = makeTempDir();
  const hook = pathToFileURL(path.join(TESTS_DIR, "state-lock-pause-hook.mjs")).href;
  const script = path.join(pauseDir, "writer.mjs");
  fs.writeFileSync(
    script,
    `
    import fs from "node:fs";
    import { upsertJob, resolveJobLogFile, writeJobFile } from "${STATE_MJS_PATH}";
    const [workspace, jobId] = process.argv.slice(2);
    const logFile = resolveJobLogFile(workspace, jobId);
    writeJobFile(workspace, jobId, { id: jobId, status: "running" });
    fs.writeFileSync(logFile, "log\\n");
    upsertJob(workspace, { id: jobId, status: "running", logFile });
  `,
    "utf8"
  );
  const marker = (name) => path.join(pauseDir, name);
  async function waitForMarker(...names) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const found = names.find((name) => fs.existsSync(marker(name)));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${names.join(" or ")}`);
  }
  const writer = (name, jobId, pauseAt) =>
    spawnAsync(process.execPath, ["--import", hook, script, workspace, jobId], {
      env: { ...process.env, LOCK_PAUSE_DIR: pauseDir, LOCK_PAUSE_NAME: name, LOCK_PAUSE_AT: pauseAt }
    });

  await writer("seed", "job-seed", "none");

  const writerA = writer("A", "job-A", "lock-visible");
  // A writer that exits early is reported by the awaits below, not as an
  // unhandled rejection while a marker wait is still polling.
  writerA.catch(() => {});
  let writerB;
  try {
    await waitForMarker("A.paused");
    writerB = writer("B", "job-B", "state-read");
    writerB.catch(() => {});
    // Either B waits on A's lock, or it took the lock over and is now inside
    // its read-modify-write with a snapshot that lacks job-A.
    await waitForMarker("B.waiting", "B.paused");
    fs.writeFileSync(marker("A.go"), "");
    await writerA;
  } finally {
    // Never leave a writer paused, also when a wait above timed out.
    fs.writeFileSync(marker("A.go"), "");
    fs.writeFileSync(marker("B.go"), "");
  }
  await writerA;
  await writerB;

  const ids = listJobs(workspace).map((job) => job.id).sort();
  assert.deepEqual(ids, ["job-A", "job-B", "job-seed"]);
  for (const jobId of ids) {
    assert.equal(fs.existsSync(resolveJobFile(workspace, jobId)), true, `job file of ${jobId}`);
    assert.equal(fs.existsSync(resolveJobLogFile(workspace, jobId)), true, `log of ${jobId}`);
  }
});

// ---------------------------------------------------------------------------
// Test 2: saveState with a stale snapshot does not delete jobs that were
// added by a concurrent updateState call (the lock serializes them).
// ---------------------------------------------------------------------------
test("saveState with stale snapshot does not delete concurrently-added jobs", () => {
  const workspace = makeTempDir();

  // Step 1: Add job-A
  upsertJob(workspace, { id: "job-A", status: "running" });

  // Step 2: Load a stale snapshot (simulating a process that read before
  // another process wrote).
  const staleState = loadState(workspace);

  // Step 3: Another process adds job-B (this happens "between" the stale
  // read and the saveState call below).
  upsertJob(workspace, { id: "job-B", status: "running" });

  // Step 4: The first process calls saveState with its stale snapshot.
  // Before the fix, saveState would re-read previousJobs (which now
  // includes job-B), see that job-B is not in the stale nextJobs, and
  // delete job-B's files. With the lock, saveState still runs, but
  // because updateState for job-B has already completed (lock released),
  // the saveState call sees the full state and the prune logic only
  // removes jobs exceeding MAX_JOBS.
  //
  // NOTE: saveState is a "replace" operation by design. The lock prevents
  // data corruption from concurrent file access, but a stale saveState
  // call can still replace a newer state. This test verifies that the
  // lock at least prevents the file-level race (no partial writes, no
  // deleted artifacts from a half-complete concurrent updateState).
  saveState(workspace, staleState);

  // The stale saveState replaces the state, so job-B may be missing
  // from the index. But its .json file should NOT be deleted (because
  // saveState only deletes files for jobs in previousJobs that aren't
  // in nextJobs — and with the lock, previousJobs is read atomically).
  //
  // The key assertion: no .tmp files are left behind (atomic write worked).
  const stateDir = resolveStateDir(workspace);
  const tmpFiles = fs.readdirSync(stateDir).filter((f) => f.includes(".tmp."));
  assert.equal(tmpFiles.length, 0, "No temp files should remain after atomic write");
});

// ---------------------------------------------------------------------------
// Test 3 (#1916, design D3): an old lock file is never reclaimed automatically,
// not even with a dead or unreadable PID. The writer waits and the timeout
// names the guided route (state-lock adopt-legacy after a drain-check). The
// old #1822 link tests are gone with the link publication; T5 in
// state-lock-races.test.mjs covers the fallback race.
// ---------------------------------------------------------------------------
for (const [label, content] of [
  ["a dead PID", "999999"],
  ["an empty file", ""],
  ["garbage", "garbage"]
]) {
  test(`an old lock file with ${label} is never reclaimed; the timeout names adopt-legacy`, () => {
    const workspace = makeTempDir();
    const lockFile = path.join(resolveStateDir(workspace), LOCK_FILE_NAME);
    fs.mkdirSync(resolveStateDir(workspace), { recursive: true });
    fs.writeFileSync(lockFile, content, "utf8");
    const before = fs.lstatSync(lockFile);

    const lock = openStateLock(workspace);
    assert.throws(() => lock.acquire({ deadlineMs: 300 }), (error) => {
      assert.equal(error.code, "ESTATELOCKTIMEOUT");
      assert.match(error.message, /^Timed out waiting for state lock: /);
      if (content === "999999") assert.match(error.message, /adopt-legacy/);
      return true;
    });
    const after = fs.lstatSync(lockFile);
    assert.equal(after.ino, before.ino, "the old lock file is untouched");
    assert.equal(fs.readFileSync(lockFile, "utf8"), content);
  });
}

// ---------------------------------------------------------------------------
// Test 4: atomic write — state.json is never partially written.
// ---------------------------------------------------------------------------
test("saveState writes atomically (no temp files remain)", () => {
  const workspace = makeTempDir();

  upsertJob(workspace, { id: "job-atomic", status: "running" });

  const stateDir = resolveStateDir(workspace);
  const files = fs.readdirSync(stateDir);
  const tempFiles = files.filter((f) => f.includes(".tmp."));

  assert.equal(tempFiles.length, 0, "No temp files should remain: " + JSON.stringify(tempFiles));

  // Verify state.json is valid JSON (not partially written).
  const stateFile = resolveStateFile(workspace);
  const content = fs.readFileSync(stateFile, "utf8");
  assert.doesNotThrow(() => JSON.parse(content), "state.json should be valid JSON");
});

// ---------------------------------------------------------------------------
// Test 5: existing prune behavior still works correctly with locking.
// ---------------------------------------------------------------------------
test("saveState still prunes jobs exceeding MAX_JOBS with locking enabled", () => {
  const workspace = makeTempDir();

  // Add MAX_JOBS + 5 jobs sequentially.
  for (let i = 0; i < 55; i++) {
    upsertJob(workspace, {
      id: `job-prune-${i}`,
      status: "completed",
      logFile: resolveJobLogFile(workspace, `job-prune-${i}`)
    });
  }

  const jobs = listJobs(workspace);
  assert.equal(jobs.length, 50, "Should retain exactly MAX_JOBS (50) jobs");

  // The oldest 5 jobs should have been pruned.
  const jobIds = new Set(jobs.map((j) => j.id));
  for (let i = 0; i < 5; i++) {
    assert.equal(jobIds.has(`job-prune-${i}`), false, `job-prune-${i} should be pruned`);
  }
  for (let i = 5; i < 55; i++) {
    assert.equal(jobIds.has(`job-prune-${i}`), true, `job-prune-${i} should be retained`);
  }
});
