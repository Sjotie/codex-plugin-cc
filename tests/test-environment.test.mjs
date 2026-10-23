import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const helpers = new URL("./helpers.mjs", import.meta.url).href;
const state = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;

test("helpers discard inherited agent session and plugin locations before state resolution", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-environment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginData = path.join(root, "agent-plugin-data");
  const providerConfig = path.join(root, "agent-provider-config");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const names = ["CODEX_COMPANION_SESSION_ID", "CODEX_COMPANION_TRANSCRIPT_PATH", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PLUGIN_DATA", "CLAUDE_CONFIG_DIR"];
  const env = { ...process.env, NODE_OPTIONS: "", FENCED_LOCK_SCAN_SCOPE: "",
    ...Object.fromEntries(names.map(name => [name, "inherited-agent-value"])),
    CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: providerConfig };
  const code = `await import(${JSON.stringify(helpers)});
    const m = await import(${JSON.stringify(state)});
    console.log(JSON.stringify({ inherited: ${JSON.stringify(names)}.filter(name => Object.hasOwn(process.env, name)), stateDir: m.resolveStateDir(process.cwd()) }));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: workspace, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.inherited, []);
  assert.equal(output.stateDir.startsWith(pluginData + path.sep), false);
  assert.equal(fs.existsSync(pluginData), false);
  assert.equal(fs.existsSync(providerConfig), false);
});
