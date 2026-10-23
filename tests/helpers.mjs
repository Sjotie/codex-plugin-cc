import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// #1983: a test run started inside an agent session inherits that session's ids, and
// status/result then hide every job written without them. #1916: inherited plugin
// data/config roots can also write test state into the real agent installation.
// Tests own their environment and choose any provider/plugin paths explicitly.
for (const name of ["CODEX_COMPANION_SESSION_ID", "CODEX_COMPANION_TRANSCRIPT_PATH", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PLUGIN_DATA", "CLAUDE_CONFIG_DIR"]) {
  delete process.env[name];
}

// #1916: the seal of the state lock scans every process on the machine, and
// other sessions on a developer machine may run old plugin processes. Tests
// and every node process they start see only the processes a test exposes
// (tests/fenced-lock/scan-scope.mjs); the default scope is empty.
if (!process.env.FENCED_LOCK_SCAN_SCOPE) {
  const scope = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fenced-lock-scope-")), "scan-scope");
  fs.writeFileSync(scope, "");
  process.env.FENCED_LOCK_SCAN_SCOPE = scope;
}
const SCAN_SCOPE_MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fenced-lock", "scan-scope.mjs");
if (!String(process.env.NODE_OPTIONS ?? "").includes("scan-scope.mjs")) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(SCAN_SCOPE_MODULE).href}`.trim();
}
await import("./fenced-lock/scan-scope.mjs");

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
