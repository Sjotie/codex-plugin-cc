// Opt-in native companion proof. Run through test-slot with an existing login.
// Product hooks and their raw commands are byte-equal copies; the preload only
// confines data, observes process-inspection calls, and injects named faults.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OLD_PROTOCOLS } from "./old-trees.mjs";

assert.equal(process.platform, "darwin", "native macOS only");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fenced-lock-companion-"));
const productRef = process.env.FENCED_LOCK_PRODUCT_REF;
const product = productRef ? path.join(root, "product") : repo;
const plugin = path.join(root, "plugin");
const bootstrap = fileURLToPath(new URL("./macos-companion-bootstrap.mjs", import.meta.url));
const probe = fileURLToPath(new URL("./macos-companion-probe.mjs", import.meta.url));
const replay = fileURLToPath(new URL("./macos-companion-replay.mjs", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const readLines = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } };
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const harnessHashes = Object.fromEntries([fileURLToPath(import.meta.url), bootstrap, probe, replay].map((file) => [path.basename(file), hash(file)]));
if (productRef) {
  fs.mkdirSync(product);
  execFileSync("tar", ["-x", "-C", product], { input: execFileSync("git", ["archive", productRef, "plugins/codex"], { cwd: repo }) });
}
fs.mkdirSync(plugin);
const files = productRef ? execFileSync("git", ["ls-tree", "-r", "--name-only", productRef, "plugins/codex"], { cwd: repo, encoding: "utf8" }).trim().split("\n") : execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "plugins/codex"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
const sourceHashes = {};
for (const file of [...new Set(files)]) {
  assert.ok(file.startsWith("plugins/codex/"));
  assert.ok(!path.basename(file).startsWith(".env"), "environment files cannot enter the fixture");
  const source = path.join(product, file), target = path.join(plugin, file.slice("plugins/codex/".length));
  assert.ok(fs.lstatSync(source).isFile(), `regular product file required: ${file}`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  sourceHashes[file] = hash(source);
}
const hooksFile = path.join(plugin, "hooks/hooks.json"), hooks = readJson(hooksFile);
const sessionStartCommand = hooks.hooks.SessionStart[0].hooks[0].command;
const sessionStartTimeoutMs = hooks.hooks.SessionStart[0].hooks[0].timeout * 1000;
assert.equal(sessionStartCommand, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs" SessionStart');
const hooksSha256 = hash(hooksFile);
const bin = path.join(root, "bin"); fs.mkdirSync(bin);
// Avoid helpers.mjs: its test-wide scan-scope preload would invalidate native
// evidence. Only its trivial executable-file writer is replaced here.
const fakeSourceFile = path.join(repo, "tests/fake-codex-fixture.mjs");
const isolatedFake = fs.readFileSync(fakeSourceFile, "utf8").replace('import { writeExecutable } from "./helpers.mjs";', 'const writeExecutable = (file, source) => fs.writeFileSync(file, source, { encoding: "utf8", mode: 0o755 });');
assert.ok(!isolatedFake.includes('from "./helpers.mjs"'));
const fakeModule = path.join(root, "isolated-fake-codex-fixture.mjs"); fs.writeFileSync(fakeModule, isolatedFake);
const { installFakeCodex } = await import(pathToFileURL(fakeModule)); installFakeCodex(bin, "adversarial-clean");
fs.mkdirSync(path.join(root, "codex-home")); fs.mkdirSync(path.join(root, "outside-denied"));
execFileSync("git", ["init", "--quiet", root]); fs.writeFileSync(path.join(root, "README.md"), "Owned native lifecycle fixture.\n");
execFileSync("git", ["add", "README.md"], { cwd: root });
execFileSync("git", ["-c", "user.name=Native Fixture", "-c", "user.email=native-fixture@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: root });
const settings = path.join(root, "settings.json");
json(settings, { sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: [path.join(root, "outside-denied")] } }, enabledPlugins: {}, permissions: { allow: ["Bash(node:*)"] } });
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("CODEX_COMPANION_") || key.startsWith("FENCED_LOCK_SCAN_") || ["CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "NODE_OPTIONS"].includes(key)) delete env[key];
Object.assign(env, { TERM: "dumb", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", FENCED_LOCK_NATIVE_ROOT: root, FENCED_LOCK_NATIVE_CAPTURE_KEY: randomBytes(32).toString("base64"), CLAUDE_PLUGIN_DATA: path.join(root, "data"), CODEX_HOME: path.join(root, "codex-home"), NODE_OPTIONS: `--import=${pathToFileURL(bootstrap).href}`, PATH: `${bin}${path.delimiter}${env.PATH}` });
const children = [];
function start(command, args, options) {
  const child = spawn(command, args, options);
  const exit = new Promise((resolve) => { child.once("error", (error) => resolve({ error: error.code })); child.once("exit", (code, signal) => resolve({ code, signal })); });
  const handle = { child, exit }; children.push(handle); return handle;
}
function artifacts() {
  const rows = [];
  const walk = (dir) => { if (!fs.existsSync(dir)) return; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name === "state.json" || path.basename(dir) === "jobs" && entry.name.endsWith(".json")) rows.push([path.relative(root, file), hash(file)]); } };
  walk(path.join(root, "data/state")); return rows.sort();
}
function allJobs() {
  const states = path.join(root, "data/state"); if (!fs.existsSync(states)) return [];
  return fs.readdirSync(states).flatMap((name) => readJson(path.join(states, name, "state.json"))?.jobs ?? []);
}
let writer = null, writerFence = null, sessionId = null;
const results = [];
const modes = (process.env.FENCED_LOCK_NATIVE_MODES ?? "startup,resume").split(",");
try {
  if (modes.includes("old-writer")) {
  const old = path.join(root, "old"); fs.mkdirSync(old);
  execFileSync("tar", ["-x", "-C", old], { input: execFileSync("git", ["archive", OLD_PROTOCOLS.o2.ref, "plugins/codex"], { cwd: repo }) });
  assert.equal(hash(path.join(old, "plugins/codex/scripts/lib/state.mjs")), OLD_PROTOCOLS.o2.stateSha256);
  const oldScript = path.join(old, "plugins/codex/scripts/codex-companion.mjs"), ready = path.join(root, "old.ready");
  fs.writeFileSync(oldScript, `import fs from 'node:fs';import path from 'node:path';import {updateState,resolveStateDir} from './lib/state.mjs';updateState(process.argv[2],s=>{fs.writeFileSync(process.argv[3],path.join(resolveStateDir(process.argv[2]),'state.lock'));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600000);return s;});`);
  writer = start(process.execPath, [oldScript, root, ready], { env, stdio: "ignore" });
  const deadline = Date.now() + 10_000; while (!fs.existsSync(ready)) { assert.ok(Date.now() < deadline, "O2 writer did not enter section"); await new Promise((resolve) => setTimeout(resolve, 20)); }
  writerFence = fs.readFileSync(ready, "utf8"); fs.unlinkSync(writerFence);
  }
  for (let index = 0; index < modes.length; index++) {
    const mode = modes[index], phase = `${index + 1}-${mode}`;
    if (writer && mode !== "old-writer" && writer.child.exitCode === null && writer.child.signalCode === null) { writer.child.kill("SIGTERM"); await writer.exit; }
    const expectedAdmission = ["admitted", "startup", "resume", "recover"].includes(mode);
    const resume = mode !== "old-writer" && mode !== "startup" && sessionId;
    json(path.join(root, "native-config.json"), { phase, mode, ...(expectedAdmission ? { captureAdmission: `${phase}.admission.enc.json` } : {}) });
    const command = [process.execPath, probe, root, phase].map(quote).join(" ");
    fs.writeFileSync(path.join(plugin, "commands/native-probe.md"), `---\ndescription: Native companion admission proof\nallowed-tools: Bash(node:*)\n---\nRun exactly this Bash command once, then say OK. Do not run other commands.\n\n\x60\x60\x60bash\n${command}\n\x60\x60\x60\n`);
    const beforeArtifacts = artifacts();
    const completedStopBefore = allJobs().filter((job) => job.title === "Codex Stop Gate Review" && job.status === "completed").length;
    const stdout = fs.openSync(path.join(root, `${phase}.claude.jsonl`), "w"), stderr = fs.openSync(path.join(root, `${phase}.claude.stderr`), "w");
    const args = [...(resume ? ["--resume", sessionId] : []), "-p", "/codex:native-probe", "--plugin-dir", plugin, "--setting-sources", "", "--settings", settings, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "Bash", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--max-turns", "3"];
    const run = start("claude", args, { cwd: root, env, stdio: ["ignore", stdout, stderr] });
    const timer = setTimeout(() => run.child.kill("SIGTERM"), 120_000), killTimer = setTimeout(() => run.child.kill("SIGKILL"), 125_000);
    const claudeExit = await run.exit; clearTimeout(timer); clearTimeout(killTimer); fs.closeSync(stdout); fs.closeSync(stderr);
    const stream = readLines(path.join(root, `${phase}.claude.jsonl`));
    sessionId = stream.find((record) => record.type === "system" && record.subtype === "init")?.session_id ?? sessionId;
    const inputs = fs.readdirSync(root).filter((name) => name.startsWith(`${phase}.SessionStart.`) && name.endsWith(".input.json")).map((name) => readJson(path.join(root, name)));
    const input = inputs.at(-1);
    const transcript = input?.transcriptPath ? readLines(input.transcriptPath) : [];
    const receipts = transcript.filter((record) => record.type === "attachment" && record.sessionId === sessionId && record.cwd === root && record.attachment?.hookEvent === "SessionStart" && record.attachment.command === sessionStartCommand).flatMap((record) => { try { const output = JSON.parse(record.attachment.stdout), receipt = output.codexStateLockAdmission; return receipt?.generation ? [{ generation: receipt.generation, source: receipt.source, exitCode: record.attachment.exitCode, type: record.attachment.type, hookName: record.attachment.hookName, durationMs: record.attachment.durationMs, context: output.hookSpecificOutput?.additionalContext ?? null }] : []; } catch { return []; } });
    const cipherFile = path.join(root, `${phase}.admission.enc.json`);
    const admissionAfterEnd = fs.existsSync(cipherFile) ? JSON.parse(execFileSync(process.execPath, [replay, root, cipherFile], { env, encoding: "utf8", timeout: 10_000 })) : null;
    const events = readLines(path.join(root, "events.jsonl")).filter((event) => event.phase === phase);
    const consumerScans = events.filter((event) => event.kind === "process-inspection" && !event.allowedProducer);
    const entries = events.filter((event) => event.kind === "entry" && ["Stop", "SessionEnd"].includes(event.event));
    const exits = events.filter((event) => event.kind === "exit" && ["Stop", "SessionEnd"].includes(event.event));
    const jobs = allJobs(), endJob = jobs.find((job) => job.id === `native-end-${phase}`);
    const completedStopAfter = jobs.filter((job) => job.title === "Codex Stop Gate Review" && job.status === "completed").length;
    const bash = readJson(path.join(root, `${phase}.bash.json`));
    const blocker = stream.find((record) => record.type === "result" && record.api_error)?.api_error ?? null;
    const fencePath = writerFence ?? (bash?.stateFile ? path.join(path.dirname(bash.stateFile), "state.lock") : null);
    const record = fencePath ? readJson(path.join(fencePath, "fence.json")) : null;
    let fenceIdentity = null; try { const stat = fs.statSync(fencePath, { bigint: true }); fenceIdentity = { dev: String(stat.dev), ino: String(stat.ino) }; } catch {}
    const oldWriterInS0 = Boolean(writer && record?.S0?.some((process) => process.pid === writer.child.pid));
    const sameFenceAsOldWriter = mode === "admitted" ? JSON.stringify(results.find((result) => result.mode === "old-writer")?.fenceIdentity) === JSON.stringify(fenceIdentity) && Boolean(fenceIdentity) : null;
    const stateUnchanged = JSON.stringify(beforeArtifacts) === JSON.stringify(artifacts());
    const latestReceipt = receipts.at(-1) ?? null;
    const generationInModelRequest = latestReceipt ? transcript.some((record) => record.type === "api-request-blob" && JSON.stringify(record).includes(latestReceipt.generation)) : null;
    const currentContextInModelRequest = latestReceipt?.context ? transcript.some((record) => record.type === "api-request-blob" && JSON.stringify(record).includes(latestReceipt.context)) : null;
    const positiveCompanions = completedStopAfter > completedStopBefore && endJob?.status === "cancelled" && exits.some((event) => event.event === "Stop" && event.code === 0) && exits.some((event) => event.event === "SessionEnd" && event.code === 0) && admissionAfterEnd?.acquired === false && admissionAfterEnd?.stateUnchanged === true;
    const crashObserved = !mode.startsWith("crash-") || events.some((event) => event.kind === "injected-crash");
    const passed = !blocker && claudeExit.code === 0 && bash?.passed && consumerScans.length === 0 && entries.some((event) => event.event === "Stop") && entries.some((event) => event.event === "SessionEnd") && entries.every((event) => !event.certificateInherited && !event.companionSessionInherited) && crashObserved && (expectedAdmission ? positiveCompanions && latestReceipt?.exitCode === 0 && latestReceipt.durationMs < sessionStartTimeoutMs && generationInModelRequest === false && currentContextInModelRequest === true && (mode !== "admitted" || sameFenceAsOldWriter) : stateUnchanged && (mode !== "old-writer" || oldWriterInS0 && !record?.sealedAt));
    results.push({ phase, mode, expectedAdmission, passed: Boolean(passed), blocker, claudeExit, sessionId, source: input?.source ?? null, bash, admissionAfterEnd, consumerScans: consumerScans.length, hookEntries: entries, hookExits: exits, latestReceipt, generationInModelRequest, currentContextInModelRequest, completedStopBefore, completedStopAfter, endJobStatus: endJob?.status ?? null, stateUnchanged, oldWriterInS0, sameFenceAsOldWriter, fenceIdentity, crashObserved, transcriptInputRead: events.filter((event) => event.kind === "input" && event.event === "SessionStart") });
    assert.equal(hash(hooksFile), hooksSha256, "actual production hooks config changed in fixture");
    json(path.join(root, "summary.json"), { root, productRef: productRef ?? "working-tree", sourceHashes, harnessHashes, hooksSha256, sessionStartTimeoutMs, fakeCodexFixtureSha256: hash(fakeSourceFile), actualHooksUnchanged: true, passed: results.every((result) => result.passed), results });
    console.log(JSON.stringify(results.at(-1)));
    assert.ok(passed, `${phase} failed; summary: ${path.join(root, "summary.json")}`);
  }
} finally {
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(children.map(({ exit }) => exit));
  console.log(JSON.stringify({ evidenceRoot: root, summaryPath: path.join(root, "summary.json") }));
}
