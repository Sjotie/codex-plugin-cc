import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  AppServerClientBase,
  APP_SERVER_SPAWN_ARGS,
  PEERS_MCP_DISABLE_OVERRIDE,
  buildAppServerChildEnv,
  buildAppServerSpawnArgs,
  codexConfigDefinesPeers
} from "../plugins/codex/scripts/lib/app-server.mjs";

/** Minimal client that records the JSON-RPC messages it would send. */
class CapturingClient extends AppServerClientBase {
  constructor() {
    super(process.cwd());
    this.sent = [];
  }
  sendMessage(message) {
    this.sent.push(message);
  }
}

test("handleServerRequest accepts MCP form elicitations from a local server instead of rejecting them", () => {
  const client = new CapturingClient();
  client.handleServerRequest({
    id: 7,
    method: "mcpServer/elicitation/request",
    params: { serverName: "local", threadId: "t1", mode: "form", message: "ok?", requestedSchema: {} }
  });
  assert.deepEqual(client.sent, [
    { id: 7, result: { action: "accept", content: null, _meta: null } }
  ]);
});

test("handleServerRequest still rejects unknown server requests with -32601", () => {
  const client = new CapturingClient();
  client.handleServerRequest({ id: 8, method: "some/unknown/request", params: {} });
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].id, 8);
  assert.equal(client.sent[0].result, undefined);
  assert.equal(client.sent[0].error.code, -32601);
});

test("app-server spawn args disable the peers MCP via a global -c override before the subcommand", () => {
  // `-c/--config` is a global codex flag and must come before the subcommand.
  // #1796: ChatGPT apps are disabled the same way.
  assert.deepEqual(APP_SERVER_SPAWN_ARGS, ["-c", PEERS_MCP_DISABLE_OVERRIDE, "-c", "features.apps=false", "app-server"]);
  assert.equal(PEERS_MCP_DISABLE_OVERRIDE, "mcp_servers.claude-peers-convex.enabled=false");

  const cIndex = APP_SERVER_SPAWN_ARGS.indexOf("-c");
  const subcommandIndex = APP_SERVER_SPAWN_ARGS.indexOf("app-server");
  assert.ok(cIndex !== -1 && subcommandIndex !== -1);
  assert.ok(cIndex < subcommandIndex, "-c override must precede the app-server subcommand");
});

test("app-server child env sets PEERS_DISABLE=1 while preserving the base env", () => {
  const baseEnv = { PATH: "/usr/bin", CODEX_HOME: "/home/x/.codex" };
  const childEnv = buildAppServerChildEnv(baseEnv);
  assert.equal(childEnv.PEERS_DISABLE, "1");
  assert.equal(childEnv.PATH, "/usr/bin");
  assert.equal(childEnv.CODEX_HOME, "/home/x/.codex");
  // Must not mutate the caller's env object.
  assert.equal(baseEnv.PEERS_DISABLE, undefined);
});

// ---- #5520: the peers opt-out only goes along when the config defines the peers server ----

const PEERS_STDIO = '[mcp_servers.claude-peers-convex]\ncommand = "true"\nargs = []\n';
const PEERS_URL = '[mcp_servers.claude-peers-convex]\nurl = "http://127.0.0.1:9/mcp"\n';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function codexHomeWith(toml) {
  const home = tmp("codex-5520-home-");
  if (toml !== null) fs.writeFileSync(path.join(home, "config.toml"), toml);
  return home;
}

const hasOptOut = (args) => args.includes(PEERS_MCP_DISABLE_OVERRIDE);

test("#5520: no peers entry (empty CODEX_HOME, no file) leaves the opt-out out; apps opt-out and subcommand stay", () => {
  const cwd = tmp("codex-5520-cwd-");
  for (const home of [codexHomeWith(null), path.join(tmp("codex-5520-missing-"), "nope")]) {
    const args = buildAppServerSpawnArgs(cwd, { CODEX_HOME: home });
    assert.equal(hasOptOut(args), false);
    assert.deepEqual(args, ["-c", "features.apps=false", "app-server"]);
  }
});

test("#5520: peers as stdio command, as url, as project layer or in an unreadable config", () => {
  const cwd = tmp("codex-5520-cwd-");
  assert.deepEqual(buildAppServerSpawnArgs(cwd, { CODEX_HOME: codexHomeWith(PEERS_STDIO) }), APP_SERVER_SPAWN_ARGS);
  assert.deepEqual(buildAppServerSpawnArgs(cwd, { CODEX_HOME: codexHomeWith(PEERS_URL) }), APP_SERVER_SPAWN_ARGS);
  // Project layer.
  fs.mkdirSync(path.join(cwd, ".codex"));
  fs.writeFileSync(path.join(cwd, ".codex", "config.toml"), PEERS_STDIO);
  assert.equal(codexConfigDefinesPeers(cwd, { CODEX_HOME: codexHomeWith(null) }), true);
  // config.toml is a directory: unreadable counts as absent (safe: nothing to start).
  const odd = tmp("codex-5520-odd-");
  fs.mkdirSync(path.join(odd, "config.toml"));
  assert.equal(hasOptOut(buildAppServerSpawnArgs(tmp("codex-5520-cwd-"), { CODEX_HOME: odd })), false);
});

function codexAvailable() {
  return spawnSync("codex", ["--version"]).status === 0;
}

/** Start a real `codex app-server` with the plugin's args and wait for its answer to `initialize`. */
async function realInitialize(codexHome) {
  const cwd = tmp("codex-5520-cwd-");
  const env = buildAppServerChildEnv({ ...globalThis.process.env, CODEX_HOME: codexHome });
  const child = spawn("codex", buildAppServerSpawnArgs(cwd, env), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 15000);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (/"id":\s*1\b[^\n]*"result"/.test(stdout)) { clearTimeout(timer); resolve("initialized"); }
    });
    child.on("exit", (code) => { clearTimeout(timer); resolve(`exited ${code}`); });
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "test", title: "test", version: "0" }, capabilities: null } })}\n`);
  });
  child.kill();
  return { outcome, stderr };
}

for (const [label, toml] of [["an empty CODEX_HOME", null], ["peers as stdio command", PEERS_STDIO], ["peers as url", PEERS_URL]]) {
  test(`#5520: a real codex app-server answers initialize with ${label}`, { skip: !codexAvailable() }, async () => {
    const { outcome, stderr } = await realInitialize(codexHomeWith(toml));
    assert.equal(outcome, "initialized", stderr);
    assert.doesNotMatch(stderr, /invalid transport|not supported for stdio/);
  });
}
