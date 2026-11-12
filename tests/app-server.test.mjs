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
  PEERS_MCP_TRANSPORT_OVERRIDE,
  buildAppServerChildEnv
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
  assert.deepEqual(APP_SERVER_SPAWN_ARGS, ["-c", PEERS_MCP_DISABLE_OVERRIDE, "-c", PEERS_MCP_TRANSPORT_OVERRIDE, "-c", "features.apps=false", "app-server"]);
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

function codexAvailable() {
  return spawnSync("codex", ["--version"]).status === 0;
}

test("#5520: the peers opt-out carries a transport, so Codex without a peers entry in config.toml still starts", () => {
  // Codex 0.166 rejects `mcp_servers.<name>` with only `enabled=false` ("invalid transport") when no config layer
  // defines the name with a command or url (e.g. an empty CODEX_HOME).
  assert.match(PEERS_MCP_TRANSPORT_OVERRIDE, /^mcp_servers\.claude-peers-convex\.url=/);
  assert.ok(APP_SERVER_SPAWN_ARGS.includes(PEERS_MCP_TRANSPORT_OVERRIDE));
});

test("#5520: a real `codex app-server` with the spawn args and an empty CODEX_HOME does not die on invalid transport", { skip: !codexAvailable() }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-5520-"));
  try {
    const child = spawn("codex", APP_SERVER_SPAWN_ARGS, { env: buildAppServerChildEnv({ ...globalThis.process.env, CODEX_HOME: home }), stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const state = await new Promise((resolve) => {
      child.on("exit", () => resolve("exited"));
      setTimeout(() => { child.kill(); resolve("running"); }, 3000);
    });
    assert.equal(state, "running", `app-server exited early: ${stderr}`);
    assert.doesNotMatch(stderr, /invalid transport/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
