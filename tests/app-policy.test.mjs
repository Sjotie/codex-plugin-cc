// #1796: every Codex child this plugin starts runs with ChatGPT apps off, a
// broker under another (or no) app policy is never reused, and app consent is
// never auto-accepted.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { AppServerClientBase, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { ensureBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const APPS_OFF = "features.apps=false";

class CapturingClient extends AppServerClientBase {
  constructor() {
    super(process.cwd());
    this.sent = [];
  }
  sendMessage(message) {
    this.sent.push(message);
  }
}

function elicitationAction(params) {
  const client = new CapturingClient();
  client.handleServerRequest({ id: 1, method: "mcpServer/elicitation/request", params });
  return client.sent[0].result.action;
}

/**
 * A stand-in broker on a unix socket: answers `initialize` with `initResult`
 * and `broker/shutdown` with busy, like a broker serving another client.
 */
async function startFakeBroker(t, initResult) {
  const dir = makeTempDir("cxc-1796-");
  const endpoint = createBrokerEndpoint(dir, process.platform);
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          socket.write(`${JSON.stringify({ id: message.id, result: initResult })}\n`);
        } else if (message.method === "broker/shutdown") {
          socket.write(`${JSON.stringify({ id: message.id, error: { code: -32001, message: "busy" } })}\n`);
        } else if (message.id !== undefined) {
          socket.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(parseBrokerEndpoint(endpoint).path, resolve));
  t.after(() => server.close());
  return { endpoint, dir };
}

test("app-server children start with ChatGPT apps disabled before the subcommand", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "-C", repo, "inspect the target workspace"], {
    cwd: makeTempDir(),
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.ok(
    fakeState.appServerConfigOverrides.includes(APPS_OFF),
    `expected ${APPS_OFF} in ${JSON.stringify(fakeState.appServerConfigOverrides)}`
  );
  // The peers override from before stays.
  assert.ok(fakeState.appServerConfigOverrides.includes("mcp_servers.claude-peers-convex.enabled=false"));
});

test("MCP elicitations: local forms accepted; apps server, URL and unknown modes declined", () => {
  assert.equal(elicitationAction({ serverName: "local-db", threadId: "t", mode: "form", message: "ok?", requestedSchema: {} }), "accept");
  assert.equal(elicitationAction({ serverName: "codex_apps", threadId: "t", mode: "form", message: "ok?", requestedSchema: {} }), "decline");
  assert.equal(elicitationAction({ serverName: "local-db", threadId: "t", mode: "openai/form", message: "ok?", requestedSchema: {} }), "accept");
  assert.equal(elicitationAction({ serverName: "local-db", threadId: "t", mode: "openaiForm", message: "ok?", requestedSchema: {} }), "accept");
  assert.equal(elicitationAction({ serverName: "codex_apps", threadId: "t", mode: "openai/form", message: "ok?", requestedSchema: {} }), "decline");
  assert.equal(elicitationAction({ serverName: "local-db", threadId: "t", mode: "something-new" }), "decline");
  assert.equal(elicitationAction({ serverName: "local-db", threadId: "t", mode: "url", message: "sign in", url: "https://example.invalid", elicitationId: "e" }), "decline");
  assert.equal(elicitationAction({ threadId: "t", mode: "form" }), "decline");
  assert.equal(elicitationAction(undefined), "decline");
});

test("a broker without the current app policy (legacy or env endpoint) is not used; the run goes direct", { skip: process.platform === "win32" }, async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const legacy = await startFakeBroker(t, { userAgent: "codex-companion-broker" });

  const client = await CodexAppServerClient.connect(makeTempDir(), { brokerEndpoint: legacy.endpoint, env });
  t.after(() => client.close());
  assert.equal(client.transport, "direct");
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.ok(fakeState.appServerConfigOverrides.includes(APPS_OFF));
});

test("a broker that reports the current app policy is still reused", { skip: process.platform === "win32" }, async (t) => {
  const current = await startFakeBroker(t, { userAgent: "codex-companion-broker", appPolicy: "apps:deny-v1" });
  const client = await CodexAppServerClient.connect(makeTempDir(), { brokerEndpoint: current.endpoint });
  t.after(() => client.close());
  assert.equal(client.transport, "broker");
});

test("a busy broker recorded without app policy is not reused by ensureBrokerSession", { skip: process.platform === "win32" }, async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const legacy = await startFakeBroker(t, { userAgent: "codex-companion-broker" });
  const pidFile = path.join(legacy.dir, "broker.pid");
  fs.writeFileSync(pidFile, String(process.pid));
  saveBrokerSession(workspace, {
    endpoint: legacy.endpoint,
    pidFile,
    pid: process.pid,
    runtime: { pluginVersion: "0.0.0-old", codexVersion: "codex-cli test" }
  });

  const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir) });
  assert.equal(session, null);
});

test("status names a broker under a legacy app policy", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));
  saveBrokerSession(workspace, { endpoint: "unix:/tmp/fake-broker-1796.sock" });

  const env = { ...process.env, PATH: binDir };
  delete env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
  const setup = run("node", [SCRIPT, "setup", "--cwd", workspace, "--json"], { cwd: makeTempDir(), env });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.brokerAppPolicy, "legacy");
  assert.match(payload.sessionRuntime.label, /app policy legacy: replaced when idle, bypassed while busy/);
});

test("an interrupt still reaches a legacy broker that owns the turn", { skip: process.platform === "win32" }, async (t) => {
  const legacy = await startFakeBroker(t, { userAgent: "codex-companion-broker" });
  const client = await CodexAppServerClient.connect(makeTempDir(), { brokerEndpoint: legacy.endpoint, allowLegacyBroker: true });
  t.after(() => client.close());
  assert.equal(client.transport, "broker");
});
