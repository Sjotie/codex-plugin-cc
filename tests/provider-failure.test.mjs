import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { describeProviderFailure } from "../plugins/codex/scripts/lib/codex.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { readJobFile, resolveJobFile, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { renderStoredJobResult, renderTaskResult } from "../plugins/codex/scripts/lib/render.mjs";

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
