// Route 2 integration, with a deterministic ps fixture in child processes.
// The real, unfiltered hook + Claude sandbox route lives in macos-live.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepo = process.env.FENCED_LOCK_SESSION_PRODUCT_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
const CERT = "CODEX_COMPANION_LOCK_ADMISSION";
const options = { skip: process.platform === "win32" && "Windows unsupported" };
// Sanitized 2.1.301 record shapes; their hash is in provider-receipts.json.
const RECORDS = JSON.parse(fs.readFileSync(new URL("./fixtures/provider-receipts/claude-code-2.1.301.json", import.meta.url), "utf8"));
const fill = (shape, values) => JSON.parse(JSON.stringify(shape), (key, value) => typeof value === "string" && /^<[a-zA-Z]+>$/.test(value) ? values[value.slice(1, -1)] : typeof value === "string" ? value.replace(/<source>/, values.source) : value);

function fixture(t, repo = defaultRepo) {
  const hook = path.join(repo, "plugins/codex/scripts/session-lifecycle-hook.mjs");
  const state = pathToFileURL(path.join(repo, "plugins/codex/scripts/lib/state.mjs")).href;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const envFile = path.join(root, "claude-env.sh");
  fs.writeFileSync(envFile, "");
  const transcript = path.join(root, "transcript.jsonl");
  fs.writeFileSync(transcript, "");
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, "{}");
  const preload = path.join(root, "fixture.mjs");
  fs.writeFileSync(preload, `
    import fs from 'node:fs'; import cp from 'node:child_process'; import net from 'node:net'; import {syncBuiltinESMExports} from 'node:module';
    Object.defineProperty(process,'platform',{value:'darwin'});
    Object.defineProperty(process,'arch',{value:process.env.ADMISSION_FIXTURE_ARCH??'arm64'});
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
    const append=fs.appendFileSync;
    fs.appendFileSync=function(file,data,...rest){const r=append.call(this,file,data,...rest);
      if(JSON.parse(fs.readFileSync(process.env.ADMISSION_FIXTURE,'utf8')).crashExport && String(data).startsWith("export CODEX_COMPANION_LOCK_ADMISSION='{\"))process.kill(process.pid,'SIGKILL');
      return r;};
    const stdout=process.stdout.write.bind(process.stdout);
    process.stdout.write=function(data,...rest){const r=stdout(data,...rest);
      if(JSON.parse(fs.readFileSync(process.env.ADMISSION_FIXTURE,'utf8')).crashStdout && String(data).includes('codexStateLockAdmission'))process.kill(process.pid,'SIGKILL');
      return r;};
    const read=fs.readFileSync;let receiptReads=0;
    fs.readFileSync=function(file,...rest){
      if(file===0&&process.env.ADMISSION_STDIN_HOLD)while(!fs.existsSync(process.env.ADMISSION_STDIN_HOLD))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      const c=JSON.parse(read.call(this,process.env.ADMISSION_FIXTURE,'utf8'));
      if(c.denyAfterReceipt && String(file)===c.transcript && ++receiptReads>1)throw Object.assign(new Error('receipt became unreadable'),{code:'EPERM'});
      return read.call(this,file,...rest);};
    const initial=JSON.parse(read(process.env.ADMISSION_FIXTURE,'utf8'));
    if(initial.brokerWitness)net.createConnection=function(){fs.appendFileSync(initial.brokerWitness,'attempted\\n');throw new Error('fixture broker connection blocked');};
    if(initial.fast){let tick=0;Object.defineProperty(performance,'now',{value:()=>tick+=10000});}
    syncBuiltinESMExports();
  `);
  const env = { ...process.env, NODE_OPTIONS: "", CLAUDE_ENV_FILE: envFile,
    CLAUDE_PLUGIN_DATA: path.join(root, "data"), CLAUDE_CONFIG_DIR:path.join(root,"claude"), ADMISSION_FIXTURE: config };
  delete env[CERT];
  env.CLAUDE_CODE_SESSION_ID = "session-current";
  delete env.CODEX_COMPANION_SESSION_ID;
  const hookInput = (extra = {}) => ({ cwd: workspace, session_id: "session-current", transcript_path: transcript, source: "startup", ...extra });
  const receipt = (result, extra = {}) => {
    const r = fill(RECORDS.hookSuccess, { sessionId: extra.sessionId ?? "session-current", cwd: workspace, source: extra.source ?? "startup", exitCode: result.status ?? 1, stdout: result.stdout });
    return { ...r, attachment: { ...r.attachment, ...extra.attachment }, ...extra.record };
  };
  const appendReceipt = (result, extra = {}) => fs.appendFileSync(extra.transcriptFile ?? transcript, JSON.stringify(receipt(result, extra))+"\n");
  const runHook = (spec = {}, input = JSON.stringify(hookInput()), receiptOptions = {}) => {
    fs.writeFileSync(config, JSON.stringify(spec));
    const result = spawnSync(process.execPath, ["--import", preload, hook, "SessionStart"], {
      cwd: workspace, env, encoding: "utf8", input
    });
    let source = "startup"; try {source=JSON.parse(input).source;} catch {}
    if (!receiptOptions.omit) appendReceipt(result, {source, ...receiptOptions});
    return result;
  };
  // The real hook, started now and fed its stdin later: it begins its attempt
  // before reading stdin, so the attempt stays pending until feed().
  let holds = 0;
  const cleared = () => fs.readFileSync(env.CLAUDE_ENV_FILE, "utf8").split("\n").filter((l) => l === `export ${CERT}=''`).length;
  const startHook = async (input = hookInput(), spec = {}, extraEnv = {}) => {
    fs.writeFileSync(config, JSON.stringify(spec));
    const before = cleared();
    // The input is on stdin at once, as from Claude; the preload holds the
    // hook's stdin read until the hold file exists.
    const holdFile = path.join(root, `stdin-hold-${++holds}`);
    const child = spawn(process.execPath, ["--import", preload, hook, "SessionStart"], { cwd: workspace, env: { ...env, ...extraEnv, ADMISSION_STDIN_HOLD: holdFile }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(JSON.stringify(input));
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    const exited = new Promise((resolve) => child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr })));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
    // The hook clears the export only after its attempt is committed.
    for (let i = 0; i < 500 && cleared() === before && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(cleared(), before + 1, "hook did not begin its attempt");
    return { feed: async (receiptOptions = {}) => { fs.writeFileSync(holdFile, ""); const result = await exited;
      if (!receiptOptions.omit) appendReceipt(result, { source: input.source, sessionId: input.session_id, ...receiptOptions }); return result; } };
  };
  const consume = (extra = {}, write = false) => {
    fs.writeFileSync(config, JSON.stringify({ consumer: true }));
    const code = `Object.assign(process.env,${JSON.stringify(extra)}); const m=await import(${JSON.stringify(state)}); const cwd=process.argv[1];
      const lock=m.openStateLock(cwd); let acquired=false,error=null;
      try {if(${write === "denied"}) {let tick=0;Object.defineProperty(performance,'now',{value:()=>tick+=10000});m.updateState(cwd,s=>{s.config.stopReviewGate=true;});}
        const h=lock.tryAcquire(); acquired=!!h; if(h) lock.release(h);
        if(acquired && ${write === true}) m.updateState(cwd,s=>{s.config.stopReviewGate=true;});
        if(acquired && ${write === "seed-job"}) {const job={id:'fixture-queued',sessionId:'session-current',status:'queued',phase:'queued',pid:null};m.upsertJob(cwd,job);m.writeJobFile(cwd,job.id,job);}
      } catch(e){error={code:e.code,message:e.message};}
      console.log(JSON.stringify({acquired,error,fence:m.resolveLockPath(cwd),psCalls:globalThis.admissionPsCalls}));`;
    const r = spawnSync("/bin/bash", ["-c", 'source "$1"; exec "$2" --import "$3" --input-type=module -e "$4" "$5"', "fixture", envFile, process.execPath, preload, code, workspace], {
      cwd: workspace, env: { ...env, ...extra }, encoding: "utf8"
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const activate = (event, extra = {}, input = hookInput(), fixedCaller = true) => {
    fs.writeFileSync(config, JSON.stringify({consumer:true}));
    const caller=event==="Stop"?path.join(repo,"plugins/codex/scripts/stop-review-gate-hook.mjs"):hook;
    const code = `const cwd=process.argv[1];${fixedCaller?`process.argv[1]=${JSON.stringify(caller)};process.argv[2]=${JSON.stringify(event==="SessionEnd"?"SessionEnd":undefined)};`:""}const m=await import(${JSON.stringify(state)});let acquired=false,error=null;
      try{m.activateFixedHookAdmission(${JSON.stringify(input)},${JSON.stringify(event)});const l=m.openStateLock(cwd);const h=l.tryAcquire();acquired=!!h;if(h)l.release(h);}catch(e){error=e.message;}
      console.log(JSON.stringify({acquired,error,psCalls:globalThis.admissionPsCalls}));`;
    const r=spawnSync(process.execPath,["--import",preload,"--input-type=module","-e",code,workspace],{cwd:workspace,env:{...env,...extra},encoding:"utf8"});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
  };
  const runFixed = (event, spec={}) => {
    fs.writeFileSync(config, JSON.stringify({consumer:true,transcript,...spec}));
    const entry = event === "Stop" ? path.join(repo, "plugins/codex/scripts/stop-review-gate-hook.mjs") : hook;
    return spawnSync(process.execPath,["--import",preload,entry,event],{cwd:workspace,env:{...env,...(spec.brokerWitness?{CODEX_COMPANION_APP_SERVER_ENDPOINT:`unix:${path.join(root,'broker.sock')}`}:{})},input:JSON.stringify(hookInput({hook_event_name:event})),encoding:"utf8"});
  };
  const complete = (mode) => {
    fs.writeFileSync(config,JSON.stringify({consumer:true}));
    const code=`process.argv[1]=${JSON.stringify(hook)};process.argv[2]='SessionEnd';const m=await import(${JSON.stringify(state)});let completed=false,error=null;
      try{const a=${mode==="forged"?`{...JSON.parse(process.env.${CERT}),attemptId:JSON.parse(JSON.parse((await import('node:fs')).readFileSync(${JSON.stringify(transcript)},'utf8').trim().split('\\n').at(-1)).attachment.stdout).codexStateLockAdmission.attemptId}`:`m.activateFixedHookAdmission(${JSON.stringify(hookInput())},'SessionEnd')`};
      ${mode==="wrong path"?`process.argv[1]=${JSON.stringify(workspace)};`:""}m.completeFixedSessionEndAdmission(a);completed=true;}catch(e){error=e.message;}console.log(JSON.stringify({completed,error}));`;
    const r=spawnSync("/bin/bash",["-c",'source "$1"; exec "$2" --import "$3" --input-type=module -e "$4"',"fixture",envFile,process.execPath,preload,code],{cwd:workspace,env,encoding:"utf8"});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
  };
  const pausedEnd = async () => {
    fs.writeFileSync(config,JSON.stringify({consumer:true}));
    const code=`process.argv[1]=${JSON.stringify(hook)};process.argv[2]='SessionEnd';const m=await import(${JSON.stringify(state)});
      const a=m.activateFixedHookAdmission(${JSON.stringify(hookInput())},'SessionEnd');console.log('activated');
      process.stdin.once('data',()=>{let completed=false,error=null;try{m.completeFixedSessionEndAdmission(a);completed=true;}catch(e){error=e.message;}console.log(JSON.stringify({completed,error}));process.stdin.destroy();});`;
    const child=spawn(process.execPath,["--import",preload,"--input-type=module","-e",code],{cwd:workspace,env,stdio:["pipe","pipe","pipe"]});
    const exited=new Promise(resolve=>child.once("close",resolve));
    t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await exited;});
    let stderr="";child.stderr.on("data",d=>{stderr+=d;});
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    const ready=await lines.next();assert.equal(ready.value,"activated",stderr);
    return {finish:async()=>{child.stdin.end("complete\n");const r=await lines.next();await exited;return JSON.parse(r.value);}};
  };
  // A Stop or SessionEnd activation held open: it activates now and tries
  // its state write only when told to.
  const pausedActivation = async (event) => {
    fs.writeFileSync(config,JSON.stringify({consumer:true}));
    const caller=event==="Stop"?path.join(repo,"plugins/codex/scripts/stop-review-gate-hook.mjs"):hook;
    const code=`process.argv[1]=${JSON.stringify(caller)};process.argv[2]=${JSON.stringify(event==="SessionEnd"?"SessionEnd":undefined)};const cwd=${JSON.stringify(workspace)};const m=await import(${JSON.stringify(state)});
      m.activateFixedHookAdmission(${JSON.stringify(hookInput())},${JSON.stringify(event)});console.log('activated');
      process.stdin.once('data',()=>{let acquired=false,error=null;try{const l=m.openStateLock(cwd);const h=l.tryAcquire();acquired=!!h;if(h)l.release(h);}catch(e){error=e.message;}console.log(JSON.stringify({acquired,error}));process.stdin.destroy();});`;
    const child=spawn(process.execPath,["--import",preload,"--input-type=module","-e",code],{cwd:workspace,env,stdio:["pipe","pipe","pipe"]});
    const exited=new Promise(resolve=>child.once("close",resolve));
    t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await exited;});
    let stderr="";child.stderr.on("data",d=>{stderr+=d;});
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    const ready=await lines.next();assert.equal(ready.value,"activated",stderr);
    return {write:async()=>{child.stdin.end("go\n");const r=await lines.next();await exited;return JSON.parse(r.value);}};
  };
  // A worker process started from Bash: it inherits the envelope exported at
  // that moment and publishes a job result through runTrackedJob.
  const startWorker = (job, { waitMs = null, holdFile } = {}) => {
    fs.writeFileSync(config, JSON.stringify({ consumer: true }));
    const tracked = pathToFileURL(path.join(repo, "plugins/codex/scripts/lib/tracked-jobs.mjs")).href;
    const code = `const t=await import(${JSON.stringify(tracked)});const fs=await import('node:fs');const job=JSON.parse(process.argv[1]);let published=false,error=null;
      try{await t.runTrackedJob(job,async()=>{while(!fs.existsSync(${JSON.stringify(holdFile)}))await new Promise(r=>setTimeout(r,20));return {exitStatus:0,threadId:'thread-1',turnId:'turn-1',payload:{ok:true},rendered:'worker result survives compact',summary:'done'};});published=true;}
      catch(e){error={code:e.code,message:e.message};}console.log(JSON.stringify({published,error}));`;
    const extra = waitMs === null ? {} : { CODEX_COMPANION_FINAL_PUBLISH_WAIT_MS: String(waitMs) };
    const child = spawn("/bin/bash", ["-c", 'source "$1"; exec "$2" --import "$3" --input-type=module -e "$4" "$5"', "worker", envFile, process.execPath, preload, code, JSON.stringify(job)], { cwd: workspace, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    const exited = new Promise((resolve) => child.once("close", (status) => resolve({ status, stdout, stderr })));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
    return exited;
  };
  // Refusal class of one acquire attempt: definitive is ESTATELOCKREFUSED,
  // transient is ESTATELOCKTIMEOUT with refusal "transient".
  // sourced: the env file this Bash call sources (default the live one).
  const classify = (extra = {}, sourced = envFile) => {
    fs.writeFileSync(config, JSON.stringify({ consumer: true }));
    const code = `const m=await import(${JSON.stringify(state)});const l=m.openStateLock(process.argv[1]);let out;
      try{const h=l.acquire({deadlineMs:0});l.release(h);out='acquired';}catch(e){out=e.code==='ESTATELOCKREFUSED'?'definitive':e.code==='ESTATELOCKTIMEOUT'&&e.refusal==='transient'?'transient':String(e.code)+'/'+e.refusal;}console.log(out);`;
    const r = spawnSync("/bin/bash", ["-c", 'source "$1"; exec "$2" --import "$3" --input-type=module -e "$4" "$5"', "fixture", sourced, process.execPath, preload, code, workspace], { cwd: workspace, env: { ...env, ...extra }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const readEnvelope = () => { const line = fs.readFileSync(envFile, "utf8").trim().split("\n").filter((l) => l.startsWith(`export ${CERT}='{`)).at(-1); return line ? JSON.parse(line.slice(`export ${CERT}='`.length, -1)) : null; };
  return { root, workspace, envFile, transcript, runHook, startHook, consume, classify, activate, pausedActivation, startWorker, readEnvelope, complete, pausedEnd, runFixed, hookInput, receipt, appendReceipt, env, repo };
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
  assert.equal(r.error?.code, "ESTATELOCKREFUSED");
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

for (const event of ["Stop", "SessionEnd"]) {
  test(`transport: fixed ${event} consumes current certificate without Bash exports or scan`, options, (t) => {
    const f=prepared(t);
    const result=f.activate(event);
    assert.equal(result.acquired,true,JSON.stringify(result));
    assert.equal(result.psCalls,0);
  });
}

test("transport: real SessionEnd cancels the queued job and index using the current proof",options,t=>{
  const f=prepared(t);assert.equal(f.consume({},"seed-job").acquired,true);
  const result=f.runFixed("SessionEnd");assert.equal(result.status,0,result.stderr);
  const dir=path.dirname(f.fence);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"state.json"))).jobs.find(j=>j.id==="fixture-queued").status,"cancelled");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"jobs/fixture-queued.json"))).status,"cancelled");
});

