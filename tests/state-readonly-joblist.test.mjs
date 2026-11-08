// #1916 (Sol P3 on sjotie.24): reading the job list must not create jobs/.
// Listing and status only read; a state root without jobs/ stays exactly as it was.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const pluginData = makeTempDir("codex-plugin-data-");
process.env.CLAUDE_PLUGIN_DATA = pluginData;

const { listJobs, listJobsReadOnly, resolveJobFile, resolveJobLogFile, resolveStateDir } = await import(
  "../plugins/codex/scripts/lib/state.mjs"
);
const { buildSingleJobSnapshot, buildStatusSnapshot, readStoredJob } = await import(
  "../plugins/codex/scripts/lib/job-control.mjs"
);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function tree(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

function companion(workspace, args) {
  const result = run("node", [SCRIPT, ...args], {
    cwd: workspace,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData }
  });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result;
}

function indexOnlyWorkspace() {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: "task-done",
          status: "completed",
          title: "Codex Task",
          jobClass: "task",
          summary: "done task",
          createdAt: "2026-11-01T10:00:00.000Z",
          completedAt: "2026-11-01T10:01:00.000Z",
          updatedAt: "2026-11-01T10:01:00.000Z"
        }
      ]
    }, null, 2)}\n`,
    "utf8"
  );
  return { workspace, stateDir };
}

test("path helpers only compute paths", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  assert.equal(resolveJobFile(workspace, "job-1"), path.join(stateDir, "jobs", "job-1.json"));
  assert.equal(resolveJobLogFile(workspace, "job-1"), path.join(stateDir, "jobs", "job-1.log"));
  assert.equal(readStoredJob(workspace, "job-1"), null);
  assert.equal(tree(stateDir), null);
});

test("listing jobs and status leave a state root without jobs/ unchanged", () => {
  const { workspace, stateDir } = indexOnlyWorkspace();
  const before = tree(stateDir);
  assert.deepEqual(before, ["state.json"]);

  assert.equal(listJobsReadOnly(workspace).length, 1);
  assert.equal(listJobs(workspace).length, 1);
  buildStatusSnapshot(workspace, { all: true });
  buildSingleJobSnapshot(workspace, "task-done");
  assert.deepEqual(tree(stateDir), before);

  companion(workspace, ["status", "--all"]);
  companion(workspace, ["status", "--json", "--all"]);
  companion(workspace, ["status", "task-done", "--json"]);
  assert.deepEqual(tree(stateDir), before);
});

test("the read-only list of a waiting job with a dead worker creates nothing", () => {
  const { workspace, stateDir } = indexOnlyWorkspace();
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  state.jobs.unshift({
    id: "task-gone",
    status: "running",
    phase: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: 2 ** 22 + 12345,
    createdAt: "2026-11-01T11:00:00.000Z",
    updatedAt: "2026-11-01T11:00:00.000Z"
  });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const before = tree(stateDir);

  const jobs = listJobsReadOnly(workspace);
  assert.equal(jobs.length, 2);
  assert.deepEqual(tree(stateDir), before);
});

test("status on an empty state root creates no state root", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  assert.deepEqual(listJobsReadOnly(workspace), []);
  assert.deepEqual(listJobs(workspace), []);
  companion(workspace, ["status", "--all"]);
  companion(workspace, ["status", "--json", "--all"]);
  assert.equal(tree(stateDir), null);
});
