// Route 2 integration, with a deterministic ps fixture in child processes.
// The real, unfiltered hook + Claude sandbox route lives in macos-live.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const hook = path.join(repo, "plugins/codex/scripts/session-lifecycle-hook.mjs");
const state = pathToFileURL(path.join(repo, "plugins/codex/scripts/lib/state.mjs")).href;
const CERT = "CODEX_COMPANION_LOCK_ADMISSION";
const options = { skip: process.platform === "win32" && "Windows unsupported" };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const envFile = path.join(root, "claude-env.sh");
  fs.writeFileSync(envFile, "");
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, "{}");
  const preload = path.join(root, "fixture.mjs");
  fs.writeFileSync(preload, `
    import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    Object.defineProperty(process,'platform',{value:'darwin'});
    globalThis.admissionPsCalls=0;
    cp.execFileSync=function(bin,args,...rest){
      if(bin!=='ps' && bin!=='lsof') throw Object.assign(new Error('fixture spawn denied'),{code:'EPERM'});
      const c=JSON.parse(fs.readFileSync(process.env.ADMISSION_FIXTURE,'utf8'));
      if(bin==='lsof') throw Object.assign(new Error('no marker'),{status:1});
      globalThis.admissionPsCalls++;
      if(c.consumer || c.failPs) throw Object.assign(new Error('ps denied'),{code:'EPERM'});
      const cols=args.at(-1); const start='Wed Oct 21 16:00:00 2026';
      if(cols==='pid=') return '1\\n'+process.ppid+'\\n';
      if(args[0]==='-p') {
        if(!c.old) throw Object.assign(new Error('gone'),{status:1});
        if(cols==='stat=,lstart=') return 'S '+start;
        if(cols==='args=') return 'node /fixture/scripts/codex-companion.mjs task-worker';
        if(cols==='comm=') return 'node';
      }
      const pids=[process.pid,...(c.old?[606060]:[])];
      if(cols==='pid=,ppid=,uid=,stat=,lstart=') return pids.map(p=>p+' '+process.ppid+' 501 S '+start).join('\\n');
      if(cols==='pid=,comm=') return pids.map(p=>p+' node').join('\\n');
      if(cols==='pid=,args=') return pids.map(p=>p+' node /fixture/scripts/codex-companion.mjs task-worker').join('\\n');
      throw new Error('unexpected ps fixture');
    };
    const rename=fs.renameSync;
    fs.renameSync=function(from,to,...rest){const r=rename.call(this,from,to,...rest);
      if(String(to).endsWith('/fence.json') && JSON.parse(fs.readFileSync(process.env.ADMISSION_FIXTURE,'utf8')).crash) process.kill(process.pid,'SIGKILL');
      return r;};
    syncBuiltinESMExports();
  `);
  const env = { ...process.env, NODE_OPTIONS: "", CLAUDE_ENV_FILE: envFile,
    CLAUDE_PLUGIN_DATA: path.join(root, "data"), ADMISSION_FIXTURE: config };
  delete env[CERT];
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_COMPANION_SESSION_ID;
  const runHook = (spec = {}, input = JSON.stringify({ cwd: workspace, session_id: "session-current" })) => {
    fs.writeFileSync(config, JSON.stringify(spec));
    return spawnSync(process.execPath, ["--import", preload, hook, "SessionStart"], {
      cwd: workspace, env, encoding: "utf8", input
    });
  };
  const consume = (extra = {}, write = false) => {
    fs.writeFileSync(config, JSON.stringify({ consumer: true }));
    const code = `Object.assign(process.env,${JSON.stringify(extra)}); const m=await import(${JSON.stringify(state)}); const cwd=process.argv[1];
      const lock=m.openStateLock(cwd); let acquired=false,error=null;
      try {if(${write === "denied"}) {let tick=0;Object.defineProperty(performance,'now',{value:()=>tick+=10000});m.updateState(cwd,s=>{s.config.stopReviewGate=true;});}
        const h=lock.tryAcquire(); acquired=!!h; if(h) lock.release(h);
        if(acquired && ${write === true}) m.updateState(cwd,s=>{s.config.stopReviewGate=true;});
      } catch(e){error={code:e.code,message:e.message};}
      console.log(JSON.stringify({acquired,error,fence:m.resolveLockPath(cwd),psCalls:globalThis.admissionPsCalls}));`;
    const r = spawnSync("/bin/bash", ["-c", 'source "$1"; exec "$2" --import "$3" --input-type=module -e "$4" "$5"', "fixture", envFile, process.execPath, preload, code, workspace], {
      cwd: workspace, env: { ...env, ...extra }, encoding: "utf8"
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { root, workspace, envFile, runHook, consume, env };
}

function prepared(t) {
  const f = fixture(t);
  const r = f.runHook();
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(f.envFile, "utf8"), /CODEX_COMPANION_LOCK_ADMISSION='\{/);
  const c = f.consume();
  assert.equal(c.acquired, true, JSON.stringify(c));
  assert.equal(c.psCalls, 0);
  return { ...f, fence: c.fence };
}

test("route2: hook seal is consumed without ps and permits a real state commit", options, (t) => {
  const f = prepared(t);
  const r = f.consume({}, true);
  assert.equal(r.acquired, true, JSON.stringify(r));
  assert.equal(r.psCalls, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(r.fence), "state.json"))).config.stopReviewGate, true);
});