test("transport: completed SessionEnd revokes the old Bash and fixed-hook certificate",options,t=>{
  const f=prepared(t);const r=f.runFixed("SessionEnd");assert.equal(r.status,0,r.stderr);
  assert.equal(f.consume().acquired,false);
  assert.equal(f.activate("Stop").acquired,false);
});

for(const mode of ["forged","wrong path"]){
  test(`transport: ${mode} End completion cannot revoke a current session`,options,t=>{
    const f=prepared(t);assert.equal(f.complete(mode).completed,false);
    assert.equal(f.consume().acquired,true);
  });
}

test("transport: an older End completion cannot revoke a newer successful SessionStart",options,async t=>{
  const f=prepared(t),oldEnd=await f.pausedEnd();
  assert.equal(f.runHook({},JSON.stringify(f.hookInput({source:"resume"}))).status,0);
  const result=await oldEnd.finish();assert.equal(result.completed,false,JSON.stringify(result));
  assert.equal(f.consume().acquired,true,"the newer capability must survive stale End completion");
});

test("transport: SessionEnd aborts teardown when proof becomes unreadable after activation",options,t=>{
  const f=prepared(t);assert.equal(f.consume({},"seed-job").acquired,true);
  const brokerWitness=path.join(f.root,"broker-attempts");
  const result=f.runFixed("SessionEnd",{denyAfterReceipt:true,fast:true,brokerWitness});
  assert.equal(result.status,1,"unknown proof must not be reported as successful teardown");
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(f.fence),"state.json"))).jobs[0].status,"queued");
  assert.equal(fs.existsSync(brokerWitness),false,"cancellation failure must abort before broker shutdown, even if later completion also refuses");
});

