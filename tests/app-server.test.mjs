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
  buildAppServerSpawnArgs
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

// ---- #5520: the peers opt-out only goes along when Codex itself knows the peers server ----
// These run the real `codex` (skipped when it is missing): Codex decides what is defined, so layers, trust, TOML
// escapes and comments are judged by Codex, not by us.

const PEERS_STDIO = '[mcp_servers.claude-peers-convex]\ncommand = "true"\nargs = []\n';
const PEERS_URL = '[mcp_servers.claude-peers-convex]\nurl = "http://127.0.0.1:9/mcp"\n';
const PEERS_QUOTED = '[mcp_servers."claude-peers-convex"]\ncommand = "true"\nargs = []\n';
const PEERS_COMMENT_ONLY = "# claude-peers-convex is not configured here\n";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function codexHomeWith(toml) {
  const home = tmp("codex-5520-home-");
  if (toml !== null) fs.writeFileSync(path.join(home, "config.toml"), toml);
  return home;
}

function envFor(codexHome) {
  return buildAppServerChildEnv(Object.assign({}, process.env, { CODEX_HOME: codexHome }));
}

const hasOptOut = (args) => args.includes(PEERS_MCP_DISABLE_OVERRIDE);

const codexAvailable = spawnSync("codex", ["--version"]).status === 0;
const real = { skip: !codexAvailable };

/** The effective state of the peers server under the plugin's own overrides: `codex <overrides> mcp get`. */
function effectivePeers(args, cwd, env) {
  const overrides = args.slice(0, args.indexOf("app-server"));
  const r = spawnSync("codex", [...overrides, "mcp", "get", "claude-peers-convex", "--json"], { cwd, env, encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) return null;
  // Only the `enabled` flag leaves this function: the output can carry env and headers of a server (#4709), so it is
  // never returned, logged or put in an assertion message, even when it does not parse.
  try {
    return { enabled: JSON.parse(r.stdout).enabled };
  } catch {
    return { enabled: undefined };
  }
}

/** Start a real `codex app-server` with the plugin's args and wait for its answer to `initialize`. */
async function realInitialize(args, cwd, env) {
  const child = spawn("codex", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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

const CASES = [
  { label: "an empty CODEX_HOME", toml: null, known: false },
  { label: "a config that only mentions the name in a comment", toml: PEERS_COMMENT_ONLY, known: false },
  { label: "peers as stdio command", toml: PEERS_STDIO, known: true },
  { label: "peers as url", toml: PEERS_URL, known: true },
  { label: 'peers under a quoted TOML key ("claude-peers-convex")', toml: PEERS_QUOTED, known: true }
];

for (const { label, toml, known } of CASES) {
  test(`#5520: ${label}: opt-out ${known ? "passed and effective (enabled=false)" : "left out"}, app-server answers initialize`, real, async () => {
    const cwd = tmp("codex-5520-cwd-");
    const env = envFor(codexHomeWith(toml));
    const args = buildAppServerSpawnArgs(cwd, env);
    assert.equal(hasOptOut(args), known);
    assert.deepEqual(args.slice(-1), ["app-server"]);
    assert.ok(args.includes("features.apps=false"));
    if (known) {
      // Not just "it started": Codex reports the server as disabled under these overrides.
      assert.equal(effectivePeers(args, cwd, env)?.enabled, false);
      assert.equal(effectivePeers(["app-server"], cwd, env)?.enabled, true);
    }
    const { outcome, stderr } = await realInitialize(args, cwd, env);
    // stderr stays out of the message: it can echo config (#4709).
    assert.equal(outcome, "initialized", `app-server did not initialize (${outcome}); stderr length ${stderr.length}`);
    assert.doesNotMatch(stderr, /invalid transport|not supported for stdio/);
  });
}

test("#5520: peers defined in a project layer (.codex/config.toml in cwd) count", real, () => {
  const cwd = tmp("codex-5520-cwd-");
  fs.mkdirSync(path.join(cwd, ".codex"));
  fs.writeFileSync(path.join(cwd, ".codex", "config.toml"), PEERS_STDIO);
  const env = envFor(codexHomeWith(null));
  // Codex only loads a project layer for a trusted project; either answer is fine as long as args and Codex agree.
  const args = buildAppServerSpawnArgs(cwd, env);
  assert.equal(hasOptOut(args), effectivePeers(["app-server"], cwd, env) !== null);
});

test("#5520: a missing codex binary or failing `mcp get` leaves the opt-out out", () => {
  const cwd = tmp("codex-5520-cwd-");
  const args = buildAppServerSpawnArgs(cwd, { PATH: tmp("codex-5520-nopath-") });
  assert.deepEqual(args, ["-c", "features.apps=false", "app-server"]);
});

