// Local synthetic controls only. Run through test-slot; never invokes Claude.
// --baseline checks the missing denied-capture/row metadata in 5a0ea2e.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, createDecipheriv, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1916-observation-controls-"));
const harness = path.join(root, "harness"); fs.mkdirSync(harness);
const hash = value => createHash("sha256").update(String(value)).digest("hex");
const check = (ok, rule) => { if (!ok) throw new Error(rule); };
const keyName = "FENCED_LOCK_NATIVE_CAPTURE_KEY";
const certName = "CODEX_COMPANION_LOCK_ADMISSION";
const allowedKeys = [certName, "CODEX_COMPANION_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_DATA"].sort();
const harnessHashes = {};
for (const name of ["macos-companion-probe.mjs", "macos-companion-bootstrap.mjs", "macos-companion-replay.mjs"]) {
  const source = path.join(repo, "tests/fenced-lock", name);
  let bytes = fs.readFileSync(source);
  if (baseline) {
    const old = spawnSync("git", ["show", `5a0ea2e:tests/fenced-lock/${name}`], { cwd: repo });
    check(old.status === 0, "baseline available"); bytes = old.stdout;
  }
  fs.writeFileSync(path.join(harness, name), bytes); harnessHashes[name] = hash(bytes);
}
const shim = path.join(root, "synthetic-sandbox.mjs");
fs.writeFileSync(shim, `import fs from 'node:fs';import path from 'node:path';import{syncBuiltinESMExports}from'node:module';
const root=process.env.FENCED_LOCK_NATIVE_ROOT;const write=fs.writeFileSync;
fs.writeFileSync=function(file,...args){if(String(file).startsWith(path.join(root,'outside-denied')+path.sep))throw Object.assign(new Error('owned synthetic sandbox'),{code:'EPERM'});return write.call(this,file,...args)};
if(process.env.OBSERVER_CONTROL_LOG_FAILURE==='1'){const append=fs.appendFileSync;fs.appendFileSync=function(file,value,...args){if(String(file)===path.join(root,'events.jsonl')&&String(value).includes('"kind":"session-row-read"'))throw Object.assign(new Error('owned observer write failure'),{code:'EIO'});return append.call(this,file,value,...args)}}
syncBuiltinESMExports();`);
const legacy = path.join(root, "legacy-control.mjs");
fs.writeFileSync(legacy, `import{pathToFileURL}from'node:url';import path from'node:path';const root=process.argv[2];const state=await import(pathToFileURL(path.join(root,'plugin/scripts/lib/state.mjs')));const l=state.openStateLock(root);let h=null;try{h=l.tryAcquire();console.log(JSON.stringify({acquired:!!h}))}finally{if(h)l.release(h)}`);