test("transport: provider may create transcript after SessionStart, only its later receipt grants access",options,t=>{
  const f=fixture(t);fs.unlinkSync(f.transcript);
  const r=f.runHook({},undefined,{omit:true});assert.equal(r.status,0,r.stderr);
  assert.equal(fs.existsSync(f.transcript),false,"hook must not create the provider transcript");
  assert.equal(f.consume().acquired,false);
  f.appendReceipt(r);assert.equal(f.consume().acquired,true);
});

test("transport: env-file failure already stops the old capability before parent receipt",options,t=>{
  const f=prepared(t);f.env.CLAUDE_ENV_FILE=f.root;
  const r=f.runHook({},undefined,{omit:true});assert.equal(r.status,1);
  assert.equal(f.consume().acquired,false,"old capability must be stopped even before the provider records this failure");
});

test("transport: an arbitrary hook cannot activate the certificate",options,t=>{
  const f=prepared(t);
  assert.equal(f.activate("PreToolUse").acquired,false);
});

test("transport: another configured SessionStart hook cannot shadow this hook's receipt",options,t=>{
  const f=prepared(t);
  f.appendReceipt({status:0,stdout:JSON.stringify({continue:true})},{attachment:{command:'node "/fixture/another-plugin/session-start.mjs"'}});
  assert.equal(f.consume().acquired,true);
  assert.equal(f.activate("SessionEnd").acquired,true);
});

