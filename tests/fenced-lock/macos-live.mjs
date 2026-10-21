// Opt-in native M2/M3 probe; run through the machine's test-slot wrapper.
// Uses the caller's existing Claude login (optionally CLAUDE_CONFIG_DIR).
// No login, installed-plugin changes, MCP calls, or live plugin state writes.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OLD_PROTOCOLS } from "./old-trees.mjs";

assert.equal(process.platform, "darwin", "native macOS only");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fenced-lock-live-"));
const lib = path.join(repo, "plugins/codex/scripts/lib");
const probe = fileURLToPath(new URL("./macos-live-probe.mjs", import.meta.url));
const quote = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
const command = [process.execPath, probe, lib, root].map(quote).join(" ");
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
// Keep the caller's native login environment (including macOS keychain
// session variables). No credentials are read, copied to disk, or printed.
const env = { ...process.env };
delete env.CLAUDECODE;
Object.assign(env, { TERM: "dumb", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
const children = [];
function start(bin, args, opts) {
  const child = spawn(bin, args, opts);
  const exit = new Promise((resolve) => {
    child.once("error", (e) => resolve({ error: e.code }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  children.push({ child, exit });
  return { child, exit };
}

try {
  const old = path.join(root, "old");
  fs.mkdirSync(old);
  execFileSync("tar", ["-x", "-C", old], { input: execFileSync("git", ["archive", OLD_PROTOCOLS.o2.ref, "plugins/codex"], { cwd: repo }) });
  const state = path.join(old, "plugins/codex/scripts/lib/state.mjs");
  assert.equal(createHash("sha256").update(fs.readFileSync(state)).digest("hex"), OLD_PROTOCOLS.o2.stateSha256);
  const script = path.join(old, "plugins/codex/scripts/codex-companion.mjs");
  fs.writeFileSync(script, `import fs from 'node:fs'; import path from 'node:path';
    import {updateState,resolveStateDir} from './lib/state.mjs';
    updateState(process.argv[2], s => {
      fs.writeFileSync(process.argv[3],path.join(resolveStateDir(process.argv[2]),'state.lock'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,180000); return s;
    });`);
  const targets = {};
  for (const route of ["shell", "hook", "bash"]) {
    const workspace = path.join(root, `ws-${route}`);
    fs.mkdirSync(workspace);
    const ready = path.join(root, `${route}.ready`);
    const { child } = start(process.execPath, [script, workspace, ready], {
      env: { ...env, CLAUDE_PLUGIN_DATA: path.join(root, `data-${route}`) }, stdio: "ignore"
    });
    const end = Date.now() + 10_000;
    while (!fs.existsSync(ready)) {
      assert.ok(Date.now() < end, "O2 fixture did not enter its section");
      await new Promise((r) => setTimeout(r, 20));
    }
    const fence = fs.readFileSync(ready, "utf8");
    fs.unlinkSync(fence); // fixture's own old writer loses its pathname
    targets[route] = { pid: child.pid, fence };
  }
  json(path.join(root, "targets.json"), targets);
  const plugin = path.join(root, "plugin");
  for (const d of [".claude-plugin", "hooks", "commands"]) fs.mkdirSync(path.join(plugin, d), { recursive: true });
  json(path.join(plugin, ".claude-plugin/plugin.json"), { name: "codex", version: "0.0.0", description: "Native lock visibility probe" });
  json(path.join(plugin, "hooks/hooks.json"), { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${command} hook`, timeout: 30 }] }] } });
  fs.writeFileSync(path.join(plugin, "commands/native-probe.md"), `---\ndescription: Native lock visibility probe\nallowed-tools: Bash(node:*)\n---\nRun exactly this Bash command once, and return its output:\n\n\x60\x60\x60bash\n${command} bash\n\x60\x60\x60\nDo not run any other commands.\n`);
  const denied = path.join(root, "outside-denied");
  fs.mkdirSync(denied);
  const settings = path.join(root, "settings.json");
  json(settings, {
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: [denied] } },
    enabledPlugins: {}, permissions: { allow: ["Bash(node:*)"] }
  });
  execFileSync(process.execPath, [probe, lib, root, "shell"], { cwd: root, env });
  const stdout = fs.openSync(path.join(root, "claude.jsonl"), "w");
  const stderr = fs.openSync(path.join(root, "claude.stderr"), "w");
  const args = ["-p", "/codex:native-probe", "--plugin-dir", plugin, "--setting-sources", "", "--settings", settings,
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "Bash", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--max-turns", "3"];
  const run = start("claude", args, { cwd: root, env, stdio: ["ignore", stdout, stderr] });
  const timer = setTimeout(() => run.child.kill("SIGTERM"), 120_000);
  const killTimer = setTimeout(() => run.child.kill("SIGKILL"), 125_000);
  const claudeExit = await run.exit;
  clearTimeout(timer);
  clearTimeout(killTimer);
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  const results = Object.fromEntries(["shell", "hook", "bash"].map((route) => {
    try { return [route, JSON.parse(fs.readFileSync(path.join(root, `${route}.json`), "utf8"))]; } catch { return [route, null]; }
  }));
  const passed = claudeExit.code === 0 && Object.values(results).every((r) => r?.targetInS0 && !r.acquired && r.sealedAt === null && !r.error && !r.observation?.error)
    && results.shell.sandboxWitness === "write-allowed" && results.hook.sandboxWitness === "write-allowed" && results.bash.sandboxWitness === "write-denied";
  const summary = { root, passed, claudeExit, ...results };
  json(path.join(root, "summary.json"), summary);
  console.log(JSON.stringify(summary));
  process.exitCode = passed ? 0 : 1;
} finally {
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(children.map(({ exit }) => exit));
}
