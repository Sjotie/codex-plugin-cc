// Wire v2 only (pre-D): see wire-v2-only.mjs; wire v3 uses macos-d-pty-probe.py.
// Opt-in actual interactive /compact and /clear on the harness's owned session.
// Captures native source/SID/End reason and ordinary old-admission expiry.
import assert from "node:assert/strict";
import fs from "node:fs";
import { requireWireV2 } from "./wire-v2-only.mjs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.equal(process.platform, "darwin");
assert.equal(process.stdin.isTTY, true, "run with exec_command tty:true; the controller sends the printed inputRequired commands through that PTY");
const root = process.argv[2];
requireWireV2(fs.readFileSync(path.join(root, "plugin/scripts/lib/session-admission.mjs"), "utf8"), "macos-companion-actions.mjs");
const runId = Date.now().toString(36);
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const lines = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } };
const original = read(path.join(root, "summary.json"));
assert.equal(original?.root, root, "owned native companion fixture required");
assert.equal(original.actualHooksUnchanged, true);
let sessionId = original.results.at(-1).sessionId;
assert.ok(sessionId);
const bootstrap = fileURLToPath(new URL("./macos-companion-bootstrap.mjs", import.meta.url));
const probe = fileURLToPath(new URL("./macos-companion-probe.mjs", import.meta.url));
const harnessHashes = Object.fromEntries([fileURLToPath(import.meta.url), bootstrap, probe, fileURLToPath(new URL("./macos-companion-replay.mjs", import.meta.url))].map((file) => [path.basename(file), createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const env = { ...process.env };
const captureKey = randomBytes(32).toString("base64");
for (const key of Object.keys(env)) if (key.startsWith("CODEX_COMPANION_") || key.startsWith("FENCED_LOCK_SCAN_") || ["CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "NODE_OPTIONS"].includes(key)) delete env[key];
Object.assign(env, { TERM: "xterm-256color", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", FENCED_LOCK_NATIVE_ROOT: root, FENCED_LOCK_NATIVE_CAPTURE_KEY: captureKey, CLAUDE_PLUGIN_DATA: path.join(root, "data"), CODEX_HOME: path.join(root, "codex-home"), NODE_OPTIONS: `--import=${pathToFileURL(bootstrap).href}`, PATH: `${path.join(root, "bin")}${path.delimiter}${env.PATH}` });
const results = [], resultFile = path.join(root, "actions-summary.json");
const eventsFor = (phase) => lines(path.join(root, "events.jsonl")).filter((event) => event.phase === phase);
const inputsFor = (phase, event) => eventsFor(phase).filter((e) => e.kind === "input" && e.event === event).map((e) => ({ event, ...read(path.join(root, `${phase}.${event}.${e.pid}.input.json`)) }));
function receiptFor(input) {
  if (!input) return null;
  const rows = lines(input.transcriptPath), rawCommand = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs" SessionStart';
  const record = rows.filter((r) => r.type === "attachment" && r.sessionId === input.sessionId && r.attachment?.command === rawCommand).at(-1);
  let output; try { output = JSON.parse(record.attachment.stdout); } catch { return null; }
  const token = output.codexStateLockAdmission, context = output.hookSpecificOutput?.additionalContext;
  const generationInModelRequest = rows.some((r) => r.type === "api-request-blob" && JSON.stringify(r).includes(token.generation));
  const currentContextInModelRequest = typeof context === "string" && rows.some((r) => r.type === "api-request-blob" && JSON.stringify(r).includes(context));
  const proof = { source: token.source, sessionId: token.sessionId, generation: token.generation, durationMs: record.attachment.durationMs, exitCode: record.attachment.exitCode, hookName: record.attachment.hookName, version: record.version, isSidechain: record.isSidechain, generationInModelRequest, currentContextInModelRequest };
  proof.passed = record.version === "2.1.301" && record.isSidechain === false && record.cwd === root && record.attachment.type === "hook_success" && proof.exitCode === 0 && proof.durationMs < original.sessionStartTimeoutMs && proof.source === input.source && proof.sessionId === input.sessionId && !generationInModelRequest && currentContextInModelRequest;
  return proof;
}
const persist = (extra = {}) => fs.writeFileSync(resultFile, JSON.stringify({ root, interactivePTY: true, productHashes: original.sourceHashes, harnessHashes, results, ...extra }, null, 2));
let phase = `action-${runId}-initial`, capture = `${phase}.session-start.admission.enc.json`;
fs.writeFileSync(path.join(root, "native-config.json"), JSON.stringify({ phase, mode: "resume", captureAdmission: `${phase}.default.admission.enc.json`, replayAdmission: capture, replayExpected: true, currentAdmission: capture }));
const interactiveProbe = path.join(root, "macos-companion-probe.mjs");
fs.writeFileSync(interactiveProbe, `import fs from 'node:fs';import {pathToFileURL} from 'node:url';const root=${JSON.stringify(root)},config=JSON.parse(fs.readFileSync(root+'/native-config.json','utf8'));process.argv=[process.argv[0],${JSON.stringify(probe)},root,config.phase];await import(pathToFileURL(${JSON.stringify(probe)}));`);
fs.writeFileSync(path.join(root, "plugin/commands/native-probe.md"), `---\ndescription: Owned interactive lifecycle proof\nallowed-tools: Bash(node:*)\n---\nRun exactly this Bash command once, then say only OK:\n${[process.execPath, interactiveProbe].map(quote).join(" ")}\n`);
const interactiveRoot = fs.mkdtempSync(path.join(root, "interactive-"));
const launcher = path.join(interactiveRoot, "launch.sh"), pidFile = path.join(interactiveRoot, "claude.pid"), ptyLog = path.join(interactiveRoot, "pty.log");
const args = ["--resume", sessionId, "--plugin-dir", path.join(root, "plugin"), "--setting-sources", "", "--settings", path.join(root, "settings.json"), "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "Bash"];
fs.writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$$" > ${quote(pidFile)}\nexec ${["/Users/sjoerdtiemensma/.local/bin/claude", ...args].map(quote).join(" ")}\n`, { mode: 0o700 });
const out = fs.openSync(path.join(interactiveRoot, "stdout"), "w"), err = fs.openSync(path.join(interactiveRoot, "stderr"), "w");
const child = spawn("/usr/bin/script", ["-q", ptyLog, "/bin/sh", launcher], { cwd: root, env, stdio: [process.stdin, out, err] });
const send = (input, reason) => console.log(JSON.stringify({ inputRequired: input, reason, phase, interactiveRoot }));
let finished = false;
const exit = new Promise((resolve) => { child.once("error", (error) => { finished = true; resolve({ error: error.code }); }); child.once("exit", (code, signal) => { finished = true; resolve({ code, signal }); }); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanup = { launcherPid: child.pid, claudePid: null, signals: [], retainedOwnPid: null };
function stopOwnedClaude(signal) {
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  cleanup.claudePid = pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("owned launcher pid missing");
  let parent;
  try { parent = Number(execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim()); }
  catch (error) { if (error.status === 1) return; cleanup.retainedOwnPid = pid; return; }
  if (parent !== child.pid) { cleanup.retainedOwnPid = pid; return; }
  try { process.kill(pid, signal); cleanup.signals.push({ pid, signal }); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
let trusted = false;
function jobs() {
  const states = path.join(root, "data/state");
  if (!fs.existsSync(states)) return [];
  return fs.readdirSync(states).flatMap((name) => read(path.join(states, name, "state.json"))?.jobs ?? []);
}
function diagnosticsFor(currentPhase, bash) {
  const events = eventsFor(currentPhase), environment = read(path.join(root, `${currentPhase}.environment.json`));
  const store = events.find((e) => e.kind === "session-row-read" && e.pid === bash.pid) ?? null;
  return { environment, store, currentControl: read(path.join(root, `${currentPhase}.current.diagnosis.json`)), previousControl: read(path.join(root, `${currentPhase}.previous.diagnosis.json`)), sessionStartExports: events.filter((e) => e.kind === "environment-v2-published"), envFileObservations: events.filter((e) => e.kind === "envfile-observed"), generationMatches: store ? environment?.generation === store.generation : null, baseCertificateMatches: store ? environment?.baseCertificateSha256 === store.baseCertificateSha256 : null, bindingEpochMatches: store ? environment?.bindingEpochSha256 === store.bindingEpochSha256 : null, authorityIdentityUnchanged: bash.authorityBeforeSha256 === bash.authorityAfterSha256 };
}
function keyAbsent() {
  const keyBytes = Buffer.from(captureKey, "base64"), needles = [Buffer.from(captureKey), keyBytes, Buffer.from(keyBytes.toString("hex"))];
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.isFile()) files.push(f); } };
  walk(root);
  for (const row of results) for (const i of row.starts ?? []) if (i.transcriptPath) files.push(i.transcriptPath);
  return [...new Set(files)].every((file) => { const bytes = fs.readFileSync(file); return needles.every((needle) => !bytes.includes(needle)); });
}
async function waitFor(predicate, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate(); if (value) return value;
    let terminal = ""; try { terminal = fs.readFileSync(ptyLog, "utf8"); } catch {}
    if (!trusted && terminal.includes(root) && /trust (?:the files|this folder)|Yes, I trust/i.test(terminal)) { send("\r", "trust the owned fixture folder"); trusted = true; }
    if (/out of extra usage|out of (?:extra )?usage|hit your limit|usage limit reached|rate limit|please log in|login required|reauthenticate/i.test(terminal)) throw new Error(`${label}: provider permission/login/quota boundary`);
    if (finished) throw new Error(`${label}: owned interactive CLI exited`);
    await sleep(100);
  }
  throw new Error(`${label}: timed out`);
}
async function runBash(currentPhase) {
  const completedStopBefore = jobs().filter((job) => job.title === "Codex Stop Gate Review" && job.status === "completed").length;
  await sleep(300); send("/codex:native-probe\r", "run the ordinary owned fixture Bash command");
  const bash = await waitFor(() => read(path.join(root, `${currentPhase}.bash.json`)), `${currentPhase} Bash`);
  await waitFor(() => eventsFor(currentPhase).some((e) => e.kind === "exit" && e.event === "Stop"), `${currentPhase} Stop`);
  const completedStopAfter = jobs().filter((job) => job.title === "Codex Stop Gate Review" && job.status === "completed").length;
  return { ...bash, completedStopBefore, completedStopAfter, stopBodyWrote: completedStopAfter > completedStopBefore };
}
try {
  cleanup.claudePid = await waitFor(() => { try { const pid = Number(fs.readFileSync(pidFile, "utf8").trim()); return Number.isSafeInteger(pid) && pid > 1 ? pid : null; } catch { return null; } }, "owned launcher pid");
  await waitFor(() => eventsFor(phase).some((e) => e.kind === "exit" && e.event === "SessionStart" && e.code === 0), "initial SessionStart");
  const bash = await runBash(phase);
  const initialStarts = inputsFor(phase, "SessionStart"), initialReceipt = receiptFor(initialStarts.at(-1));
  results.push({ action: "initial", phase, bash, diagnostics: diagnosticsFor(phase, bash), receipt: initialReceipt, starts: initialStarts, ends: inputsFor(phase, "SessionEnd"), passed: bash.passed && bash.stopBodyWrote && bash.replay?.acquired === true && initialReceipt?.passed }); persist();
  for (const action of (process.env.FENCED_LOCK_NATIVE_ACTIONS ?? "compact,clear").split(",")) {
    assert.ok(["compact", "clear"].includes(action));
    const priorSessionId = sessionId, priorCapture = capture, priorEndJobId = `native-end-${phase}`;
    const priorCaptureAvailable = fs.existsSync(path.join(root, priorCapture));
    phase = `action-${runId}-${action}`; capture = `${phase}.session-start.admission.enc.json`;
    fs.writeFileSync(path.join(root, "native-config.json"), JSON.stringify({ phase, mode: "resume", captureAdmission: `${phase}.default.admission.enc.json`, currentAdmission: capture, ...(priorCaptureAvailable ? { replayAdmission: priorCapture, replayExpected: false } : { replayUnavailableReason: "prior SessionStart capture unavailable" }) }));
    send(`/${action}\r`, "run the real interactive slash command");
    await waitFor(() => inputsFor(phase, "SessionStart").find((i) => i.source === action), `${action} actual SessionStart`, 120_000);
    await waitFor(() => eventsFor(phase).some((e) => e.kind === "exit" && e.event === "SessionStart" && e.code === 0), `${action} SessionStart completion`);
    const starts = inputsFor(phase, "SessionStart"), actual = starts.find((i) => i.source === action);
    sessionId = actual.sessionId;
    const bash = await runBash(phase), ends = inputsFor(phase, "SessionEnd"), scans = eventsFor(phase).filter((e) => e.kind === "process-inspection" && !e.allowedProducer);
    const receipt = receiptFor(actual);
    const diagnostics = diagnosticsFor(phase, bash), prior = results.at(-1);
    const clearCapabilityReplayPassed = action === "clear" && priorCaptureAvailable && prior?.bash.currentControl?.captureValid === true && prior.bash.currentControl.acquired === true && bash.replay?.captureValid === true && bash.replay.acquired === false && bash.replay.stateUnchanged === true && diagnostics.previousControl?.generation === prior.diagnostics.currentControl?.generation && diagnostics.previousControl?.fullEnvelopeSha256 === prior.diagnostics.currentControl?.fullEnvelopeSha256;
    const priorEndJobStatus = jobs().find((job) => job.id === priorEndJobId)?.status ?? null;
    const row = { action, phase, priorSessionId, sessionId, sessionIdChanged: sessionId !== priorSessionId, starts, ends, bash, diagnostics, receipt, priorCaptureAvailable, clearCapabilityReplayPassed, jobCleanupObservations: action === "clear" ? jobs().filter((job) => job.id.startsWith("native-end-action-")).map((job) => ({ name: job.id, state: job.status })) : [], priorEndJobId, priorEndJobStatus, consumerInspectionCalls: scans.length, passed: bash.passed && bash.stopBodyWrote && priorCaptureAvailable && bash.replay?.acquired === false && bash.replay?.stateUnchanged === true && receipt?.passed && scans.length === 0 && (action !== "clear" || ends.some((i) => i.reason === "clear" && i.sessionId === priorSessionId) && priorEndJobStatus === "cancelled") };
    results.push(row); persist(); console.log(JSON.stringify(row));
  }
  send("/exit\r", "close only the owned fixture session"); await waitFor(() => finished, "interactive exit", 60_000);
  const exitEndJobStatus = jobs().find((job) => job.id === `native-end-${phase}`)?.status ?? null;
  const finalEvents = eventsFor(phase), fixedEntries = finalEvents.filter((e) => e.kind === "entry" && ["Stop", "SessionEnd"].includes(e.event));
  const finalConsumersNoInheritedAdmission = fixedEntries.every((e) => !e.certificateInherited && !e.companionSessionInherited);
  persist({ passed: results.every((r) => r.passed) && exitEndJobStatus === "cancelled" && finalConsumersNoInheritedAdmission, exit: await exit, exitEndJobStatus, finalConsumersNoInheritedAdmission, keyAbsent: keyAbsent() });
} catch (error) {
  persist({ passed: false, failure: error.message }); console.error(JSON.stringify({ failure: error.message, summaryPath: resultFile })); process.exitCode = 1;
} finally {
  if (!finished) { send("\x03\x03", "stop only the owned fixture session"); await Promise.race([exit, sleep(2000)]); }
  if (!finished) {
    stopOwnedClaude("SIGTERM");
    await Promise.race([exit, sleep(3000)]);
    if (!finished) stopOwnedClaude("SIGKILL");
  }
  if (!finished) child.kill("SIGTERM");
  await exit; fs.closeSync(out); fs.closeSync(err);
  if (cleanup.claudePid) {
    try { process.kill(cleanup.claudePid, 0); cleanup.retainedOwnPid = cleanup.claudePid; cleanup.claudeGone = false; }
    catch (error) { cleanup.claudeGone = error.code === "ESRCH"; if (!cleanup.claudeGone) cleanup.retainedOwnPid = cleanup.claudePid; }
  }
  fs.writeFileSync(resultFile, JSON.stringify({ ...read(resultFile), cleanup, keyAbsent: keyAbsent() }, null, 2));
  console.log(JSON.stringify({ summaryPath: resultFile }));
}