const results = [];
function control(name, body) {
  try { body(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, rule: error.message }); }
}
function run(script, args, env, label, preload = true) {
  const r = spawnSync(process.execPath, ["--no-warnings", ...(preload ? ["--import", shim, "--import", path.join(harness, "macos-companion-bootstrap.mjs")] : []), script, ...args], { cwd: env.FENCED_LOCK_NATIVE_ROOT, env, encoding: "utf8", timeout: 15_000 });
  // These outputs contain hashes/fixed rules only; ENV and keys are never logged.
  fs.writeFileSync(path.join(root, `${label}.stdout`), r.stdout ?? "");
  fs.writeFileSync(path.join(root, `${label}.stderr`), r.stderr ?? "");
  let out = null; try { out = JSON.parse(r.stdout); } catch {}
  return { status: r.status, out };
}
async function fixture(name) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  fs.cpSync(path.join(repo, "plugins/codex"), path.join(dir, "plugin"), { recursive: true, filter: file => !path.basename(file).startsWith(".env") && path.basename(file) !== "node_modules" });
  const env = { ...process.env, NODE_OPTIONS: "", CLAUDE_CONFIG_DIR: path.join(dir, "claude"), CLAUDE_PLUGIN_DATA: path.join(dir, "data"), CLAUDE_CODE_SESSION_ID: "synthetic-owned-session", CODEX_COMPANION_SESSION_ID: "synthetic-owned-session", FENCED_LOCK_NATIVE_ROOT: dir, [keyName]: randomBytes(32).toString("base64") };
  delete env[certName]; delete env.FENCED_LOCK_NATIVE_OBSERVER_FAILED;
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA });
  const base = pathToFileURL(path.join(dir, "plugin/scripts/lib/")).href;
  const state = await import(`${base}state.mjs`), helper = await import(`${base}session-admission.mjs`), core = await import(`${base}fenced-lock.mjs`);
  const transcript = path.join(dir, "transcript.jsonl"); fs.writeFileSync(transcript, "");
  const F = state.resolveLockPath(dir);
  const locator = helper.createSessionLocator(env.CLAUDE_CODE_SESSION_ID, F, transcript, dir);
  const lock = core.openFencedLock(F, { deadlineMs: 0, ...helper.sessionChecks(locator), domain: () => ({ verdict: "initial", scope: "owned-synthetic", reason: "fixture" }), scanner: () => ({ self: { pid: process.pid, start: "owned-synthetic", matched: true }, processes: [] }) });
  const begun = lock.beginSessionAdmission({ sessionId: locator.sessionId, bindingEpoch: locator.bindingEpoch }); check(begun.ok, "synthetic begin succeeds");
  const prepared = lock.prepareAdmission(); check(prepared.ok, "synthetic proof succeeds");
  const envelope = helper.envelopeFor(locator, begun.generation, "startup", prepared.admission);
  check(lock.finishSessionAdmission({ sessionId: locator.sessionId, bindingEpoch: locator.bindingEpoch, generation: begun.generation, admission: prepared.admission }).ok, "synthetic finish succeeds");
  fs.appendFileSync(transcript, JSON.stringify({ type: "attachment", version: "2.1.301", sessionId: locator.sessionId, cwd: dir, isSidechain: false, attachment: { type: "hook_success", hookEvent: "SessionStart", hookName: "SessionStart:startup", exitCode: 0, command: helper.SESSION_START_COMMAND, stdout: JSON.stringify({ continue: true, suppressOutput: true, codexStateLockAdmission: { generation: begun.generation, sessionId: locator.sessionId, root: locator.root, source: "startup" } }) } }) + "\n");
  return { dir, env, envelope, currentGeneration: begun.generation };
}
function probe(f, name, extra = {}) {
  fs.writeFileSync(path.join(f.dir, "native-config.json"), JSON.stringify({ phase: name, mode: "control", captureAdmission: `${name}.admission.enc.json` }));
  const env = { ...f.env, [certName]: JSON.stringify(f.envelope), ...extra };
  const before = fs.existsSync(path.join(f.dir, "events.jsonl")) ? fs.readFileSync(path.join(f.dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).length : 0;
  const r = run(path.join(harness, "macos-companion-probe.mjs"), [f.dir, name], env, name);
  const events = fs.existsSync(path.join(f.dir, "events.jsonl")) ? fs.readFileSync(path.join(f.dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).slice(before).map(JSON.parse) : [];
  return { ...r, env, events, metadata: JSON.parse(fs.readFileSync(path.join(f.dir, `${name}.environment.json`), "utf8")), capture: path.join(f.dir, `${name}.admission.enc.json`) };
}
function decrypt(file, key) {
  const e = JSON.parse(fs.readFileSync(file, "utf8"));
  check(e.version === 1 && e.algorithm === "aes-256-gcm", "encrypted capture format");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), Buffer.from(e.iv, "base64"));
  d.setAuthTag(Buffer.from(e.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(e.ciphertext, "base64")), d.final()]).toString("utf8"));
}

