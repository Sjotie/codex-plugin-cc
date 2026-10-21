// Observer only: invokes the actual production hook, preserving Claude's
// hook stdin/envfile. Mutations afterwards touch this harness's fixture only.
import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [lib, root, mode] = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
const hookInput = JSON.parse(input);
assert.equal(fs.realpathSync(hookInput.cwd), fs.realpathSync(root), "only this fixture's cwd may reach the product hook");
// Claude assigns inline plugins a persistent per-profile data directory.
// This test's real hook must only operate on the owned fixture; its normal
// CLAUDE_ENV_FILE export then carries that exact path into the actual Bash.
process.env.CLAUDE_PLUGIN_DATA = path.join(root, ["old-writer", "admitted"].includes(mode) ? "data" : `data-${mode}`);
const target = JSON.parse(fs.readFileSync(path.join(root, "target.json"), "utf8"));
const hookPath = path.join(lib, "..", "session-lifecycle-hook.mjs");
const hookConfig = JSON.parse(fs.readFileSync(path.join(lib, "..", "..", "hooks", "hooks.json"), "utf8"));
const productionHooks = hookConfig.hooks.SessionStart.flatMap((entry) => entry.hooks)
  .filter((entry) => entry.command.includes("session-lifecycle-hook.mjs"));
assert.equal(productionHooks.length, 1, "one actual product SessionStart hook required");
const productionTimeoutMs = productionHooks[0].timeout * 1000;
assert.ok(Number.isSafeInteger(productionTimeoutMs) && productionTimeoutMs > 0 && productionTimeoutMs <= 30_000, "bounded production hook timeout required");
const hookStarted = performance.now();
const run = spawnSync(process.execPath, [hookPath, "SessionStart"], { input, encoding: "utf8", timeout: productionTimeoutMs, maxBuffer: 2 * 1024 * 1024 });
const hookDurationMs = Math.round(performance.now() - hookStarted);
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
const { resolveLockPath } = await import(pathToFileURL(path.join(lib, "state.mjs")));
const fence = resolveLockPath(hookInput.cwd);
const relative = path.relative(fs.realpathSync(root), fs.realpathSync(path.dirname(fence)));
assert.ok(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`), "fixture fence must remain inside its temporary root");
assert.equal(path.basename(fence), "state.lock");
function identity(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino) };
  } catch { return null; }
}
const fenceIdentity = identity(fence);
let record = null;
try { record = JSON.parse(fs.readFileSync(path.join(fence, "fence.json"), "utf8")); } catch {}
let exported = "";
try { exported = fs.readFileSync(process.env.CLAUDE_ENV_FILE, "utf8"); } catch {}
const certificateLine = exported.split("\n").filter((line) => line.startsWith("export CODEX_COMPANION_LOCK_ADMISSION=")).at(-1);
const certificateExported = Boolean(certificateLine && certificateLine !== "export CODEX_COMPANION_LOCK_ADMISSION=''");
let observation;
try {
  const ps = (cols) => execFileSync("ps", ["-axww", "-o", cols], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const args = new Map(ps("pid=,args=").split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s?(.*)$/.exec(line);
    return match ? [[Number(match[1]), match[2].trim()]] : [];
  }));
  const bucket = () => ({ total: 0, readable: 0, empty: 0, parenthesized: 0 });
  observation = { root: bucket(), other: bucket() };
  for (const line of ps("pid=,uid=,comm=").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[2]) === process.getuid()) continue;
    const count = Number(match[2]) === 0 ? observation.root : observation.other;
    const argv = args.get(Number(match[1])) ?? "";
    count.total++;
    count[argv === "" ? "empty" : /^\(.*\)$/.test(argv) ? "parenthesized" : "readable"]++;
  }
} catch (error) { observation = { error: error.code ?? error.status, message: error.message.split("\n")[0] }; }
let mutation = null;
if (run.status === 0 && certificateExported && record?.sealedAt) {
  if (mode === "missing-record") {
    fs.unlinkSync(path.join(fence, "fence.json")); mutation = "removed-record";
  } else if (mode === "replaced-fence") {
    const replacement = `${fence}.replacement`;
    fs.cpSync(fence, replacement, { recursive: true });
    fs.renameSync(fence, `${fence}.retained-${mode}`);
    fs.renameSync(replacement, fence); mutation = "copied-and-replaced-fence";
  }
}
const out = {
  mode, exit: { code: run.status, signal: run.signal, error: run.error?.code ?? null },
  hookDurationMs, productionTimeoutMs,
  targetInS0: Boolean(record?.S0?.some((p) => p.pid === target.pid)),
  sealedAt: record?.sealedAt ?? null, certificateExported, observation, mutation,
  fenceIdentity, finalFenceIdentity: identity(fence),
  recordPresentAfterMutation: fs.existsSync(path.join(fence, "fence.json")),
  actualHook: hookPath
};
fs.writeFileSync(path.join(root, `${mode}.hook.json`), JSON.stringify(out, null, 2));
process.exitCode = run.status ?? 1;