for(const prior of ["success","failed","absent"]){
  test(`transport: official additional-context metadata after ${prior} is not a completion receipt`,options,t=>{
    const f=fixture(t),r=f.runHook({},undefined,{omit:true});assert.equal(r.status,0,r.stderr);
    if(prior!=="absent")f.appendReceipt(r,prior==="failed"?{attachment:{exitCode:1}}:{});
    const context={type:"attachment",version:"2.1.301",sessionId:"session-current",cwd:f.workspace,isSidechain:false,
      attachment:{type:"hook_additional_context",hookName:"SessionStart",hookEvent:"SessionStart",content:["Codex Companion session context refreshed."],toolUseID:"fixture-hook"}};
    fs.appendFileSync(f.transcript,JSON.stringify(context)+"\n");
    assert.equal(f.consume().acquired,prior==="success");
    assert.equal(f.activate("SessionEnd").acquired,prior==="success");
  });
}

test("transport: unproven string additional-context shape cannot hide unknown receipt",options,t=>{
  const f=prepared(t);const r=f.receipt({status:0,stdout:""});
  r.attachment={type:"hook_additional_context",hookName:"SessionStart",hookEvent:"SessionStart",content:"unproven string shape",toolUseID:"fixture-hook"};
  fs.appendFileSync(f.transcript,JSON.stringify(r)+"\n");
  assert.equal(f.consume().acquired,false);
});

test("transport: a later SessionStart receipt with unknown command cannot be ignored",options,t=>{
  const f=prepared(t);f.appendReceipt({status:1,stdout:""},{attachment:{command:null}});
  assert.equal(f.consume().acquired,false);
  assert.equal(f.activate("Stop").acquired,false);
});

for(const fault of ["missing hook identity","wrong record type"]){
  test(`transport: own-command receipt with ${fault} cannot resurrect old success`,options,t=>{
    const f=prepared(t),r=JSON.parse(fs.readFileSync(f.transcript,"utf8").trim().split("\n").at(-1));
    if(fault==="missing hook identity"){delete r.attachment.hookName;delete r.attachment.hookEvent;}
    else r.type="unknown";
    fs.appendFileSync(f.transcript,JSON.stringify(r)+"\n");
    assert.equal(f.consume().acquired,false);
    assert.equal(f.activate("SessionEnd").acquired,false);
  });
}

for(const event of ["Stop","SessionEnd"]){
  test(`transport: ${event} event name alone cannot activate from another entrypoint`,options,t=>{
    const f=prepared(t);assert.equal(f.activate(event,{},f.hookInput(),false).acquired,false);
  });
}

// D (#1916): only a non-compact SessionStart replaces C; compact keeps it below.
for(const source of ["startup","resume","clear"]){
  test(`transport: ${source} SessionStart revokes the previous Bash capability`,options,t=>{
    const f=prepared(t),old=fs.readFileSync(f.envFile,"utf8");
    const result=f.runHook({},JSON.stringify(f.hookInput({source})));
    assert.equal(result.status,0,result.stderr);
    assert.equal(f.consume().acquired,true);
    fs.writeFileSync(f.envFile,old);
    assert.equal(f.consume().acquired,false,"old exported certificate must stay revoked");
    assert.equal(f.activate("Stop").acquired,true,"fixed hooks recover only the current capability");
  });
}

for(const fault of ["no receipt","nonzero success receipt","string zero","wrong version","wrong command","wrong session","wrong cwd","sidechain","wrong source","old token","other capability","partial receipt","malformed receipt","latest failure"]){
  test(`transport: ${fault} cannot authorize a sealed record`,options,t=>{
    const f=fixture(t),r=f.runHook({},undefined,{omit:true});
    assert.equal(r.status,0,r.stderr);
    const data=f.receipt(r);
    if(fault==="nonzero success receipt")data.attachment.exitCode=1;
    if(fault==="string zero")data.attachment.exitCode="0";
    if(fault==="wrong version")data.version="2.1.302";
    if(fault==="wrong command")data.attachment.command='node arbitrary-wrapper.mjs SessionStart';
    if(fault==="wrong session")data.sessionId="other-session";
    if(fault==="wrong cwd")data.cwd=f.root;
    if(fault==="sidechain")data.isSidechain=true;
    if(fault==="wrong source")data.attachment.hookName="SessionStart:resume";
    if(fault==="old token"){const value=JSON.parse(data.attachment.stdout||"{}");value.codexStateLockAdmission={...value.codexStateLockAdmission,attemptId:"0".repeat(64)};data.attachment.stdout=JSON.stringify(value);}
    if(fault==="other capability"){const value=JSON.parse(data.attachment.stdout||"{}");value.codexStateLockAdmission={...value.codexStateLockAdmission,capabilityId:"0".repeat(64)};data.attachment.stdout=JSON.stringify(value);}
    if(fault==="partial receipt")fs.writeFileSync(f.transcript,JSON.stringify(data).slice(0,-1));
    else if(fault==="malformed receipt")fs.writeFileSync(f.transcript,"{invalid}\n");
    else if(fault!=="no receipt")fs.writeFileSync(f.transcript,JSON.stringify(data)+"\n");
    if(fault==="latest failure")fs.appendFileSync(f.transcript,JSON.stringify({...data,attachment:{...data.attachment,type:"hook_non_blocking_error",exitCode:1,stdout:""}})+"\n");
    assert.equal(f.consume().acquired,false,"seal alone does not authorize Bash");
    assert.equal(f.activate("SessionEnd").acquired,false,"seal alone does not authorize fixed hooks");
  });
}

