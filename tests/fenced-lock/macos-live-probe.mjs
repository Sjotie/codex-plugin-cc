// Runs only as the real /codex:native-probe Bash command. No custom domain.
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const [lib, root, mode] = process.argv.slice(2);
let psCalls = 0;
for (const method of ["spawnSync", "execFileSync", "execSync", "spawn", "execFile", "exec"]) {
  const original = childProcess[method];
  childProcess[method] = function (file, ...args) {
    if (typeof file === "string" && /(^|[\/\s])ps(?:\s|$)/.test(file)) {
      psCalls++;
      throw Object.assign(new Error("ps is unavailable inside this consumer proof"), { code: "EPERM" });
    }
    return original.call(this, file, ...args);
  };
}
syncBuiltinESMExports();
if (mode === "different-root") process.env.CLAUDE_PLUGIN_DATA = path.join(root, "different-data");
const { openStateLock, updateState, loadState, resolveStateFile } = await import(pathToFileURL(path.join(lib, "state.mjs")));
let sandboxWitness = "write-allowed", witnessError = null;
try { fs.writeFileSync(path.join(root, "outside-denied", `witness-${mode}`), "must be denied"); }
catch (error) { witnessError = error.code; sandboxWitness = ["EACCES", "EPERM"].includes(error.code) ? "write-denied" : "unexpected-error"; }
let acquired = false, updated = false, error = null;
const stateFile = resolveStateFile(root);
const before = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
try {
  const lock = openStateLock(root);
  const handle = lock.tryAcquire();
  acquired = Boolean(handle);
  if (handle) lock.release(handle);
  if (mode === "admitted" && acquired) {
    updateState(root, (state) => { state.config.stopReviewGate = true; });
    updated = loadState(root).config.stopReviewGate === true;
  }
} catch (caught) { error = { code: caught.code ?? null, message: caught.message }; }
const after = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
const expectedAdmission = mode === "admitted";
const out = {
  mode, acquired, updated, psCalls, error, sandboxWitness, witnessError,
  sessionPresent: Boolean(process.env.CODEX_COMPANION_SESSION_ID),
  certificatePresent: Boolean(process.env.CODEX_COMPANION_LOCK_ADMISSION),
  stateUnchanged: before === after,
  passed: !error && psCalls === 0 && sandboxWitness === "write-denied" &&
    (expectedAdmission ? acquired && updated : !acquired && before === after)
};
fs.writeFileSync(path.join(root, `${mode}.bash.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
process.exitCode = out.passed ? 0 : 1;
