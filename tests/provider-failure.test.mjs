import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { describeProviderFailure } from "../plugins/codex/scripts/lib/codex.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { readJobFile, resolveJobFile, updateJobRecord, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { renderStatusReport, renderStoredJobResult, renderTaskResult, renderWaitResult } from "../plugins/codex/scripts/lib/render.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const INTERMEDIATE = "Handled the requested task.";

function setup(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, env: buildEnv(binDir) };
}

function companion(ctx, args) {
  return run("node", [SCRIPT, ...args], { cwd: ctx.repo, env: ctx.env });
}

function runTask(behavior) {
  const ctx = setup(behavior);
  const task = companion(ctx, ["task", "--json", "do the synthetic thing"]);
  return { ctx, task, payload: JSON.parse(task.stdout) };
}

test("healthy task keeps its output and has no failure", () => {
  const { task, payload } = runTask("review-ok");
  assert.equal(task.status, 0);
  assert.equal(payload.failure, undefined);
  assert.equal(payload.incomplete, undefined);
  assert.match(payload.rawOutput, new RegExp(INTERMEDIATE));
});

test("a retried error followed by a completed turn is not a failure", () => {
  const { task, payload } = runTask("provider-error-then-completed");
  assert.equal(task.status, 0);
  assert.equal(payload.failure, undefined);
  assert.match(payload.rawOutput, new RegExp(INTERMEDIATE));
});

test("structured safety error: JSON, text, status, wait and result all carry it; intermediate stays marked incomplete", () => {
  const { ctx, task, payload } = runTask("provider-safety-block");
  assert.notEqual(task.status, 0);
  assert.equal(payload.failure.class, "provider_safety_block");
  assert.equal(payload.failure.classifiedFrom, "structured-type");
  assert.equal(payload.failure.type, "cyberPolicy");
  assert.match(payload.failure.message, /flagged for possible cybersecurity risk/);
  assert.equal(payload.incomplete, true);
  assert.match(payload.rawOutput, new RegExp(INTERMEDIATE));

  const text = companion(ctx, ["task", "do the synthetic thing"]);
  assert.match(text.stdout, /Status: failed/);
  assert.match(text.stdout, /failure:provider_safety_block/);
  assert.match(text.stdout, /flagged for possible cybersecurity risk/);
  assert.match(text.stdout, /NOT a final report/);
  assert.ok(text.stdout.indexOf("Codex error") < text.stdout.indexOf(INTERMEDIATE), "error comes before the partial");

  const result = JSON.parse(companion(ctx, ["result", "--json"]).stdout);
  assert.equal(result.storedJob.failure.class, "provider_safety_block");
  assert.equal(result.job.failure.class, "provider_safety_block");
  assert.match(result.job.summary, /^Failed \(provider_safety_block\)/);
  const resultText = companion(ctx, ["result"]).stdout;
  assert.match(resultText, /failure:provider_safety_block/);
  assert.match(resultText, /NOT a final report/);

  const status = JSON.parse(companion(ctx, ["status", result.job.id, "--json"]).stdout);
  assert.equal(status.job.failure.class, "provider_safety_block");
  assert.match(companion(ctx, ["status", result.job.id]).stdout, /failure:provider_safety_block/);

  const waited = companion(ctx, ["wait", result.job.id, "--json"]);
  assert.equal(JSON.parse(waited.stdout).job.failure.class, "provider_safety_block");
  assert.match(companion(ctx, ["wait", result.job.id]).stdout, /failure:provider_safety_block/);
});

test("the literal safety sentence without a structured type is a labelled fallback", () => {
  const { payload } = runTask("provider-safety-text-only");
  assert.equal(payload.failure.class, "provider_safety_block");
  assert.equal(payload.failure.classifiedFrom, "message-text");
  assert.equal(payload.failure.type, null);
});

test("an unrelated provider error is never classified as a safety block", () => {
  const { ctx, payload } = runTask("provider-unknown-error");
  assert.equal(payload.failure.class, "provider_error");
  assert.equal(payload.failure.type, "httpConnectionFailed");
  assert.equal(payload.failure.code, "502");
  assert.equal(payload.failure.message, "SYNTHETIC upstream outage");
  assert.equal(payload.failure.details, "retries exhausted");
  assert.doesNotMatch(companion(ctx, ["result"]).stdout, /provider_safety_block|safety classification/);
});

