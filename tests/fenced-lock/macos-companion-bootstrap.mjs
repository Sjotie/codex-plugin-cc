// Wire v2 only (pre-D): see wire-v2-only.mjs; wire v3 uses macos-d-pty-probe.py.
// Loaded only by the guarded entrypoints, so it does not exit itself.
// Test-only preload. Keep the real product hook command and files unchanged.
// It confines product Node processes to owned fixture data and observes calls.
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash, createCipheriv, randomBytes } from "node:crypto";

const root = process.env.FENCED_LOCK_NATIVE_ROOT;
const script = path.resolve(process.argv[1] ?? "");
if (root && (script.startsWith(path.join(root, "plugin", "scripts") + path.sep) || ["macos-companion-probe.mjs", "macos-companion-replay.mjs"].includes(path.basename(script)))) {
  const config = JSON.parse(fs.readFileSync(path.join(root, "native-config.json"), "utf8"));
  const base = path.basename(script);
  const event = base === "session-lifecycle-hook.mjs" ? process.argv[2] : base === "stop-review-gate-hook.mjs" ? "Stop" : base === "macos-companion-probe.mjs" ? "Bash" : "child";
  const nativeSession = process.env.CLAUDE_CODE_SESSION_ID;
  const append = fs.appendFileSync.bind(fs);
  const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
  const log = (value) => { try { append(path.join(root, "events.jsonl"), `${JSON.stringify({ phase: config.phase, pid: process.pid, event, ...value })}\n`); } catch { process.env.FENCED_LOCK_NATIVE_OBSERVER_FAILED = "1"; } };
  const envFileSnapshot = (stage) => {
    try {
      const file = process.env.CLAUDE_ENV_FILE;
      if (!file) { log({ kind: "envfile-observed", stage, present: false }); return; }
      const stat = fs.statSync(file, { bigint: true }), bytes = fs.readFileSync(file);
      let last = null;
      for (const line of bytes.toString("utf8").split("\n")) { const match = line.match(/^export CODEX_COMPANION_LOCK_ADMISSION='(.*)'\s*$/); if (match) { try { last = JSON.parse(match[1].replaceAll("'\\''", "'")); } catch {} } }
      log({ kind: "envfile-observed", stage, present: true, pathSha256: sha(file), fileIdentitySha256: sha(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`), fileSha256: sha(bytes), generation: last?.generation ?? null, source: last?.source ?? null, fullEnvelopeSha256: sha(last ? JSON.stringify(last) : ""), baseCertificateSha256: sha(JSON.stringify(last?.admission ?? null)), keyAbsent: !bytes.includes(Buffer.from(process.env.FENCED_LOCK_NATIVE_CAPTURE_KEY ?? "__no_key__")) });
    } catch { log({ kind: "envfile-observed", stage, present: null, inconclusive: true }); }
  };
  const { DatabaseSync } = await import("node:sqlite");
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const statement = prepare.call(this, sql, ...args);
    if (sql === "SELECT payload FROM fenced_lock_session_admission_v1 WHERE session_id = ?") {
      const get = statement.get;
      statement.get = function (...values) {
        const row = get.apply(this, values);
        let payload = null; try { payload = row ? JSON.parse(row.payload) : null; } catch {}
        try { log({ kind: "session-row-read", sessionSha256: sha(values[0] ?? ""), rowPresent: Boolean(row), rowPayloadSha256: sha(row?.payload ?? ""), state: payload?.state ?? null, generation: payload?.generation ?? null, bindingEpochSha256: sha(payload?.bindingEpoch ?? ""), baseCertificateSha256: sha(JSON.stringify(payload?.admission ?? null)), authoritySha256: sha(payload?.authority ?? ""), fenceSha256: sha(payload?.fence ?? "") }); }
        catch { process.env.FENCED_LOCK_NATIVE_OBSERVER_FAILED = "1"; }
        return row;
      };
    }
    return statement;
  };
  log({ kind: "entry", certificateInherited: Boolean(process.env.CODEX_COMPANION_LOCK_ADMISSION), companionSessionInherited: Boolean(process.env.CODEX_COMPANION_SESSION_ID), nativeSessionPresent: Boolean(nativeSession) });
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, config.mode === "wrong-root" && ["Stop", "SessionEnd", "Bash"].includes(event) ? "wrong-data" : "data");
  process.env.CODEX_HOME = path.join(root, "codex-home");
  process.env.PATH = `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`;
  if (config.mode === "wrong-sid" && ["Stop", "SessionEnd", "Bash"].includes(event)) process.env.CLAUDE_CODE_SESSION_ID = `wrong-${nativeSession}`;
  const producer = event === "SessionStart" || event === "child" && process.env.FENCED_LOCK_NATIVE_SCAN_CONTEXT === "SessionStart";
  process.env.FENCED_LOCK_NATIVE_SCAN_CONTEXT = producer ? "SessionStart" : "consumer";
  let psCalls = 0, lsofCalls = 0, input = null;
  const read = fs.readFileSync.bind(fs);
  fs.readFileSync = function (file, ...args) {
    const result = read(file, ...args);
    if (file === 0 && ["SessionStart", "SessionEnd", "Stop"].includes(event)) {
      try {
        input = JSON.parse(String(result));
        if (event === "SessionStart") envFileSnapshot("before-SessionStart");
        const metadata = { sessionId: input.session_id, nativeSessionId: nativeSession, cwd: input.cwd, transcriptPath: input.transcript_path, source: input.source ?? null, reason: input.reason ?? null };
        fs.writeFileSync(path.join(root, `${config.phase}.${event}.${process.pid}.input.json`), JSON.stringify(metadata));
        let transcriptExists = false, transcriptRegular = false, transcriptParentExists = false;
        try { const stat = fs.statSync(input.transcript_path); transcriptExists = true; transcriptRegular = stat.isFile(); } catch {}
        try { transcriptParentExists = fs.statSync(path.dirname(input.transcript_path)).isDirectory(); } catch {}
        log({ kind: "input", source: metadata.source, reason: metadata.reason, nativeSessionMatchesInput: nativeSession === input.session_id, effectiveNativeSessionMatchesInput: process.env.CLAUDE_CODE_SESSION_ID === input.session_id, dataRootIsExpected: process.env.CLAUDE_PLUGIN_DATA === path.join(root, "data"), cwdMatchesInput: path.resolve(process.cwd()) === path.resolve(input.cwd), transcriptExistsAtInputRead: transcriptExists, transcriptRegularAtInputRead: transcriptRegular, transcriptParentExistsAtInputRead: transcriptParentExists });
      } catch { log({ kind: "input-error" }); }
    }
    return result;
  };
  for (const method of ["spawnSync", "execFileSync", "execSync", "spawn", "execFile", "exec"]) {
    const original = childProcess[method];
    childProcess[method] = function (file, ...args) {
      const executable = typeof file === "string" ? path.basename(file).split(/\s/, 1)[0] : "";
      if (executable === "ps" || executable === "lsof") {
        if (executable === "ps") psCalls++; else lsofCalls++;
        log({ kind: "process-inspection", executable, allowedProducer: producer });
        if (!producer) throw Object.assign(new Error("process inspection is unavailable to a native admission consumer"), { code: "EPERM" });
      }
      return original.call(this, file, ...args);
    };
  }
  const shouldFault = () => !config.faultSource || config.faultSource === input?.source;
  fs.appendFileSync = function (file, value, ...args) {
    const result = append(file, value, ...args);
    if (event === "SessionStart" && file === process.env.CLAUDE_ENV_FILE && String(value).startsWith("export CODEX_COMPANION_LOCK_ADMISSION=") && String(value).includes('"version":2')) {
      try {
      let envelope = null;
      try { const match = String(value).match(/^export CODEX_COMPANION_LOCK_ADMISSION='(.*)'\s*$/s); if (match) envelope = JSON.parse(match[1].replaceAll("'\\''", "'")); } catch {}
      const stat = fs.statSync(file, { bigint: true });
      log({ kind: "environment-v2-published", source: input?.source ?? null, generation: envelope?.generation ?? null, fullEnvelopeSha256: sha(envelope ? JSON.stringify(envelope) : ""), baseCertificateSha256: sha(JSON.stringify(envelope?.admission ?? null)), envFilePathSha256: sha(file), envFileIdentitySha256: sha(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`), envFileSha256: sha(fs.readFileSync(file)), keyAbsent: !String(value).includes(process.env.FENCED_LOCK_NATIVE_CAPTURE_KEY ?? "__no_key__") });
      if (envelope && process.env.FENCED_LOCK_NATIVE_CAPTURE_KEY) {
        const key = Buffer.from(process.env.FENCED_LOCK_NATIVE_CAPTURE_KEY, "base64"), iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const values = { CODEX_COMPANION_LOCK_ADMISSION: JSON.stringify(envelope), CODEX_COMPANION_SESSION_ID: input.session_id, CLAUDE_CODE_SESSION_ID: input.session_id, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA };
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
        fs.writeFileSync(path.join(root, `${config.phase}.session-start.admission.enc.json`), JSON.stringify({ version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }), { mode: 0o600 });
      }
      } catch { process.env.FENCED_LOCK_NATIVE_OBSERVER_FAILED = "1"; }
      if (config.mode === "crash-after-env" && shouldFault()) { log({ kind: "injected-crash", point: "after-env-before-ready" }); process.kill(process.pid, "SIGKILL"); }
    }
    return result;
  };
  const stdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (value, ...args) {
    let receipt = null;
    try { receipt = JSON.parse(String(value)).codexStateLockAdmission; } catch {}
    if (event === "SessionStart" && receipt?.generation) {
      envFileSnapshot("after-SessionStart");
      log({ kind: "receipt-published", source: receipt.source ?? null, generation: receipt.generation });
      if (config.mode === "crash-after-ready" && shouldFault()) {
        fs.writeSync(1, value); // prove stdout reached Claude before the crash
        log({ kind: "injected-crash", point: "after-ready-before-exit-zero" });
        process.kill(process.pid, "SIGKILL");
      }
    }
    return stdout(value, ...args);
  };
  process.on("exit", (code) => log({ kind: "exit", code, psCalls, lsofCalls, certificatePresentAtExit: Boolean(process.env.CODEX_COMPANION_LOCK_ADMISSION), companionSessionPresentAtExit: Boolean(process.env.CODEX_COMPANION_SESSION_ID) }));
  syncBuiltinESMExports();
}
