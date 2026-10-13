import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeCodex, buildEnv } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));
const LIFECYCLE = new URL("../plugins/codex/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;

function disconnectedTask(t, behavior, args = [], command = "task") {
  const repo = makeTempDir("codex-reconnect-repo-");
  const bin = makeTempDir("codex-reconnect-bin-");
  const data = makeTempDir("codex-reconnect-data-");
  initGitRepo(repo);
  if (command === "adversarial-review") {
    fs.writeFileSync(path.join(repo, "README.md"), "baseline\n");
    run("git", ["add", "README.md"], { cwd: repo });
    run("git", ["commit", "-m", "fixture baseline"], { cwd: repo });
    fs.appendFileSync(path.join(repo, "README.md"), "changed\n");
  }
  installFakeCodex(bin, behavior);
  const env = { ...buildEnv(bin), CLAUDE_PLUGIN_DATA: data, CODEX_HOME: data };
  for (const key of ["CODEX_COMPANION_SESSION_ID", "CODEX_COMPANION_APP_SERVER_ENDPOINT",
    "CODEX_COMPANION_APP_SERVER_PID_FILE", "CODEX_COMPANION_APP_SERVER_LOG_FILE"]) delete env[key];
  t.after(() => { for (const dir of [repo, bin, data]) fs.rmSync(dir, { recursive: true, force: true }); });
  // Start explicitly so slow CI cannot silently fall back to direct before
  // the fault injection. These tests must exercise the broker transport.
  const boot = run("node", ["--input-type=module", "-e",
    `import { ensureBrokerSession } from ${JSON.stringify(LIFECYCLE)};
     console.log(JSON.stringify(await ensureBrokerSession(process.cwd(), { timeoutMs: 30000 })));`], { cwd: repo, env });
  assert.equal(boot.status, 0, boot.stderr);
  const broker = JSON.parse(boot.stdout);
  assert.ok(broker?.endpoint, "fixture broker must be ready before task starts");
  env.CODEX_COMPANION_APP_SERVER_ENDPOINT = broker.endpoint;
  const settings = command === "task" ? ["--effort", "high"] : [];
  const result = run("node", [SCRIPT, command, ...args, "--model", "gpt-5.4", ...settings, "inspect this repository"], { cwd: repo, env });
  const brokerLog = fs.readFileSync(broker.logFile, "utf8");
  t.after(() => fs.rmSync(broker.sessionDir, { recursive: true, force: true }));
  return { result, brokerLog, state: JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8")) };
}

test("persistent read-only task resumes its thread once after mid-turn broker exit", (t) => {
  const { result, state, brokerLog } = disconnectedTask(t, "disconnect-task-once");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.turnStarts, 2);
  assert.equal(state.threads.length, 1, "must resume, not create a second task");
  assert.equal(state.lastThreadResume.model, "gpt-5.4");
  assert.equal(state.lastTurnStart.effort, "high");
  assert.match(result.stderr, /reconnect|resum/i);
  assert.match(brokerLog, /Codex app-server child closed: exit 0/);
});

test("write task is not replayed after mid-turn broker exit", (t) => {
  const { result, state } = disconnectedTask(t, "disconnect-task-once", ["--write"]);
  assert.notEqual(result.status, 0);
  assert.equal(state.turnStarts, 1);
  assert.match(result.stderr, /connection closed/i);
});

test("repeated disconnect fails after one recovery attempt", (t) => {
  const { result, state } = disconnectedTask(t, "disconnect-task-always");
  assert.notEqual(result.status, 0);
  assert.equal(state.turnStarts, 2);
  assert.equal(state.threads.length, 1);
});

test("completed turn is read from resumed history without executing it again", (t) => {
  const { result, state } = disconnectedTask(t, "disconnect-task-completed");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.turnStarts, 1);
  assert.match(result.stdout, /Recovered original final answer/);
});

test("active writer refusal never starts another turn", (t) => {
  const { result, state } = disconnectedTask(t, "disconnect-task-locked");
  assert.notEqual(result.status, 0);
  assert.equal(state.turnStarts, 1);
  assert.equal(state.threads.length, 1);
  assert.match(result.stderr, /already has an active writer/);
});

test("background worker completes the same tracked job after reconnection", (t) => {
  const { result, state } = disconnectedTask(t, "disconnect-task-once", ["--background", "--wait"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.turnStarts, 2);
  assert.equal(state.threads.length, 1);
  assert.match(result.stdout, /completed|result/i);
});

test("lost turn/start response still recovers the notified turn without replay", (t) => {
  const { result, state } = disconnectedTask(t, "disconnect-task-lost-ack");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.turnStarts, 1);
  assert.match(result.stdout, /Recovered original final answer/);
});

test("busy turn/start fallback creates a fresh ephemeral review thread", (t) => {
  const { result, state } = disconnectedTask(t, "busy-turn-once", [], "adversarial-review");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.threads.length, 2);
  assert.ok(state.threads.every((thread) => thread.ephemeral));
  assert.equal(state.lastThreadResume, undefined);
});