for(const fault of ["malformed input","scan failure","crash","crash after stdout"]){
  test(`transport: ${fault} revokes old Bash and fixed-hook proof`,options,t=>{
    const f=prepared(t),old=fs.readFileSync(f.envFile,"utf8");
    const r=f.runHook({failPs:fault==="scan failure",crashExport:fault==="crash",crashStdout:fault==="crash after stdout"},fault==="malformed input"?"{invalid":undefined);
    assert.ok(r.status!==0||r.signal);
    fs.writeFileSync(f.envFile,old);
    assert.equal(f.consume().acquired,false);
    assert.equal(f.activate("Stop").acquired,false);
  });
}

test("transport: changed root on a new SessionStart cannot preserve the old capability",options,t=>{
  const f=prepared(t),old=fs.readFileSync(f.envFile,"utf8");
  const other=path.join(f.root,"other-workspace");fs.mkdirSync(other);
  const r=f.runHook({},JSON.stringify(f.hookInput({cwd:other})));
  assert.equal(r.status,1,r.stderr);
  fs.writeFileSync(f.envFile,old);
  assert.equal(f.consume().acquired,false);
  assert.equal(f.activate("SessionEnd").acquired,false);
});

test("transport: changed plugin data root on SessionStart revokes rather than rebinds",options,t=>{
  const f=prepared(t),old=fs.readFileSync(f.envFile,"utf8"),original=f.env.CLAUDE_PLUGIN_DATA;
  f.env.CLAUDE_PLUGIN_DATA=path.join(f.root,"other-data");
  const r=f.runHook();assert.equal(r.status,1,r.stderr);
  f.env.CLAUDE_PLUGIN_DATA=original;fs.writeFileSync(f.envFile,old);
  assert.equal(f.consume().acquired,false);
  assert.equal(f.activate("Stop").acquired,false);
});

for(const fault of ["missing native SID","mismatched native SID","unknown source"]){
  test(`transport: ${fault} cannot grant new authority`,options,t=>{
    const f=fixture(t);
    if(fault==="missing native SID")delete f.env.CLAUDE_CODE_SESSION_ID;
    if(fault==="mismatched native SID")f.env.CLAUDE_CODE_SESSION_ID="other-native";
    const r=f.runHook({},fault==="unknown source"?JSON.stringify(f.hookInput({source:"unknown"})):undefined);
    assert.equal(r.status,1,r.stderr);assert.equal(f.consume().acquired,false);
  });
}

for(const fault of ["different SID","different root","different transcript"]){
  test(`transport: fixed hooks refuse ${fault}`,options,t=>{
    const f=prepared(t);
    const extra=fault==="different root"?{CLAUDE_PLUGIN_DATA:path.join(f.root,"another-data")}:{};
    const input=f.hookInput(fault==="different SID"?{session_id:"other-session"}:fault==="different transcript"?{transcript_path:path.join(f.root,"other.jsonl")} :{});
    assert.equal(f.activate("SessionEnd",extra,input).acquired,false);
  });
}

for(const fault of ["missing","replaced copy","corrupt","foreign root","changed epoch"]){
  test(`transport: ${fault} locator denies both consumers without repair`,options,t=>{
    const f=prepared(t);
    const file=path.join(f.env.CLAUDE_CONFIG_DIR,"codex-companion-session-admission",`${createHash("sha256").update("session-current").digest("hex")}.json`);
    if(!fs.existsSync(file)){assert.equal(f.consume().acquired,false,"missing locator must deny, including a pre-transport seal");return;}
    if(fault==="missing")fs.unlinkSync(file);
    else if(fault==="replaced copy"){fs.renameSync(file,`${file}.old`);fs.copyFileSync(`${file}.old`,file);}
    else if(fault==="corrupt")fs.writeFileSync(file,"{invalid");
    else {const value=JSON.parse(fs.readFileSync(file));if(fault==="foreign root")value.root=path.join(f.root,"other");else value.bindingEpoch="0".repeat(64);fs.writeFileSync(file,JSON.stringify(value));}
    const before=fs.existsSync(file)?fs.readFileSync(file,"utf8"):null;
    assert.equal(f.consume().acquired,false);
    assert.equal(f.activate("SessionEnd").acquired,false);
    assert.equal(fs.existsSync(file)?fs.readFileSync(file,"utf8"):null,before);
  });
}

// ---- D (#1916): capability C over compact, attempt T, receipt R ----
// Claude gives SessionStart the same input for a manual (/compact) and an
// automatic compact: source "compact". The harness separates them by what is
// in flight: manual between two Bash calls, automatic while a worker waits
// to publish. The native PTY proof covers the real triggers.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envMap = (text) => Object.fromEntries(text.split("\n").filter((l) => l.startsWith("export ")).map((l) => { const m = /^export ([A-Z_]+)='(.*)'$/.exec(l); return [m[1], m[2].replace(/'"'"'/g, "'")]; }));
async function until(predicate, ms = 5000) { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error("condition not reached"); await sleep(20); } }

test("D: manual compact keeps C for the Bash envelope from before compact", options, (t) => {
  const f = prepared(t), old = fs.readFileSync(f.envFile, "utf8"), before = f.readEnvelope();
  const r = f.runHook({}, JSON.stringify(f.hookInput({ source: "compact" })));
  assert.equal(r.status, 0, r.stderr);
  const token = JSON.parse(r.stdout).codexStateLockAdmission;
  assert.deepEqual(Object.keys(token).sort(), ["attemptId", "capabilityId", "root", "sessionId", "source"]);
  assert.equal(token.capabilityId, before.capabilityId);
  assert.equal(token.source, "compact");
  assert.deepEqual(f.readEnvelope(), before, "compact exports the same C envelope");
  assert.equal(Object.hasOwn(before, "source"), false, "LOW-6: no source in the envelope");
  fs.writeFileSync(f.envFile, old);
  assert.equal(f.consume({}, true).acquired, true, "the envelope cached before compact still writes state");
  assert.equal(f.classify(), "acquired");
});

