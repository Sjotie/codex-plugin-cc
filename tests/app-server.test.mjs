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
  assert.deepEqual(APP_SERVER_SPAWN_ARGS, [
    "-c", PEERS_MCP_DISABLE_OVERRIDE,
    "-c", PEERS_MCP_TRANSPORT_OVERRIDE,
    "-c", "features.apps=false",
    "app-server"
  ]);
  // #6110: a transport must accompany enabled=false, or a host without the block breaks.
  assert.equal(PEERS_MCP_TRANSPORT_OVERRIDE, "mcp_servers.claude-peers-convex.command=disabled");
  assert.ok(!PEERS_MCP_TRANSPORT_OVERRIDE.includes('"'), "no quotes: they get lost through cmd.exe on Windows");
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

// #6110: against the real codex binary (skipped when absent): an empty CODEX_HOME and
// a CODEX_HOME with a real stdio block must both start and answer initialize.
for (const [label, config] of [
  ["no config.toml", null],
  ["a real stdio block", '[mcp_servers.claude-peers-convex]\ncommand = "bun"\nargs = ["x"]\n']
]) {
  test(`real codex app-server answers initialize with ${label} (#6110)`, async (t) => {
    const probe = spawnSync("codex", ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) {
      t.skip("codex CLI not installed");
      return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-6110-"));
    if (config) fs.writeFileSync(path.join(home, "config.toml"), config);
    const child = spawn("codex", APP_SERVER_SPAWN_ARGS, {
      env: { ...buildAppServerChildEnv(), CODEX_HOME: home },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const exited = new Promise((resolve) => child.once("close", resolve));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no initialize reply; stderr: ${stderr.slice(0, 500)}`)), 15000);
        child.once("error", (e) => { clearTimeout(timer); reject(e); });
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`codex exited (${code}); stderr: ${stderr.slice(0, 500)}`)); });
        child.stdout.on("data", (d) => {
          stdout += d;
          if (stdout.split("\n").some((line) => /^\{"id":1,/.test(line) && line.includes('"result"'))) {
            clearTimeout(timer);
            resolve(undefined);
          }
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "t", version: "0" } } }) + "\n");
      });
      assert.doesNotMatch(stderr, /invalid transport/);
    } finally {
      child.removeAllListeners("exit");
      child.kill();
      await exited;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