test("a failed turn without error text is reported honestly", () => {
  const { ctx, payload } = runTask("provider-failed-no-error");
  assert.equal(payload.failure.class, "turn_failed");
  assert.equal(payload.failure.message, null);
  assert.match(companion(ctx, ["result"]).stdout, /Codex reported no error text/);
});

test("an interrupted turn is distinguished from a provider error", () => {
  const { payload } = runTask("provider-interrupted");
  assert.equal(payload.failure.class, "interrupted");
});

test("native review and structured review carry the failure", () => {
  const native = setup("provider-safety-block");
  fs.writeFileSync(path.join(native.repo, "README.md"), "changed\n");
  const review = companion(native, ["review", "--wait"]);
  assert.notEqual(review.status, 0);
  assert.match(review.stdout, /failure:provider_safety_block/);
  assert.match(review.stdout, /flagged for possible cybersecurity risk/);

  const adversarial = companion(native, ["adversarial-review", "--wait", "--json"]);
  const parsed = JSON.parse(adversarial.stdout);
  assert.equal(parsed.failure.class, "provider_safety_block");
  assert.equal(parsed.incomplete, true);
});

test("describeProviderFailure does not infer a safety block from unrelated text", () => {
  assert.equal(describeProviderFailure({ message: "cyber security docs are great" }).class, "provider_error");
  assert.equal(describeProviderFailure({ message: "x", codexErrorInfo: "other" }).class, "provider_error");
  assert.equal(describeProviderFailure({ message: "" }).message, null);
});

test("renderers put the failure ahead of a partial; legacy failed records are marked partial", () => {
  const failure = describeProviderFailure({ message: "SYNTHETIC_PROVIDER_ERROR", codexErrorInfo: "boom" });
  const rendered = renderTaskResult({ rawOutput: "SYNTHETIC_INTERMEDIATE_ONLY", failure }, { title: "T" });
  assert.match(rendered, /Status: failed/);
  assert.match(rendered, /SYNTHETIC_PROVIDER_ERROR/);
  assert.ok(rendered.indexOf("SYNTHETIC_PROVIDER_ERROR") < rendered.indexOf("SYNTHETIC_INTERMEDIATE_ONLY"));

  const legacy = renderStoredJobResult(
    { id: "j", status: "failed", title: "T" },
    { result: { rawOutput: "SYNTHETIC_INTERMEDIATE_ONLY" }, errorMessage: "SYNTHETIC_PROVIDER_ERROR" }
  );
  assert.match(legacy, /NOT a final report/);

  const done = renderStoredJobResult({ id: "j", status: "completed" }, { result: { rawOutput: "FINAL" } });
  assert.equal(done.trim(), "FINAL");
});

test("an error from a subagent thread does not fail the main turn", () => {
  const { task, payload } = runTask("provider-subagent-error-then-completed");
  assert.equal(task.status, 0);
  assert.equal(payload.failure, undefined);
});

test("only the exact structured type is a safety block", () => {
  const { payload } = runTask("provider-lookalike-type");
  assert.equal(payload.failure.class, "provider_error");
  assert.equal(payload.failure.type, "cyberPolicyOther");
  assert.equal(describeProviderFailure({ message: "x", codexErrorInfo: "misalignmentPolicyViolation" }).class, "provider_error");
});

test("a retried error is only used when the turn then fails without a final error", () => {
  const { payload } = runTask("provider-retry-then-failed");
  assert.equal(payload.failure.class, "provider_error");
  assert.equal(payload.failure.type, "serverOverloaded");
});

test("legacy failed records with only rendered text stay failed and incomplete", () => {
  const out = renderStoredJobResult(
    { id: "j", status: "failed", title: "T" },
    { rendered: "SYNTHETIC_INTERMEDIATE_ONLY\n", errorMessage: "SYNTHETIC_PROVIDER_ERROR" }
  );
  assert.match(out, /Status: failed/);
  assert.match(out, /NOT a final report/);
  assert.match(out, /SYNTHETIC_PROVIDER_ERROR/);
});

