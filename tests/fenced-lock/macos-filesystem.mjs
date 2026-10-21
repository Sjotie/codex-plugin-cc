// Opt-in P7/P8 measurements, not a pass/fail suite. Run through test-slot.
// FENCED_LOCK_NODES adds comma-separated Node binaries. Only own temp state
// is touched; both the filesystem operations and old code run in that Node.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OLD_PROTOCOLS } from "./old-trees.mjs";

if (process.platform !== "darwin") throw new Error("native macOS only");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fenced-lock-filesystem-"));
const runtimes = [...new Set([process.execPath, ...(process.env.FENCED_LOCK_NODES ?? "").split(",").filter(Boolean)])];
for (const runtime of runtimes) {
  const version = execFileSync(runtime, ["--version"], { encoding: "utf8" }).trim();
  const dir = fs.mkdtempSync(path.join(root, `${version}-`));
  const p8 = spawnSync(runtime, ["--input-type=module", "-e", `
    import fs from 'node:fs'; import path from 'node:path';
    const dir=process.argv[1], out={runtime:process.version};
    const observe=(name,fn)=>{try{fn();out[name]='ok'}catch(e){out[name]=e.code}};
    fs.mkdirSync(path.join(dir,'prep1'));fs.writeFileSync(path.join(dir,'prep1','README'),'fence');
    observe('renameEmpty',()=>fs.renameSync(path.join(dir,'prep1'),path.join(dir,'fence')));
    fs.mkdirSync(path.join(dir,'prep2'));fs.writeFileSync(path.join(dir,'prep2','README'),'fence');fs.writeFileSync(path.join(dir,'file'),'legacy');
    observe('renameOverFile',()=>fs.renameSync(path.join(dir,'prep2'),path.join(dir,'file')));
    observe('renameOverNonEmptyDir',()=>fs.renameSync(path.join(dir,'prep2'),path.join(dir,'fence')));
    observe('unlinkDir',()=>fs.unlinkSync(path.join(dir,'fence')));
    observe('readDir',()=>fs.readFileSync(path.join(dir,'fence')));
    console.log(JSON.stringify(out));`, dir], { encoding: "utf8", timeout: 10_000 });
  console.log(JSON.stringify({ probe: "P8", status: p8.status, error: p8.error?.code, observation: p8.stdout.trim(), stderr: p8.stderr.trim() }));
  for (const spec of Object.values(OLD_PROTOCOLS)) {
    const old = path.join(dir, spec.ref);
    fs.mkdirSync(old);
    execFileSync("tar", ["-x", "-C", old], { input: execFileSync("git", ["archive", spec.ref, "plugins/codex"], { cwd: repo }) });
    const state = path.join(old, "plugins/codex/scripts/lib/state.mjs");
    if (createHash("sha256").update(fs.readFileSync(state)).digest("hex") !== spec.stateSha256) throw new Error(`old state hash mismatch: ${spec.ref}`);
    const workspace = path.join(old, "workspace");
    fs.mkdirSync(workspace);
    const p7 = spawnSync(runtime, ["--input-type=module", "-e", `
      import fs from 'node:fs';import path from 'node:path';
      const m=await import(${JSON.stringify(pathToFileURL(state).href)});
      const ws=process.argv[1], dir=m.resolveStateDir(ws);
      fs.mkdirSync(dir,{recursive:true});const fence=path.join(dir,'state.lock');
      fs.mkdirSync(fence);const before=fs.statSync(fence).ino;
      let entered=false,error=null;
      try{m.updateState(ws,s=>{entered=true;return s})}catch(e){error=e.code??e.message}
      console.log(JSON.stringify({runtime:process.version,entered,error,fenceSurvived:fs.statSync(fence).ino===before}));`, workspace], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(old, "data") }, encoding: "utf8", timeout: 15_000
    });
    console.log(JSON.stringify({ probe: "P7", ref: spec.ref, status: p7.status, error: p7.error?.code, observation: p7.stdout.trim(), stderr: p7.stderr.trim() }));
  }
}
console.log(JSON.stringify({ scratch: root }));