test("route2: absent hook refuses without publishing F", options, (t) => {
  const f = fixture(t);
  const r = f.consume();
  assert.equal(r.acquired, false);
  assert.equal(fs.existsSync(r.fence), false);
  assert.equal(r.psCalls, 0);
});

test("route2: refused state write cannot create job directories before admission", options, (t) => {
  const f = fixture(t);
  const r = f.consume({}, "denied");
  assert.equal(r.error?.code, "ESTATELOCKTIMEOUT");
  assert.equal(fs.existsSync(path.dirname(r.fence)), false);
});

for (const fault of ["missing record", "unsealed record", "replaced F", "replaced A", "changed record", "different root", "different session", "malformed certificate"]) {
  test(`route2: ${fault} refuses without repairing evidence`, options, (t) => {
    const f = prepared(t);
    const record = path.join(f.fence, "fence.json");
    const extra = {};
    if (fault === "missing record") fs.unlinkSync(record);
    if (fault === "unsealed record") { const r = JSON.parse(fs.readFileSync(record)); r.sealedAt = null; fs.writeFileSync(record, JSON.stringify(r)); }
    if (fault === "changed record") fs.appendFileSync(record, "\n");
    if (fault === "replaced F") { fs.renameSync(f.fence, `${f.fence}.original`); fs.cpSync(`${f.fence}.original`, f.fence, { recursive: true }); }
    if (fault === "replaced A") { fs.renameSync(`${f.fence}.db`, `${f.fence}.db.original`); fs.copyFileSync(`${f.fence}.db.original`, `${f.fence}.db`); }
    if (fault === "different root") extra.CLAUDE_PLUGIN_DATA = path.join(f.root, "other-data");
    if (fault === "different session") fs.appendFileSync(f.envFile, "export CODEX_COMPANION_SESSION_ID='other-session'\n");
    if (fault === "malformed certificate") fs.appendFileSync(f.envFile, `export ${CERT}='invalid'\n`);
    const before = fs.existsSync(record) ? fs.readFileSync(record, "utf8") : null;
    const r = f.consume(extra);
    assert.equal(r.acquired, false, JSON.stringify(r));
    assert.equal(r.psCalls, 0);
    assert.equal(fs.existsSync(record) ? fs.readFileSync(record, "utf8") : null, before, "consumer cannot repair record");
    if (fault === "different root") assert.equal(fs.existsSync(r.fence), false);
  });
}

test("route2: hook error clears a prior certificate and refuses", options, (t) => {
  const f = prepared(t);
  const r = f.runHook({ failPs: true });
  assert.equal(r.status, 1, r.stderr);
  const c = f.consume();
  assert.equal(c.acquired, false, JSON.stringify(c));
  assert.equal(c.psCalls, 0);
});

test("route2: malformed hook input invalidates a previous export before parsing", options, (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.envFile, `export ${CERT}='prior-certificate'\n`);
  const r = f.runHook({}, "{invalid");
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(f.envFile, "utf8").trim().split("\n").at(-1), `export ${CERT}=''`);
});

test("route2: hook crash after F publication exports no permission", options, (t) => {
  const f = fixture(t);
  const r = f.runHook({ crash: true });
  assert.equal(r.signal, "SIGKILL");
  const c = f.consume();
  assert.equal(c.acquired, false);
  assert.equal(c.psCalls, 0);
});

test("route2: live old S0 prevents hook seal; next hook after proven exit permits", options, (t) => {
  const f = fixture(t);
  const r = f.runHook({ old: true });
  assert.equal(r.status, 1, r.stderr);
  const c = f.consume();
  assert.equal(c.acquired, false);
  const record = JSON.parse(fs.readFileSync(path.join(c.fence, "fence.json")));
  assert.equal(record.sealedAt, null);
  assert.equal(record.S0.some(p => p.pid === 606060), true);
  assert.equal(f.runHook().status, 0);
  assert.equal(f.consume().acquired, true);
});