test("a later successful run of the same job clears the earlier failure and error message", async () => {
  const workspace = makeTempDir();
  const job = { id: "task-retry-1", workspaceRoot: workspace, title: "T", jobClass: "task", status: "queued", logFile: null };
  upsertJob(workspace, job);
  const failure = { class: "provider_error", type: "x", message: "OLD_ERROR" };
  await runTrackedJob(job, async () => ({ exitStatus: 1, payload: { rawOutput: "partial" }, rendered: "partial\n", failure, summary: "s" }));
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).failure.message, "OLD_ERROR");
  await runTrackedJob(job, async () => ({ exitStatus: 0, payload: { rawOutput: "FINAL" }, rendered: "FINAL\n", summary: "s" }));
  const stored = readJobFile(resolveJobFile(workspace, job.id));
  assert.equal(stored.status, "completed");
  assert.equal(stored.failure, null);
  assert.equal(stored.errorMessage, null);
  const out = renderStoredJobResult({ id: job.id, status: "completed" }, stored);
  assert.equal(out.trim(), "FINAL");
});

test("the literal-message fallback never overrides a structured type", () => {
  const failure = describeProviderFailure({
    message: "flagged for possible cybersecurity risk",
    codexErrorInfo: "serverOverloaded"
  });
  assert.equal(failure.class, "provider_error");
  assert.equal(failure.type, "serverOverloaded");
});

