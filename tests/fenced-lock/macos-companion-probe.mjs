// Actual /codex:native-probe Bash body; default product APIs only.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const [root, phase] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(root, "native-config.json"), "utf8"));
let environmentAdmission = null;
try { environmentAdmission = JSON.parse(process.env.CODEX_COMPANION_LOCK_ADMISSION ?? "null"); } catch {}
// Private fixture metadata only: never put a generation in Bash/model output.
fs.writeFileSync(path.join(root, `${phase}.environment.json`), JSON.stringify({ nativeSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, companionSessionId: process.env.CODEX_COMPANION_SESSION_ID ?? null, certificateVersion: environmentAdmission?.version ?? null, certificateGeneration: environmentAdmission?.generation ?? null, certificateSource: environmentAdmission?.source ?? null, certificateSessionId: environmentAdmission?.sessionId ?? null, certificateStateRoot: environmentAdmission?.root ?? null, certificateConfigRoot: environmentAdmission?.configRoot ?? null }), { mode: 0o600 });
const lib = path.join(root, "plugin", "scripts", "lib");
const state = await import(pathToFileURL(path.join(lib, "state.mjs")));
const originalData = process.env.CLAUDE_PLUGIN_DATA;
const expectedAdmission = ["admitted", "startup", "resume", "recover"].includes(config.mode);
let witness = null;
try { fs.writeFileSync(path.join(root, "outside-denied", `${phase}.witness`), "must fail"); witness = "unexpected-write"; }
catch (error) { witness = error.code; }
let acquired = false, configured = false, seeded = false, error = null, replay = null;
const stateFile = state.resolveStateFile(root);
const before = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
try {
  const lock = state.openStateLock(root), handle = lock.tryAcquire();
  acquired = Boolean(handle);
  if (handle) lock.release(handle);
  if (acquired && config.captureAdmission) {
    const destination = path.join(root, config.captureAdmission);
    if (path.dirname(destination) !== root) throw new Error("admission capture must stay in the owned fixture");
    fs.writeFileSync(destination, JSON.stringify(Object.fromEntries(["CODEX_COMPANION_LOCK_ADMISSION", "CODEX_COMPANION_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_DATA"].map((key) => [key, process.env[key]]))), { mode: 0o600 });
  }
  if (config.replayAdmission) {
    const replayFile = path.join(root, config.replayAdmission);
    if (path.dirname(replayFile) !== root) throw new Error("admission replay must stay in the owned fixture");
    const prior = JSON.parse(fs.readFileSync(replayFile, "utf8"));
    const replayScript = fileURLToPath(new URL("./macos-companion-replay.mjs", import.meta.url));
    replay = JSON.parse(execFileSync(process.execPath, [replayScript, root], { env: { ...process.env, ...prior }, encoding: "utf8", timeout: 10_000 }));
  }
  if (acquired && expectedAdmission) {
    execFileSync(process.execPath, [path.join(root, "plugin", "scripts", "codex-companion.mjs"), "setup", "--enable-review-gate", "--json"], { cwd: root, env: process.env, encoding: "utf8", timeout: 30_000 });
    configured = state.loadState(root).config.stopReviewGate === true;
    state.updateJobRecord(root, `native-end-${phase}`, () => ({ id: `native-end-${phase}`, title: "Owned native SessionEnd fixture", status: "queued", phase: "queued", sessionId: process.env.CODEX_COMPANION_SESSION_ID, pid: null, jobClass: "task", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    seeded = state.loadState(root).jobs.some((job) => job.id === `native-end-${phase}` && job.status === "queued");
  }
} catch (caught) { error = { code: caught.code ?? null, message: caught.message }; }
const after = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
const out = { phase, mode: config.mode, expectedAdmission, acquired, configured, seeded, replay, witness, error, stateFile, stateUnchanged: before === after, stateRootCreated: fs.existsSync(state.resolveStateDir(root)), sessionPresent: Boolean(process.env.CODEX_COMPANION_SESSION_ID), certificatePresent: Boolean(process.env.CODEX_COMPANION_LOCK_ADMISSION), dataStayedFixtureOwned: originalData?.startsWith(root + path.sep), passed: !error && ["EPERM", "EACCES"].includes(witness) && (expectedAdmission ? acquired && configured && seeded : !acquired && before === after) && (!config.replayAdmission || replay?.acquired === config.replayExpected) };
fs.writeFileSync(path.join(root, `${phase}.bash.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
process.exitCode = out.passed ? 0 : 1;
