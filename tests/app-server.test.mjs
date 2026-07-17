import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AppServerClientBase,
  APP_SERVER_SPAWN_ARGS,
  PEERS_MCP_DISABLE_OVERRIDE,
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

test("handleServerRequest accepts MCP elicitation requests instead of rejecting them", () => {
  const client = new CapturingClient();
  client.handleServerRequest({
    id: 7,
    method: "mcpServer/elicitation/request",
    params: { threadId: "t1" }
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
  assert.deepEqual(APP_SERVER_SPAWN_ARGS, ["-c", PEERS_MCP_DISABLE_OVERRIDE, "app-server"]);
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
