// Actual /codex:native-probe Bash body; default product APIs only.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, createCipheriv, randomBytes } from "node:crypto";

const [root, phase] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(root, "native-config.json"), "utf8"));
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
let environmentAdmission = null;
try { environmentAdmission = JSON.parse(process.env.CODEX_COMPANION_LOCK_ADMISSION ?? "null"); } catch {}
// Private fixture metadata only: never put a generation in Bash/model output.
fs.writeFileSync(path.join(root, `${phase}.environment.json`), JSON.stringify({ names: ["CLAUDE_CODE_SESSION_ID", "CODEX_COMPANION_SESSION_ID", "CODEX_COMPANION_LOCK_ADMISSION", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_DATA"], nativeSessionSha256: sha(process.env.CLAUDE_CODE_SESSION_ID ?? ""), companionSessionSha256: sha(process.env.CODEX_COMPANION_SESSION_ID ?? ""), certificateVersion: environmentAdmission?.version ?? null, generation: environmentAdmission?.generation ?? null, source: environmentAdmission?.source ?? null, certificateSessionSha256: sha(environmentAdmission?.sessionId ?? ""), certificateStateRootSha256: sha(environmentAdmission?.root ?? ""), certificateConfigRootSha256: sha(environmentAdmission?.configRoot ?? ""), bindingEpochSha256: sha(environmentAdmission?.bindingEpoch ?? ""), fullEnvelopeSha256: sha(process.env.CODEX_COMPANION_LOCK_ADMISSION ?? ""), baseCertificateSha256: sha(JSON.stringify(environmentAdmission?.admission ?? null)) }), { mode: 0o600 });
// The replay artifact is encrypted even when the default consumer refuses.
if (config.captureAdmission) {
  const destination = path.join(root, config.captureAdmission);
  if (path.dirname(destination) !== root) throw new Error("owned admission capture required");
  const key = Buffer.from(process.env.FENCED_LOCK_NATIVE_CAPTURE_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("fixture capture key unavailable");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const values = Object.fromEntries(["CODEX_COMPANION_LOCK_ADMISSION", "CODEX_COMPANION_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_DATA"].map((name) => [name, process.env[name]]));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
  fs.writeFileSync(destination, JSON.stringify({ version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }), { mode: 0o600 });
}
const lib = path.join(root, "plugin", "scripts", "lib");
const state = await import(pathToFileURL(path.join(lib, "state.mjs")));
const originalData = process.env.CLAUDE_PLUGIN_DATA;
const expectedAdmission = ["admitted", "startup", "resume", "recover"].includes(config.mode);
let witness = null;
try { fs.writeFileSync(path.join(root, "outside-denied", `${phase}.witness`), "must fail"); witness = "unexpected-write"; }
catch (error) { witness = error.code; }
let acquired = false, configured = false, seeded = false, error = null, replay = null, currentControl = null;
const stateFile = state.resolveStateFile(root);
const authorityPath = path.join(path.dirname(stateFile), "state.lock.db");
const authorityIdentity = () => { try { const st = fs.statSync(authorityPath, { bigint: true }); return sha(`${st.dev}:${st.ino}:${st.birthtimeNs}`); } catch { return null; } };
const authorityBeforeSha256 = authorityIdentity();
const before = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
try {
  const lock = state.openStateLock(root), handle = lock.acquire({ deadlineMs: 0 });
  acquired = Boolean(handle);
  if (handle) lock.release(handle);
  if (acquired && expectedAdmission) {
    execFileSync(process.execPath, [path.join(root, "plugin", "scripts", "codex-companion.mjs"), "setup", "--enable-review-gate", "--json"], { cwd: root, env: process.env, encoding: "utf8", timeout: 30_000 });
    configured = state.loadState(root).config.stopReviewGate === true;
    state.updateJobRecord(root, `native-end-${phase}`, () => ({ id: `native-end-${phase}`, title: "Owned native SessionEnd fixture", status: "queued", phase: "queued", sessionId: process.env.CODEX_COMPANION_SESSION_ID, pid: null, jobClass: "task", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    seeded = state.loadState(root).jobs.some((job) => job.id === `native-end-${phase}` && job.status === "queued");
  }
} catch (caught) {
  const fixed = new Set(["admission certificate missing or malformed", "session generation pending, revoked or foreign", "session parent receipt missing or unproven", "provider receipt token mismatch", "latest provider receipt not proven", "session binding unknown or changed"]);
  const reason = String(caught.reason ?? "");
  const literal = [...fixed].find((value) => reason.includes(value));
  error = { name: caught.name, code: caught.code ?? null, rule: literal ?? "other-refusal", reasonSha256: sha(reason), messageSha256: sha(caught.message) };
}
if (config.replayAdmission) {
  const replayFile = path.join(root, config.replayAdmission);
  if (path.dirname(replayFile) !== root) throw new Error("owned replay required");
  const replayScript = fileURLToPath(new URL("./macos-companion-replay.mjs", import.meta.url));
  replay = JSON.parse(execFileSync(process.execPath, [replayScript, root, replayFile, `${phase}.previous`], { env: process.env, encoding: "utf8", timeout: 10_000 }));
}
if (config.currentAdmission) currentControl = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./macos-companion-replay.mjs", import.meta.url)), root, path.join(root, config.currentAdmission), `${phase}.current`], { env: process.env, encoding: "utf8", timeout: 10_000 }));
const after = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
const observerComplete = process.env.FENCED_LOCK_NATIVE_OBSERVER_FAILED !== "1";
const out = { phase, pid: process.pid, mode: config.mode, expectedAdmission, acquired, configured, seeded, replay, currentControl, witness, error, stateFile, stateUnchanged: before === after, authorityBeforeSha256, authorityAfterSha256: authorityIdentity(), observerComplete, inconclusive: !observerComplete, stateRootCreated: fs.existsSync(state.resolveStateDir(root)), sessionPresent: Boolean(process.env.CODEX_COMPANION_SESSION_ID), certificatePresent: Boolean(process.env.CODEX_COMPANION_LOCK_ADMISSION), dataStayedFixtureOwned: originalData?.startsWith(root + path.sep), passed: observerComplete && ["EPERM", "EACCES"].includes(witness) && (expectedAdmission ? !error && acquired && configured && seeded : !acquired && before === after) && (!config.replayAdmission || replay?.acquired === config.replayExpected) };
fs.writeFileSync(path.join(root, `${phase}.bash.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
process.exitCode = out.passed ? 0 : 1;