test("provider text cannot break out of its code fence", () => {
  const failure = describeProviderFailure({ message: "line1\n```\n# injected heading", codexErrorInfo: "x" });
  const out = renderTaskResult({ rawOutput: "", failure }, { title: "T" });
  assert.match(out, /````text\nline1\n```\n# injected heading\n````/);
});

// Four public paths that return a failure: task, native review, structured (adversarial) review, explicit resume.
// Each entry holds the command's JSON payload plus the stored job that `result --json` then reports.
function runAllPaths(behavior) {
  const ctx = setup(behavior);
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");
  const parse = (r) => JSON.parse(r.stdout);
  const observe = (args) => {
    const payload = parse(companion(ctx, args));
    return { payload, stored: parse(companion(ctx, ["result", "--json"])), text: companion(ctx, ["result"]).stdout };
  };
  const task = observe(["task", "--json", "do the synthetic thing"]);
  return {
    task,
    review: observe(["review", "--wait", "--json"]),
    adversarial: observe(["adversarial-review", "--wait", "--json"]),
    resume: observe(["task", "--resume-thread", task.payload.threadId, "--json", "resume it"])
  };
}

for (const [behavior, expected] of [
  ["provider-empty-then-final", { type: "cyberPolicy", message: "SYNTHETIC_FINAL_ERROR", class: "provider_safety_block" }],
  ["provider-earlier-then-final", { type: "cyberPolicy", message: "SYNTHETIC_FINAL_ERROR", class: "provider_safety_block" }],
  ["provider-useful-then-empty-final", { type: "serverOverloaded", message: "SYNTHETIC_EARLIER_ERROR", class: "provider_error" }],
  ["provider-useful-then-null-final", { type: "serverOverloaded", message: "SYNTHETIC_EARLIER_ERROR", class: "provider_error" }],
  ["provider-empty-then-empty-final", { type: null, message: null, class: "provider_error" }]
]) {
  test(`final turn error vs earlier notification (${behavior}): payload, stored job, summary and text agree on all four paths`, () => {
    const paths = runAllPaths(behavior);
    for (const name of ["task", "review", "adversarial", "resume"]) {
      const { payload, stored, text } = paths[name];
      assert.equal(payload.failure.class, expected.class, `${name} class`);
      assert.equal(payload.failure.type, expected.type, `${name} type`);
      assert.equal(payload.failure.message, expected.message, `${name} message`);
      assert.deepEqual(stored.storedJob.failure, payload.failure, `${name} stored failure`);
      assert.equal(stored.storedJob.errorMessage, expected.message, `${name} stored errorMessage`);
      if (expected.message) {
        assert.match(stored.job.summary, new RegExp(expected.message), `${name} summary`);
        assert.match(text, new RegExp(expected.message), `${name} text`);
      } else {
        assert.match(text, /Codex reported no error text/, `${name} text`);
      }
    }
  });
}

test("legacy error-status records get the same partial wrapper as failed, in result and wait", () => {
  for (const status of ["failed", "error"]) {
    for (const stored of [{ result: { rawOutput: "INTERMEDIATE_ONLY" } }, { rendered: "INTERMEDIATE_ONLY\n" }]) {
      const job = { id: "j", status, title: "T" };
      for (const render of [renderStoredJobResult, renderWaitResult]) {
        const out = render(job, { ...stored, errorMessage: "STORAGE_ERROR" });
        assert.match(out, /NOT a final report/, `${status} ${render.name}`);
        assert.match(out, /STORAGE_ERROR/);
        assert.ok(out.indexOf("STORAGE_ERROR") < out.indexOf("INTERMEDIATE_ONLY"));
      }
    }
  }
  for (const status of ["completed"]) {
    assert.equal(renderStoredJobResult({ id: "j", status }, { result: { rawOutput: "FINAL" }, errorMessage: "ignored" }).trim(), "FINAL");
  }
});

test("status text shows the error text of records without a structured failure, labelled as unknown", () => {
  for (const status of ["failed", "error"]) {
    const text = renderStatusReport({
      workspaceRoot: "/w",
      sessionRuntime: { label: "direct startup" },
      config: { stopReviewGate: false },
      running: [],
      latestFinished: { id: "j", status, title: "T", kindLabel: "task", errorMessage: "STORAGE_ERROR", phase: "failed" },
      recent: [],
      needsReview: false
    });
    assert.match(text, /failure:unknown_failure \(no structured error type recorded\): STORAGE_ERROR/);
    assert.doesNotMatch(text, /provider_safety_block/);
  }
  const healthy = renderStatusReport({
    workspaceRoot: "/w",
    sessionRuntime: { label: "direct startup" },
      config: { stopReviewGate: false },
    running: [],
    latestFinished: { id: "j", status: "completed", title: "T", kindLabel: "task", errorMessage: "stale", phase: "done" },
    recent: [],
    needsReview: false
  });
  assert.doesNotMatch(healthy, /failure:/);
});

test("same-job failed -> retry -> cancel never reports the old provider failure; success and plain failure inverses hold", async () => {
  const workspace = makeTempDir();
  const job = { id: "task-cancel-1", workspaceRoot: workspace, title: "T", jobClass: "task", status: "queued", logFile: null };
  upsertJob(workspace, job);
  const failure = { class: "provider_error", type: "x", message: "OLD_ERROR" };
  await runTrackedJob(job, async () => ({ exitStatus: 1, payload: { rawOutput: "old partial" }, rendered: "old partial\n", failure, summary: "s" }));
  await runTrackedJob(job, async () => {
    updateJobRecord(workspace, job.id, (existing) => ({ ...existing, status: "cancelled", phase: "cancelled", pid: null }));
    return { exitStatus: 1, payload: { rawOutput: "partial" }, rendered: "partial\n", failure: { ...failure, message: "NEW_ERROR" }, summary: "s" };
  });
  const stored = readJobFile(resolveJobFile(workspace, job.id));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.failure, null);
  assert.doesNotMatch(String(stored.errorMessage), /OLD_ERROR|NEW_ERROR/);
  const out = renderWaitResult({ ...stored }, stored);
  assert.match(out, /Status: cancelled/);
  assert.doesNotMatch(out, /Status: failed|OLD_ERROR|failure:/);
  assert.doesNotMatch(out, /^partial$/m, "a cancelled partial is never presented as a bare final report");
  assert.match(out, /NOT a final report/);

  // Render-level guard: a cancelled job record still carrying an old failure.
  const guarded = renderStoredJobResult({ id: "j", status: "cancelled" }, { failure, errorMessage: "Cancelled by user.", result: { rawOutput: "old partial" } });
  assert.doesNotMatch(guarded, /failed|OLD_ERROR/);

  // Inverse: a plain failed run after a cancelled-free retry still reports its own failure.
  const job2 = { ...job, id: "task-cancel-2" };
  upsertJob(workspace, job2);
  await runTrackedJob(job2, async () => ({ exitStatus: 1, payload: { rawOutput: "p" }, rendered: "p\n", failure: { ...failure, message: "NEW_ERROR" }, summary: "s" }));
  const failed = readJobFile(resolveJobFile(workspace, job2.id));
  assert.equal(failed.failure.message, "NEW_ERROR");
  assert.match(renderStoredJobResult({ id: job2.id, status: "failed" }, failed), /NEW_ERROR/);
});

// #1795/#1796: under CPU load the companion can stall right after it reads the final
// answer, while the provider error and the failed turn/completed are already waiting in
// the pipe. That stall must not let the completion inference report a clean success.
function runStalledTask(behavior, extraEnv) {
  const ctx = setup(behavior);
  const preload = pathToFileURL(path.join(ROOT, "tests", "stall-after-final-answer.mjs")).href;
  const dataDir = makeTempDir();
  const env = {
    ...ctx.env,
    ...extraEnv,
    CLAUDE_PLUGIN_DATA: dataDir,
    NODE_OPTIONS: `${ctx.env.NODE_OPTIONS ?? ""} --import="${preload}"`.trim()
  };
  const task = spawnSync("node", [SCRIPT, "task", "--json", "do the synthetic thing"], {
    cwd: ctx.repo,
    env,
    encoding: "utf8",
    timeout: 60_000
  });
  assert.equal(task.error, undefined, "the task must end on its own");
  const jobLog = fs
    .readdirSync(dataDir, { recursive: true })
    .filter((file) => String(file).endsWith(".log"))
    .map((file) => fs.readFileSync(path.join(dataDir, String(file)), "utf8"))
    .join("\n");
  return { task, payload: JSON.parse(task.stdout), jobLog };
}

test("a stall after the final answer does not hide the provider failure that is already in the pipe", () => {
  const { task, payload } = runStalledTask("provider-safety-block", {
    FAKE_CODEX_FAILURE_DELAY_MS: "100",
    STALL_AFTER_FINAL_ANSWER_MS: "600"
  });
  assert.match(task.stderr, /\[stall-after-final-answer\] stalled 600 ms/, "the preload must have stalled the companion");
  assert.notEqual(task.status, 0, "a failed turn must not exit 0");
  assert.equal(payload.failure?.class, "provider_safety_block");
  assert.equal(payload.failure?.type, "cyberPolicy");
  assert.equal(payload.incomplete, true);
});

test("a final error without turn/completed ends the turn as failed, not completed", () => {
  const { task, payload } = runStalledTask("provider-unknown-error", { FAKE_CODEX_FAILURE_WITHOUT_TURN_COMPLETED: "1" });
  assert.notEqual(task.status, 0);
  assert.equal(payload.failure?.class, "provider_error");
  assert.equal(payload.failure?.type, "httpConnectionFailed");
  assert.equal(payload.failure?.turnStatus, "failed");
  assert.equal(payload.incomplete, true);
});

test("a stall between the inference timer and its check does not hide a provider failure", () => {
  const { task, payload, jobLog } = runStalledTask("provider-safety-block", {
    FAKE_CODEX_FAILURE_DELAY_MS: "1500",
    STALL_BEFORE_INFERENCE_CHECK_MS: "3000"
  });
  assert.match(task.stderr, /stalled 3000 ms before the inference check/, "the preload must have stalled the companion");
  assert.match(jobLog, /Quiet period interrupted by a \d+ ms stall/, "the check itself must have seen the stall");
  assert.notEqual(task.status, 0, "a failed turn must not exit 0");
  assert.equal(payload.failure?.class, "provider_safety_block");
  assert.equal(payload.incomplete, true);
});

for (const [label, delayMs] of [["read with the final answer", "0"], ["arriving during the stalls", "500"]]) {
  test(`under a stall that never ends the inferred turn end still comes after a bounded number of late windows (error ${label})`, () => {
    const { task, payload, jobLog } = runStalledTask("provider-unknown-error", {
      FAKE_CODEX_FAILURE_DELAY_MS: delayMs,
      FAKE_CODEX_FAILURE_WITHOUT_TURN_COMPLETED: "1",
      STALL_REPEATEDLY_AFTER_FINAL_ANSWER_MS: "120"
    });
    assert.match(task.stderr, /stalling 120 ms per timers phase/, "the preload must have stalled the companion");
    const lateWindows = jobLog.match(/Quiet period interrupted by a \d+ ms stall/g) ?? [];
    assert.ok(lateWindows.length >= 3, `expected at least 3 late windows, saw ${lateWindows.length}`);
    assert.notEqual(task.status, 0);
    assert.equal(payload.failure?.class, "provider_error");
    assert.equal(payload.failure?.turnStatus, "failed");
  });
}
