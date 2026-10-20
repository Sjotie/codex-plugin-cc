// Test processes only (#1916): the seal scans every process on the machine,
// and on a developer machine other sessions may run old plugin processes.
// When FENCED_LOCK_SCAN_SCOPE names a file, the scan of /proc in this process
// sees only the pids listed there (one per line) plus itself, so a test
// decides exactly which old processes exist. Nothing in the product reads this.
import fs from "node:fs";

const scopeFile = process.env.FENCED_LOCK_SCAN_SCOPE;
if (scopeFile && !globalThis.__fencedLockScanScope) {
  globalThis.__fencedLockScanScope = scopeFile;
  const readdirSync = fs.readdirSync;
  fs.readdirSync = function (dir, ...rest) {
    const names = readdirSync.call(this, dir, ...rest);
    if (String(dir) !== "/proc") return names;
    let allowed = [];
    try {
      allowed = fs.readFileSync(scopeFile, "utf8").split("\n").filter(Boolean);
    } catch {
      allowed = [];
    }
    const keep = new Set([...allowed, String(process.pid)]);
    return names.filter((name) => !/^\d+$/.test(String(name)) || keep.has(String(name)));
  };
}
