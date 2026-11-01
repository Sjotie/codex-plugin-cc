// Test harness (#1762 installer): runs the script's main() with injected test dependencies. The script itself reads
// no test hooks; only this harness can inject them.
//   node harness.mjs '<spec json>' <installer args...>
//   spec: { "beforeRenameScript": path, "stubLifetimeMs": n, "stopDelayMs": n, "fixedTmpSuffix": ".tmp-x" }
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const spec = JSON.parse(process.argv[2]);
const mod = await import(pathToFileURL(process.env.CX1762_SCRIPT).href);
const deps = {};
if (spec.beforeRenameScript) deps.beforeRename = () => execFileSync(process.execPath, [spec.beforeRenameScript], { stdio: "ignore" });
if (spec.stubLifetimeMs) deps.stubLifetimeMs = spec.stubLifetimeMs;
if (spec.stopDelayMs) deps.stopDelayMs = spec.stopDelayMs;
if (spec.fixedTmpSuffix) deps.tmpName = (file) => `${file}${spec.fixedTmpSuffix}`; // a predictable name a test can plant
await mod.main(process.argv.slice(3), deps);