test("D: compact refuses while its attempt is pending, then admits after its own receipt", options, async (t) => {
  // A Bash call keeps the envelope it had before compact (Claude caches it).
  const f = prepared(t), held = path.join(f.root, "held.env");
  fs.writeFileSync(held, fs.readFileSync(f.envFile, "utf8"));
  const hook = await f.startHook(f.hookInput({ source: "compact" }));
  assert.equal(f.classify({}, held), "transient", "pending compact is a transient refusal");
  const r = await hook.feed({ omit: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.classify({}, held), "transient", "ready without this attempt's receipt is transient");
  f.appendReceipt(r, { source: "compact" });
  assert.equal(f.classify({}, held), "acquired");
});

for (const [name, setup] of [
  ["no earlier admission", (f) => { const r = f.runHook({}, JSON.stringify(f.hookInput({ source: "compact" }))); return r; }],
  ["a crashed earlier attempt", (f) => { const crash = f.runHook({ crashExport: true }); assert.equal(crash.signal, "SIGKILL"); return f.runHook({}, JSON.stringify(f.hookInput({ source: "compact" }))); }],
  ["a failed predecessor receipt", (f) => { f.appendReceipt({ status: 1, stdout: "" }); return f.runHook({}, JSON.stringify(f.hookInput({ source: "compact" }))); }],
  ["an unproven provider version", (f) => { const lines = fs.readFileSync(f.transcript, "utf8").trim().split("\n"); const last = JSON.parse(lines.pop()); last.version = "2.1.302"; fs.writeFileSync(f.transcript, [...lines, JSON.stringify(last)].join("\n") + "\n"); return f.runHook({}, JSON.stringify(f.hookInput({ source: "compact" }))); }]
]) {
  test(`D: compact after ${name} is refused and does not carry C forward`, options, (t) => {
    const f = name === "no earlier admission" ? fixture(t) : prepared(t), old = fs.readFileSync(f.envFile, "utf8");
    const r = setup(f);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    fs.writeFileSync(f.envFile, old);
    assert.equal(f.consume().acquired, false);
    assert.equal(f.activate("Stop").acquired, false);
    const resumed = f.runHook({}, JSON.stringify(f.hookInput({ source: "resume" })));
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(f.consume().acquired, true, "resume is the recovery route, with a new C");
    fs.writeFileSync(f.envFile, old);
    assert.equal(f.consume().acquired, false, "the old C stays revoked after the recovery resume");
    assert.equal(f.classify(), "definitive");
  });
}

for (const source of ["startup", "resume", "clear"]) {
  test(`D: ${source} after compact replaces the preserved C definitively`, options, (t) => {
    const f = prepared(t);
    assert.equal(f.runHook({}, JSON.stringify(f.hookInput({ source: "compact" }))).status, 0);
    const old = fs.readFileSync(f.envFile, "utf8"), oldC = f.readEnvelope().capabilityId;
    assert.equal(f.runHook({}, JSON.stringify(f.hookInput({ source }))).status, 0);
    assert.notEqual(f.readEnvelope().capabilityId, oldC);
    assert.equal(f.consume().acquired, true);
    fs.writeFileSync(f.envFile, old);
    assert.equal(f.classify(), "definitive");
  });
}

test("D: receipt of the current attempt that failed is definitive, an unattributed failure is transient", options, (t) => {
  const f = prepared(t);
  const r = f.runHook({}, JSON.stringify(f.hookInput({ source: "compact" })), { omit: true });
  assert.equal(r.status, 0, r.stderr);
  f.appendReceipt({ status: 1, stdout: "" }, { source: "compact" });
  assert.equal(f.classify(), "transient", "a failure without a token cannot be attributed to this attempt");
  f.appendReceipt({ status: 1, stdout: r.stdout }, { source: "compact" });
  assert.equal(f.classify(), "definitive", "a failure carrying this attempt's token ends it");
});

test("D: Stop activated before compact is bound to T1 and refuses after compact; a new activation works", options, async (t) => {
  const f = prepared(t);
  const stop = await f.pausedActivation("Stop");
  assert.equal(f.runHook({}, JSON.stringify(f.hookInput({ source: "compact" }))).status, 0);
  assert.equal((await stop.write()).acquired, false, "activation of T1 cannot write after T2");
  assert.equal(f.activate("Stop").acquired, true);
  assert.equal(f.consume().acquired, true, "Bash with C still works");
});

test("D: SessionEnd activated before compact cannot revoke after compact kept C", options, async (t) => {
  const f = prepared(t), end = await f.pausedEnd();
  assert.equal(f.runHook({}, JSON.stringify(f.hookInput({ source: "compact" }))).status, 0);
  const result = await end.finish();
  assert.equal(result.completed, false, JSON.stringify(result));
  assert.equal(f.consume().acquired, true);
});

test("D: Stop overlapping a pending compact refuses during and after it", options, async (t) => {
  const f = prepared(t), stop = await f.pausedActivation("Stop");
  const hook = await f.startHook(f.hookInput({ source: "compact" }));
  const during = await stop.write();
  assert.equal(during.acquired, false);
  assert.equal((await hook.feed()).status, 0);
  assert.equal(f.activate("Stop").acquired, true);
});

for (const second of ["resume", "compact"]) {
  test(`D: two hook processes on the same SID (compact, then ${second}): the earlier attempt cannot finish`, options, async (t) => {
    const f = prepared(t), old = fs.readFileSync(f.envFile, "utf8"), oldC = f.readEnvelope().capabilityId;
    const a = await f.startHook(f.hookInput({ source: "compact" }));
    const b = await f.startHook(f.hookInput({ source: second }));
    const ra = await a.feed();
    assert.equal(ra.status, 1, "T2 lost its CAS to T3");
    assert.match(ra.stderr, /no longer pending/);
    const rb = await b.feed();
    if (second === "resume") {
      assert.equal(rb.status, 0, rb.stderr);
      assert.notEqual(f.readEnvelope().capabilityId, oldC);
      assert.equal(f.consume().acquired, true);
    } else {
      assert.equal(rb.status, 1, "T3 saw T2 pending: no proven predecessor");
      assert.match(rb.stderr, /no proven ready predecessor/);
    }
    fs.writeFileSync(f.envFile, old);
    assert.equal(f.classify(), "definitive");
  });
}

test("D: arch mismatch refuses consumers and a compact; the same session on arm64 is unaffected", options, (t) => {
  const f = prepared(t);
  assert.equal(f.consume({ ADMISSION_FIXTURE_ARCH: "x64" }).acquired, false);
  assert.equal(f.classify({ ADMISSION_FIXTURE_ARCH: "x64" }), "definitive");
  assert.equal(f.activate("Stop", { ADMISSION_FIXTURE_ARCH: "x64" }).acquired, false);
  assert.equal(f.consume().acquired, true);
  const r = f.runHook({}, JSON.stringify(f.hookInput({ source: "compact" })), { omit: true });
  assert.equal(r.status, 0, "arm64 compact proves its arm64 predecessor");
});

test("D: compact under a mismatched arch cannot prove its predecessor", options, (t) => {
  const f = prepared(t), old = fs.readFileSync(f.envFile, "utf8");
  f.env.ADMISSION_FIXTURE_ARCH = "x64";
  const r = f.runHook({}, JSON.stringify(f.hookInput({ source: "compact" })));
  delete f.env.ADMISSION_FIXTURE_ARCH;
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /no longer pending|unproven|predecessor|refused/);
  fs.writeFileSync(f.envFile, old);
  assert.equal(f.consume().acquired, false);
});

