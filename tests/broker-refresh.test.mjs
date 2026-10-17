import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { APPS_POLICY_ID } from "../plugins/codex/scripts/lib/app-policy.mjs";
import { BROKER_BUSY_RPC_CODE } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  clearBrokerSession,
  ensureBrokerSession,
  loadBrokerSession,
  resolveBrokerRuntimeIdentity,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

async function staleBrokerFixture(t, { appPolicy = APPS_POLICY_ID } = {}) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const runtime = resolveBrokerRuntimeIdentity(repo, env);
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const sockets = new Set();
  const shutdownOutcomes = [];
  let releaseProbes;
  const probeGate = new Promise((resolve) => { releaseProbes = resolve; });

  // Hold zero-byte readiness probes after their FIN until explicitly released.
  // This makes a probe followed by a separate shutdown connection overlap on
  // every run, just as the real broker's delayed close callback can under load.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let receivedData = false;
    socket.on("data", (chunk) => {
      receivedData = true;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        assert.equal(message.method, "broker/shutdown");
        // Match the real broker: even a silent second client prevents shutdown.
        const busy = [...sockets].some((other) => other !== socket);
        shutdownOutcomes.push(busy ? "busy" : "accepted");
        socket.end(`${JSON.stringify(busy
          ? { id: message.id, error: { code: BROKER_BUSY_RPC_CODE, message: "Shared Codex broker is busy." } }
          : { id: message.id, result: {} })}\n`);
        if (!busy) server.close();
      }
    });
    socket.on("end", () => {
      if (receivedData) {
        socket.end();
      } else {
        probeGate.then(() => { if (!socket.destroyed) socket.end(); });
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });

  const stop = async () => {
    releaseProbes();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(sessionDir, { recursive: true, force: true });
  };
  t.after(async () => {
    // Fake sessions deliberately have no pid; only ensureBrokerSession can
    // record a child here, so cleanup never signals this test runner's pid.
    const replacement = loadBrokerSession(repo);
    if (Number.isFinite(replacement?.pid)) terminateProcessTree(replacement.pid);
    clearBrokerSession(repo);
    await stop();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(parseBrokerEndpoint(endpoint).path, resolve);
  });
  const staleRuntime = { ...runtime, pluginVersion: "0.0.0-stale" };
  if (appPolicy === null) delete staleRuntime.appPolicy;
  else staleRuntime.appPolicy = appPolicy;
  const session = { endpoint, sessionDir, runtime: staleRuntime };
  saveBrokerSession(repo, session);

  return {
    repo, runtime, session, server, shutdownOutcomes, stop,
    refresh: () => ensureBrokerSession(repo, { env, sweep: { tmpdir: repo } }),
    appServerStarts: () => fs.existsSync(path.join(binDir, "fake-codex-state.json"))
      ? JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8")).appServerStarts
      : 0
  };
}

test("a stale idle broker refreshes without a readiness probe blocking its shutdown", async (t) => {
  const fixture = await staleBrokerFixture(t);
  const replacement = await fixture.refresh();

  assert.deepEqual(fixture.shutdownOutcomes, ["accepted"]);
  assert.ok(replacement?.pid, "a replacement broker should have started");
  assert.notEqual(replacement.endpoint, fixture.session.endpoint);
  assert.deepEqual(replacement.runtime, fixture.runtime);
  assert.deepEqual(loadBrokerSession(fixture.repo), replacement);
  assert.equal(fixture.appServerStarts(), 1);
});

for (const [label, appPolicy, reusable] of [
  ["matching", APPS_POLICY_ID, true],
  ["different", "apps:other-policy", false],
  ["missing", null, false]
]) {
  test(`a stale broker with a connected client and ${label} app policy is preserved`, async (t) => {
    const fixture = await staleBrokerFixture(t, { appPolicy });
    // Await acceptance on the server as well as connect on the client: this
    // socket has not sent any RPC, but it is already a real broker client.
    const accepted = once(fixture.server, "connection");
    const client = net.createConnection({ path: parseBrokerEndpoint(fixture.session.endpoint).path });
    t.after(() => client.destroy());
    client.on("error", () => {});
    const [[peer]] = await Promise.all([accepted, once(client, "connect")]);

    const result = await fixture.refresh();

    assert.deepEqual(fixture.shutdownOutcomes, ["busy"]);
    assert.deepEqual(result, reusable ? fixture.session : null);
    assert.deepEqual(loadBrokerSession(fixture.repo), fixture.session);
    assert.equal(fixture.server.listening, true);
    assert.equal(peer.destroyed, false, "the other client's socket must survive");
    assert.equal(fixture.appServerStarts(), 0);
  });
}

test("a stale broker with an unreachable endpoint is replaced", async (t) => {
  const fixture = await staleBrokerFixture(t);
  await fixture.stop();

  const replacement = await fixture.refresh();

  assert.deepEqual(fixture.shutdownOutcomes, []);
  assert.ok(replacement?.pid, "a dead endpoint must not prevent replacement");
  assert.notEqual(replacement.endpoint, fixture.session.endpoint);
  assert.deepEqual(replacement.runtime, fixture.runtime);
  assert.deepEqual(loadBrokerSession(fixture.repo), replacement);
  assert.equal(fixture.appServerStarts(), 1);
});
