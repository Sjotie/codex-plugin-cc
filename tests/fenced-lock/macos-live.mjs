// Opt-in M2/M3 route-2 proof. Always run through the machine test-slot.
// Existing login only; real product SessionStart + real sandboxed Bash.
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OLD_PROTOCOLS } from "./old-trees.mjs";

assert.equal(process.platform, "darwin", "native macOS only");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fenced-lock-route2-"));
let product = repo;
const productRef = process.env.FENCED_LOCK_PRODUCT_REF;
if (productRef) {
  product = path.join(root, "product");
  fs.mkdirSync(product);
  execFileSync("tar", ["-x", "-C", product], { input: execFileSync("git", ["archive", productRef, "plugins/codex"], { cwd: repo }) });
}
const lib = path.join(product, "plugins/codex/scripts/lib");
const sourceHashes = Object.fromEntries(["fenced-lock.mjs", "state.mjs", "../session-lifecycle-hook.mjs", "../../hooks/hooks.json"].map((name) => [name, createHash("sha256").update(fs.readFileSync(path.join(lib, name))).digest("hex")]));
const probe = fileURLToPath(new URL("./macos-live-probe.mjs", import.meta.url));
const observer = fileURLToPath(new URL("./macos-live-hook.mjs", import.meta.url));
const quote = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const env = { ...process.env };
for (const name of Object.keys(env)) if (name.startsWith("CODEX_COMPANION_") || name === "CLAUDE_CODE_SESSION_ID" || name === "CLAUDECODE" || name === "NODE_OPTIONS") delete env[name];
Object.assign(env, { TERM: "dumb", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_PLUGIN_DATA: path.join(root, "data") });
const children = [];
function start(bin, args, opts) {
  const child = spawn(bin, args, opts);
  const exit = new Promise((resolve) => {
    child.once("error", (e) => resolve({ error: e.code }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const handle = { child, exit };
  children.push(handle);
  return handle;
}
const results = [];
const hookOnly = process.env.FENCED_LOCK_NATIVE_HOOK_ONLY === "1";
try {
  const old = path.join(root, "old");
  fs.mkdirSync(old);
  execFileSync("tar", ["-x", "-C", old], { input: execFileSync("git", ["archive", OLD_PROTOCOLS.o2.ref, "plugins/codex"], { cwd: repo }) });
  const state = path.join(old, "plugins/codex/scripts/lib/state.mjs");
  assert.equal(createHash("sha256").update(fs.readFileSync(state)).digest("hex"), OLD_PROTOCOLS.o2.stateSha256);
  const script = path.join(old, "plugins/codex/scripts/codex-companion.mjs");
  const ready = path.join(root, "old.ready");
  fs.writeFileSync(script, `import fs from 'node:fs';import path from 'node:path';import {updateState,resolveStateDir} from './lib/state.mjs';updateState(process.argv[2],s=>{fs.writeFileSync(process.argv[3],path.join(resolveStateDir(process.argv[2]),'state.lock'));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600000);return s;});`);
  const writer = start(process.execPath, [script, root, ready], { env, stdio: "ignore" });
  const end = Date.now() + 10_000;
  while (!fs.existsSync(ready)) {
    assert.ok(Date.now() < end, "O2 writer did not enter its section");
    await new Promise((r) => setTimeout(r, 20));
  }
  const fence = fs.readFileSync(ready, "utf8");
  fs.unlinkSync(fence);
  json(path.join(root, "target.json"), { pid: writer.child.pid, fence, oldStateSha256: OLD_PROTOCOLS.o2.stateSha256 });
  const plugin = path.join(root, "plugin");
  for (const d of [".claude-plugin", "hooks", "commands"]) fs.mkdirSync(path.join(plugin, d), { recursive: true });
  json(path.join(plugin, ".claude-plugin/plugin.json"), { name: "codex", version: "0.0.0", description: "Native SessionStart admission proof" });
  const denied = path.join(root, "outside-denied");
  fs.mkdirSync(denied);
  const settings = path.join(root, "settings.json");
  json(settings, {
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: [denied] } },
    enabledPlugins: {}, permissions: { allow: ["Bash(node:*)"] }
  });
  for (const mode of ["old-writer", "admitted", "missing-record", "replaced-fence", "different-root"]) {
    if (mode === "admitted") {
      writer.child.kill("SIGTERM");
      await writer.exit;
    }
    // Deliberately broken fences from one refusal case cannot contaminate the
    // next hook's preparation. Only old-writer -> admitted shares a state root.
    const runEnv = { ...env, CLAUDE_PLUGIN_DATA: ["old-writer", "admitted"].includes(mode) ? env.CLAUDE_PLUGIN_DATA : path.join(root, `data-${mode}`) };
    const command = [process.execPath, probe, lib, root, mode].map(quote).join(" ");
    const hookCommand = [process.execPath, observer, lib, root, mode].map(quote).join(" ");
    json(path.join(plugin, "hooks/hooks.json"), { hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand, timeout: 40 }] }] } });
    fs.writeFileSync(path.join(plugin, "commands/native-probe.md"), `---\ndescription: Native route-2 lock proof\nallowed-tools: Bash(node:*)\n---\nRun exactly this Bash command once, and return its output:\n\n\x60\x60\x60bash\n${command}\n\x60\x60\x60\nDo not run any other commands.\n`);
    const stdout = fs.openSync(path.join(root, `${mode}.claude.jsonl`), "w");
    const stderr = fs.openSync(path.join(root, `${mode}.claude.stderr`), "w");
    const args = ["-p", "/codex:native-probe", "--plugin-dir", plugin, "--setting-sources", "", "--settings", settings,
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "Bash", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--max-turns", "3"];
    let claudeExit;
    if (hookOnly) {
      const envFile = path.join(root, `${mode}.env`);
      fs.writeFileSync(envFile, "");
      const run = spawnSync(process.execPath, [observer, lib, root, mode], {
        cwd: root, env: { ...runEnv, CLAUDE_ENV_FILE: envFile },
        input: JSON.stringify({ cwd: root, session_id: `native-hook-${process.pid}-${mode}`, hook_event_name: "SessionStart" }),
        encoding: "utf8", timeout: 40_000, stdio: ["pipe", stdout, stderr]
      });
      claudeExit = { code: run.status, signal: run.signal, error: run.error?.code ?? null };
    } else {
      const run = start("claude", args, { cwd: root, env: runEnv, stdio: ["ignore", stdout, stderr] });
      const timer = setTimeout(() => run.child.kill("SIGTERM"), 120_000);
      const killTimer = setTimeout(() => run.child.kill("SIGKILL"), 125_000);
      claudeExit = await run.exit;
      clearTimeout(timer); clearTimeout(killTimer);
    }
    fs.closeSync(stdout); fs.closeSync(stderr);
    const read = (suffix) => { try { return JSON.parse(fs.readFileSync(path.join(root, `${mode}.${suffix}.json`), "utf8")); } catch { return null; } };
    const hook = read("hook"), bash = read("bash");
    const sameFenceAsRefusal = mode === "admitted" ? JSON.stringify(hook?.fenceIdentity) === JSON.stringify(results.find((result) => result.mode === "old-writer")?.hook?.fenceIdentity) && Boolean(hook?.fenceIdentity) : null;
    const mutationProven = mode === "missing-record" ? hook?.mutation === "removed-record" && hook.recordPresentAfterMutation === false :
      mode === "replaced-fence" ? hook?.mutation === "copied-and-replaced-fence" && Boolean(hook.fenceIdentity) && JSON.stringify(hook.fenceIdentity) !== JSON.stringify(hook.finalFenceIdentity) : true;
    const hookPassed = hook && !hook.exit.error && hook.hookDurationMs < hook.productionTimeoutMs && hook.observation && !hook.observation.error && mutationProven && (mode !== "admitted" || sameFenceAsRefusal) &&
      (mode === "old-writer" ? hook.targetInS0 && !hook.sealedAt && !hook.certificateExported : hook.exit.code === 0 && hook.certificateExported && Boolean(hook.sealedAt));
    const passed = hookPassed && (hookOnly || claudeExit.code === 0 && bash?.passed);
    let blocker = null;
    if (!hookOnly && !bash) {
      const events = fs.readFileSync(path.join(root, `${mode}.claude.jsonl`), "utf8").split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      const failure = events.find((event) => event.type === "result" && event.api_error);
      blocker = failure?.api_error ?? "Bash tool did not produce evidence";
    }
    results.push({ mode, passed: Boolean(passed), scope: hookOnly ? "native-hook-only" : "real-Claude-hook-and-sandboxed-Bash", blocker, sameFenceAsRefusal, mutationProven, claudeExit, hook, bash });
    for (const [name, hash] of Object.entries(sourceHashes)) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(lib, name))).digest("hex"), hash, `product source changed during native run: ${name}`);
    json(path.join(root, "summary.json"), { root, productRef: productRef ?? "working-tree", sourceHashes, hookOnly, passed: results.every((r) => r.passed), results });
    console.log(JSON.stringify(results.at(-1)));
    assert.ok(passed, `${mode} failed; evidence: ${root}`);
  }
  console.log(JSON.stringify({ root, productRef: productRef ?? "working-tree", passed: true, scenarios: results.length }));
} finally {
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(children.map(({ exit }) => exit));
  console.log(JSON.stringify({ evidenceRoot: root }));
}