for (const variant of ["missing", "corrupt", "duplicate", "range", "other adapter", "other platform"]) {
  test(`D: provider manifest ${variant} refuses every receipt`, options, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-variant-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.cpSync(path.join(defaultRepo, "plugins"), path.join(root, "plugins"), { recursive: true });
    const file = path.join(root, "plugins/codex/scripts/lib/provider-receipts.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (variant === "missing") fs.unlinkSync(file);
    else if (variant === "corrupt") fs.writeFileSync(file, "{");
    else {
      if (variant === "duplicate") data.entries.push({ ...data.entries[0], binarySha256: "0".repeat(64) });
      if (variant === "range") data.entries[0].version = "2.1.x";
      if (variant === "other adapter") data.entries[0].receiptAdapter = "something-else";
      if (variant === "other platform") data.entries[0].platform = "linux";
      fs.writeFileSync(file, JSON.stringify(data));
    }
    const f = fixture(t, root);
    assert.equal(f.runHook().status, 0, "SessionStart itself needs no receipt");
    assert.equal(f.consume().acquired, false);
    assert.equal(f.activate("Stop").acquired, false);
  });
}

test("D: the manifest names fixtures and evidence whose hashes match", options, () => {
  const data = JSON.parse(fs.readFileSync(path.join(defaultRepo, "plugins/codex/scripts/lib/provider-receipts.json"), "utf8"));
  for (const e of data.entries) {
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(defaultRepo, e.fixtures))).digest("hex"), e.fixturesSha256);
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(defaultRepo, e.evidenceSummary))).digest("hex"), e.evidenceSummarySha256);
  }
});

// The queued job the consume helper seeds, as a worker would receive it.
function seedJob(f) {
  const seeded = f.consume({}, "seed-job");
  assert.equal(seeded.acquired, true);
  const jobs = path.join(path.dirname(seeded.fence), "jobs");
  return { id: "fixture-queued", sessionId: "session-current", status: "queued", phase: "queued", pid: null, jobClass: "task", title: "fixture worker",
    workspaceRoot: f.workspace, logFile: path.join(jobs, "fixture-queued.log"), file: path.join(jobs, "fixture-queued.json"), stateFile: path.join(path.dirname(jobs), "state.json") };
}

async function workerOverCompact(t, { waitMs, longPendingMs, finishWith = "compact" }) {
  const f = prepared(t), job = seedJob(f), hold = path.join(f.root, "runner-may-finish");
  fs.writeFileSync(job.logFile, "");
  const worker = f.startWorker(job, { waitMs, holdFile: hold });
  await until(() => JSON.parse(fs.readFileSync(job.file, "utf8")).status === "running");
  const hook = await f.startHook(f.hookInput({ source: finishWith }));
  fs.writeFileSync(hold, "");
  await sleep(longPendingMs);
  const fed = Date.now();
  const r = await hook.feed();
  assert.equal(r.status, 0, r.stderr);
  const out = await worker;
  return { f, job, out: JSON.parse(out.stdout.trim().split("\n").at(-1) || "{}"), raw: out, afterFeedMs: Date.now() - fed };
}

test("D: auto compact while a worker publishes: the worker waits and keeps its result", options, async (t) => {
  // Longer than the 10 s ordinary lock deadline: only the final publication's wait covers it.
  const { f, job, out, raw } = await workerOverCompact(t, { waitMs: 60_000, longPendingMs: 11_000 });
  assert.equal(out.published, true, raw.stdout + raw.stderr);
  const stored = JSON.parse(fs.readFileSync(job.file, "utf8"));
  assert.equal(stored.status, "completed");
  assert.equal(stored.rendered, "worker result survives compact");
  assert.equal(JSON.parse(fs.readFileSync(job.stateFile, "utf8")).jobs.find((j) => j.id === job.id).status, "completed");
  assert.match(fs.readFileSync(job.logFile, "utf8"), /Final output\nworker result survives compact/);
});

test("D: without the final-publication wait the same compact refuses the result, which the log keeps", options, async (t) => {
  const { f, job, out, raw } = await workerOverCompact(t, { waitMs: 0, longPendingMs: 11_000 });
  assert.equal(out.published, false, raw.stdout + raw.stderr);
  assert.equal(out.error.code, "ESTATELOCKTIMEOUT");
  const stored = JSON.parse(fs.readFileSync(job.file, "utf8"));
  assert.equal(stored.status, "failed", "the exit reporter's ordinary attempt lands once the compact is ready");
  assert.match(stored.errorMessage, /before reporting a terminal result/);
  assert.equal(stored.rendered, undefined, "the result itself was not published");
  const log = fs.readFileSync(job.logFile, "utf8");
  assert.match(log, /Final output\nworker result survives compact/);
  assert.match(log, /was not published to the job record/);
});

test("D: a worker waiting over a resume stops at once when its C is replaced", options, async (t) => {
  const { f, job, out, raw, afterFeedMs } = await workerOverCompact(t, { waitMs: 120_000, longPendingMs: 300, finishWith: "resume" });
  assert.equal(out.published, false, raw.stdout + raw.stderr);
  assert.equal(out.error.code, "ESTATELOCKREFUSED");
  assert.ok(afterFeedMs < 5_000, `stopped ${afterFeedMs} ms after the resume, not at the bound or the ordinary deadline`);
  assert.equal(JSON.parse(fs.readFileSync(job.file, "utf8")).status, "running");
  assert.match(fs.readFileSync(job.logFile, "utf8"), /worker result survives compact/);
});

