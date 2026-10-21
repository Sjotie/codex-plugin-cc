// Invoked by macos-live.mjs in a shell, a real SessionStart hook, and a
// /codex command's Bash tool. Only temporary fixture state is changed.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [lib, root, route] = process.argv.slice(2);
const { openFencedLock, domainVerdict } = await import(pathToFileURL(path.join(lib, "fenced-lock.mjs")));
const { matchPluginArgv } = await import(pathToFileURL(path.join(lib, "state.mjs")));
const target = JSON.parse(fs.readFileSync(path.join(root, "targets.json"), "utf8"))[route];
// Exercise the proposed initial verdict with the real canary and scanner.
// This does not enable MACOS_SCAN_PROVEN in the product.
const lock = openFencedLock(target.fence, {
  argvMatch: matchPluginArgv,
  domain: () => domainVerdict({ macosScanProven: true })
});
let error = null;
let acquired = false;
try {
  const h = lock.tryAcquire();
  acquired = Boolean(h);
  if (h) lock.release(h);
} catch (e) {
  error = { code: e.code, message: e.message };
}
let record = null;
try { record = JSON.parse(fs.readFileSync(path.join(target.fence, "fence.json"), "utf8")); } catch {}

// M3: retain counts of ps's argument forms, never unrelated command lines.
const ps = (cols) => execFileSync("ps", ["-axww", "-o", cols], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
let observation;
try {
  const args = new Map(ps("pid=,args=").split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s?(.*)$/.exec(line);
    return m ? [[Number(m[1]), m[2].trim()]] : [];
  }));
  const bucket = () => ({ total: 0, readable: 0, empty: 0, parenthesized: 0 });
  observation = { root: bucket(), other: bucket() };
  for (const line of ps("pid=,uid=,comm=").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[2]) === process.getuid()) continue;
    const b = Number(m[2]) === 0 ? observation.root : observation.other;
    const a = args.get(Number(m[1])) ?? "";
    b.total++;
    b[a === "" ? "empty" : /^\(.*\)$/.test(a) ? "parenthesized" : "readable"]++;
  }
} catch (e) {
  observation = { error: e.code ?? e.status, message: e.message.split("\n")[0] };
}
let sandboxWitness;
try {
  execFileSync("touch", [path.join(root, "outside-denied", "witness")], { stdio: "ignore" });
  sandboxWitness = "write-allowed";
} catch { sandboxWitness = "write-denied"; }
const out = {
  route, acquired, targetInS0: Boolean(record?.S0?.some((p) => p.pid === target.pid)),
  sealedAt: record?.sealedAt ?? null, verdict: record?.verdict ?? null,
  error, observation, sandboxWitness
};
fs.writeFileSync(path.join(root, `${route}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