const samples = [];
for (const name of (baseline ? ["stale-generation"] : ["valid", "stale-generation", "wrong-source"])) {
  const f = await fixture(name);
  if (name === "stale-generation") f.envelope.generation = "0".repeat(64);
  if (name === "wrong-source") f.envelope.source = "resume";
  const old = run(legacy, [f.dir], { ...f.env, [certName]: JSON.stringify(f.envelope) }, `${name}.legacy`, false);
  const observed = probe(f, name);
  samples.push({ f, name, observed });
  control(`${name}: one-attempt allow/deny is unchanged`, () => { check(old.out?.acquired === (name === "valid"), "legacy expected decision"); check(observed.out?.acquired === old.out?.acquired, "new observer preserves decision"); });
  control(`${name}: actual SQL row and ENV certificate hashes`, () => {
    check(observed.metadata.fullEnvelopeSha256 === hash(observed.env[certName]), "ENV full envelope SHA");
    check(observed.metadata.baseCertificateSha256 === hash(JSON.stringify(f.envelope.admission)), "ENV base cert SHA");
    check(observed.metadata.generation === f.envelope.generation, "ENV generation observed");
    const rows = observed.events.filter(x => x.kind === "session-row-read");
    check(rows.length > 0 && rows.every(x => x.generation === f.currentGeneration && x.state === "ready"), "actual transaction SQL row generation");
    if (name !== "valid") check(observed.out?.error?.rule === (name === "stale-generation" ? "session generation pending, revoked or foreign" : "provider receipt token mismatch"), "exact failed predicate observed");
  });
  control(`${name}: encrypted capture exists also on refusal`, () => {
    check(fs.existsSync(observed.capture), "capture exists before decision");
    const captured = decrypt(observed.capture, f.env[keyName]);
    check(Object.keys(captured).sort().join(",") === allowedKeys.join(","), "decrypted key whitelist");
    for (const key of allowedKeys) check(hash(captured[key]) === hash(observed.env[key]), "decrypted value SHA matches");
    check((fs.statSync(observed.capture).mode & 0o777) === 0o600, "private capture permissions");
  });
  if (!baseline) {
    control(`${name}: replay preserves captured decision`, () => {
      const r = run(path.join(harness, "macos-companion-replay.mjs"), [f.dir, observed.capture, `${name}.replay`], observed.env, `${name}.replay`);
      check(r.out?.captureValid === true && r.out?.acquired === observed.out?.acquired, "replay agrees without new grant");
    });
    control(`${name}: public observations contain no raw key or certificate`, () => {
      const publicText = JSON.stringify({ metadata: observed.metadata, events: observed.events, output: observed.out });
      check(!publicText.includes(f.env[keyName]) && !publicText.includes(observed.env[certName]) && !publicText.includes(JSON.stringify(f.envelope.admission)), "public observations whitelist only");
    });
  }
}
if (!baseline) {
  const { f, observed } = samples[0];
  control("GCM tamper is inconclusive, never a green denial", () => {
    const cipher = JSON.parse(fs.readFileSync(observed.capture, "utf8")); const bytes = Buffer.from(cipher.ciphertext, "base64"); bytes[0] ^= 1; cipher.ciphertext = bytes.toString("base64");
    const file = path.join(f.dir, "tampered.enc.json"); fs.writeFileSync(file, JSON.stringify(cipher), { mode: 0o600 });
    const r = run(path.join(harness, "macos-companion-replay.mjs"), [f.dir, file], observed.env, "tampered");
    check(r.out?.captureValid === false && r.out?.inconclusive === true && r.out?.acquired === null, "tamper marked inconclusive");
  });
  control("missing GCM key is inconclusive, never a green denial", () => {
    const env = { ...observed.env }; delete env[keyName];
    const r = run(path.join(harness, "macos-companion-replay.mjs"), [f.dir, observed.capture], env, "missing-key");
    check(r.out?.captureValid === false && r.out?.inconclusive === true && r.out?.acquired === null, "missing key marked inconclusive");
  });
  for (const sample of samples.slice(0, 2)) control(`${sample.name}: failed SQL observation preserves result and marks inconclusive`, () => {
    const r = probe(sample.f, `${sample.name}.observer-error`, { OBSERVER_CONTROL_LOG_FAILURE: "1" });
    check(r.out?.acquired === sample.observed.out?.acquired, "SQL observer error did not alter row return");
    check(r.out?.observerComplete === false && r.out?.inconclusive === true && r.out?.passed === false, "observer error cannot become green denial");
  });
}
const summary = { root, baseline, harnessHashes, controls: results.length, passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length, results };
fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failed ? 1 : 0;
