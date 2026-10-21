// Test-only preload. Keep the real product hook command and files unchanged.
// It confines product Node processes to owned fixture data and observes calls.
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const root = process.env.FENCED_LOCK_NATIVE_ROOT;
const script = path.resolve(process.argv[1] ?? "");
if (root && (script.startsWith(path.join(root, "plugin", "scripts") + path.sep) || ["macos-companion-probe.mjs", "macos-companion-replay.mjs"].includes(path.basename(script)))) {
  const config = JSON.parse(fs.readFileSync(path.join(root, "native-config.json"), "utf8"));
  const base = path.basename(script);
  const event = base === "session-lifecycle-hook.mjs" ? process.argv[2] : base === "stop-review-gate-hook.mjs" ? "Stop" : base === "macos-companion-probe.mjs" ? "Bash" : "child";
  const nativeSession = process.env.CLAUDE_CODE_SESSION_ID;
  const append = fs.appendFileSync.bind(fs);
  const log = (value) => append(path.join(root, "events.jsonl"), `${JSON.stringify({ phase: config.phase, pid: process.pid, event, ...value })}\n`);
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
      log({ kind: "environment-v2-published", source: input?.source ?? null });
      if (config.mode === "crash-after-env" && shouldFault()) { log({ kind: "injected-crash", point: "after-env-before-ready" }); process.kill(process.pid, "SIGKILL"); }
    }
    return result;
  };
  const stdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (value, ...args) {
    let receipt = null;
    try { receipt = JSON.parse(String(value)).codexStateLockAdmission; } catch {}
    if (event === "SessionStart" && receipt?.generation) {
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
