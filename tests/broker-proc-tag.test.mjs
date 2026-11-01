// Factory #1762: the shared broker starts without the process tag of the session that started it, so a Factory host
// does not stop it when that one session closes while another session still uses it.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { brokerSpawnEnv, spawnBrokerProcess } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const TAG = "0123456789abcdef0123456789abcdef";

test("brokerSpawnEnv drops FACTORY_PROC_TAG and keeps the rest", () => {
  const out = brokerSpawnEnv({ FACTORY_PROC_TAG: TAG, FACTORY_SESSION_KEY: "session-a", PATH: "/bin" });
  assert.equal(out.FACTORY_PROC_TAG, undefined);
  assert.equal(out.FACTORY_SESSION_KEY, "session-a");
  assert.equal(out.PATH, "/bin");
});

test("spawnBrokerProcess: the spawned broker process has no FACTORY_PROC_TAG", async () => {
  const dir = makeTempDir();
  const script = path.join(dir, "dump-env.mjs");
  const out = path.join(dir, "env.json");
  // Stands in for app-server-broker.mjs: records its own environment and exits.
  fs.writeFileSync(script, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ tag: process.env.FACTORY_PROC_TAG ?? null, path: process.env.PATH ?? null }));\n`);
  spawnBrokerProcess({
    scriptPath: script,
    cwd: dir,
    endpoint: "unix:" + path.join(dir, "broker.sock"),
    pidFile: path.join(dir, "broker.pid"),
    logFile: path.join(dir, "broker.log"),
    env: { ...process.env, FACTORY_PROC_TAG: TAG }
  });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const seen = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(seen.tag, null);
  assert.equal(seen.path, process.env.PATH ?? null);
});