// Clear: the old SID ends (SessionEnd), a new SID starts. A replay child of
// the harness carries exactly the captured environment, no sourcing.
test("D: clear replay — the old capture works before clear and is refused after it, state unchanged", options, (t) => {
  const f = prepared(t), oldCapture = envMap(fs.readFileSync(f.envFile, "utf8"));
  const replay = (vars, write = false) => {
    const env = { ...f.env, ...vars };
    const code = `const m=await import(${JSON.stringify(pathToFileURL(path.join(f.repo, "plugins/codex/scripts/lib/state.mjs")).href)});const cwd=process.argv[1];let acquired=false,error=null;
      try{const l=m.openStateLock(cwd);const h=l.tryAcquire();acquired=!!h;if(h)l.release(h);if(${write})m.updateState(cwd,s=>{s.config.replayed=true;});}catch(e){error=e.code;}console.log(JSON.stringify({acquired,error}));`;
    const r = spawnSync(process.execPath, ["--import", path.join(f.root, "fixture.mjs"), "--input-type=module", "-e", code, f.workspace], { cwd: f.workspace, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.equal(replay(oldCapture).acquired, true, "positive control before clear");
  assert.equal(f.runFixed("SessionEnd").status, 0);
  const stateFile = path.join(path.dirname(f.consume().fence), "state.json");
  const stateBefore = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
  const replayed = replay(oldCapture, true);
  assert.equal(replayed.acquired, false);
  assert.equal(replayed.error, "ESTATELOCKREFUSED");
  assert.equal(fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null, stateBefore, "refused replay changed nothing");
  // New SID after clear, with its own transcript.
  const transcript2 = path.join(f.root, "transcript-next.jsonl");
  fs.writeFileSync(transcript2, "");
  f.env.CLAUDE_CODE_SESSION_ID = "session-next";
  const r = f.runHook({}, JSON.stringify(f.hookInput({ source: "clear", session_id: "session-next", transcript_path: transcript2 })), { sessionId: "session-next", transcriptFile: transcript2 });
  assert.equal(r.status, 0, r.stderr);
  const newCapture = envMap(fs.readFileSync(f.envFile, "utf8"));
  assert.equal(newCapture.CODEX_COMPANION_SESSION_ID, "session-next");
  assert.equal(replay(oldCapture).acquired, false, "old SID with old ENV");
  assert.equal(replay({ ...oldCapture, CODEX_COMPANION_LOCK_ADMISSION: newCapture.CODEX_COMPANION_LOCK_ADMISSION }).acquired, false, "old SID worker with the new envelope");
  assert.equal(replay({ ...newCapture, CLAUDE_CODE_SESSION_ID: "session-current" }).acquired, false, "new ENV under the old native SID");
  assert.equal(replay(newCapture).acquired, true, "new SID with its own proven start");
  assert.equal(fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null, stateBefore);
});

test("D: journey startup → manual compact → auto compact with worker → resume → clear", options, async (t) => {
  const f = prepared(t), startup = fs.readFileSync(f.envFile, "utf8"), c1 = f.readEnvelope().capabilityId;
  assert.equal(f.runHook({}, JSON.stringify(f.hookInput({ source: "compact" }))).status, 0);
  assert.equal(f.readEnvelope().capabilityId, c1, "manual compact keeps C");
  const job = seedJob(f), hold = path.join(f.root, "hold");
  fs.writeFileSync(job.logFile, "");
  const worker = f.startWorker(job, { holdFile: hold });
  await until(() => JSON.parse(fs.readFileSync(job.file, "utf8")).status === "running");
  const auto = await f.startHook(f.hookInput({ source: "compact" }));
  fs.writeFileSync(hold, "");
  await sleep(500);
  assert.equal((await auto.feed()).status, 0);
  assert.equal(JSON.parse((await worker).stdout.trim()).published, true);
  assert.equal(f.readEnvelope().capabilityId, c1, "auto compact keeps C");
  fs.writeFileSync(f.envFile, startup);
  assert.equal(f.consume().acquired, true, "the startup envelope survived two compacts");
  assert.equal(f.runHook({}, JSON.stringify(f.hookInput({ source: "resume" }))).status, 0);
  const c2 = f.readEnvelope().capabilityId;
  assert.notEqual(c2, c1);
  assert.equal(f.consume().acquired, true);
  const resumed = fs.readFileSync(f.envFile, "utf8");
  fs.writeFileSync(f.envFile, startup);
  assert.equal(f.consume().acquired, false, "resume replaced C");
  fs.writeFileSync(f.envFile, resumed);
  assert.equal(f.runFixed("SessionEnd").status, 0);
  assert.equal(f.consume().acquired, false, "clear's SessionEnd revoked C2");
});

for (const gate of [false, true]) {
  test(`Stop without a receipt: gate=${gate} preserves state and only the enabled gate refuses`, options, t => {
    const f = prepared(t);
    assert.equal(f.consume({}, "seed-job").acquired, true);
    const stateFile = path.join(path.dirname(f.fence), "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.config.stopReviewGate = gate;
    state.jobs[0].status = "running"; // listJobs would reconcile this stale job.
    fs.writeFileSync(stateFile, JSON.stringify(state));
    fs.writeFileSync(f.transcript, "");
    const before = fs.readFileSync(stateFile);
    const result = f.runFixed("Stop", { fast: true });
    assert.equal(result.status, gate ? 1 : 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, gate ? /no proven current SessionStart receipt/ : /fixture-queued is still running/);
    assert.deepEqual(fs.readFileSync(stateFile), before);
    assert.equal(fs.readdirSync(path.join(path.dirname(f.fence), "jobs")).length, 1);
  });
}

test("Stop with the default disabled gate needs no SessionStart or transcript", options, t => {
  const f = fixture(t);
  fs.unlinkSync(f.transcript);
  const result = f.runFixed("Stop");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(f.env.CLAUDE_PLUGIN_DATA), false, "readonly Stop must not create state or authority");
});

test("fixed hook reports missing transcript as unproven receipt, not raw ENOENT", options, t => {
  const f = prepared(t);
  fs.unlinkSync(f.transcript);
  const result = f.activate("Stop");
  assert.equal(result.acquired, false);
  assert.match(result.error, /no proven current SessionStart receipt/);
});
