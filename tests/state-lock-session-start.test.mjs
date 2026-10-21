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

const repo = process.env.FENCED_LOCK_SESSION_PRODUCT_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
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
  const transcript = path.join(root, "transcript.jsonl");
  fs.writeFileSync(transcript, "");
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, "{}");
  const preload = path.join(root, "fixture.mjs");
  fs.writeFileSync(preload, `
    import fs from 'node:fs'; import cp from 'node:child_process'; import net from 'node:net'; import {syncBuiltinESMExports} from 'node:module';
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
    const append=fs.appendFileSync;
    fs.appendFileSync=function(file,data,...rest){const r=append.call(this,file,data,...rest);
      if(JSON.parse(fs.readFileSync(process.env.ADMISSION_FIXTURE,'utf8')).crashExport && String(data).startsWith("export CODEX_COMPANION_LOCK_ADMISSION='{\"))process.kill(process.pid,'SIGKILL');
      return r;};
    const stdout=process.stdout.write.bind(process.stdout);
    process.stdout.write=function(data,...rest){const r=stdout(data,...rest);
      if(JSON.parse(fs.readFileSync(process.env.ADMISSION_FIXTURE,'utf8')).crashStdout && String(data).includes('codexStateLockAdmission'))process.kill(process.pid,'SIGKILL');
      return r;};
    const read=fs.readFileSync;let receiptReads=0;
    fs.readFileSync=function(file,...rest){const c=JSON.parse(read.call(this,process.env.ADMISSION_FIXTURE,'utf8'));
      if(c.denyAfterReceipt && String(file)===c.transcript && ++receiptReads>2)throw Object.assign(new Error('receipt became unreadable'),{code:'EPERM'});
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
  const receipt = (result, extra = {}) => ({type:"attachment",version:"2.1.301",sessionId:"session-current",cwd:workspace,isSidechain:false,
    attachment:{type:"hook_success",hookEvent:"SessionStart",hookName:`SessionStart:${extra.source ?? "startup"}`,exitCode:result.status ?? 1,
      command:'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs" SessionStart',stdout:result.stdout,...extra.attachment},...extra.record});
  const appendReceipt = (result, extra = {}) => fs.appendFileSync(transcript, JSON.stringify(receipt(result, extra))+"\n");
  const runHook = (spec = {}, input = JSON.stringify(hookInput()), receiptOptions = {}) => {
    fs.writeFileSync(config, JSON.stringify(spec));
    const result = spawnSync(process.execPath, ["--import", preload, hook, "SessionStart"], {
      cwd: workspace, env, encoding: "utf8", input
    });
    let source = "startup"; try {source=JSON.parse(input).source;} catch {}
    if (!receiptOptions.omit) appendReceipt(result, {source, ...receiptOptions});
    return result;
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
    return spawnSync(process.execPath,["--import",preload,hook,event],{cwd:workspace,env:{...env,...(spec.brokerWitness?{CODEX_COMPANION_APP_SERVER_ENDPOINT:`unix:${path.join(root,'broker.sock')}`}:{})},input:JSON.stringify(hookInput({hook_event_name:event})),encoding:"utf8"});
  };
  const complete = (mode) => {
    fs.writeFileSync(config,JSON.stringify({consumer:true}));
    const code=`process.argv[1]=${JSON.stringify(hook)};process.argv[2]='SessionEnd';const m=await import(${JSON.stringify(state)});let completed=false,error=null;
      try{const a=${mode==="forged"?`JSON.parse(process.env.${CERT})`:`m.activateFixedHookAdmission(${JSON.stringify(hookInput())},'SessionEnd')`};
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
  return { root, workspace, envFile, transcript, runHook, consume, activate, complete, pausedEnd, runFixed, hookInput, receipt, appendReceipt, env };
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
  assert.equal(f.consume().acquired,true,"the newer generation must survive stale End completion");
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

test("transport: env-file failure already revokes the old generation before parent receipt",options,t=>{
  const f=prepared(t);f.env.CLAUDE_ENV_FILE=f.root;
  const r=f.runHook({},undefined,{omit:true});assert.equal(r.status,1);
  assert.equal(f.consume().acquired,false,"old certificate must be pending even before the provider records this failure");
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

for(const source of ["startup","resume","compact","clear"]){
  test(`transport: ${source} SessionStart revokes the previous Bash generation`,options,t=>{
    const f=prepared(t),old=fs.readFileSync(f.envFile,"utf8");
    const result=f.runHook({},JSON.stringify(f.hookInput({source})));
    assert.equal(result.status,0,result.stderr);
    assert.equal(f.consume().acquired,true);
    fs.writeFileSync(f.envFile,old);
    assert.equal(f.consume().acquired,false,"old exported certificate must stay revoked");
    assert.equal(f.activate("Stop").acquired,true,"fixed hooks recover only current generation");
  });
}

for(const fault of ["no receipt","nonzero success receipt","string zero","wrong version","wrong command","wrong session","wrong cwd","sidechain","wrong source","old token","partial receipt","malformed receipt","latest failure"]){
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
    if(fault==="old token"){const value=JSON.parse(data.attachment.stdout||"{}");value.codexStateLockAdmission={...value.codexStateLockAdmission,generation:"0".repeat(64)};data.attachment.stdout=JSON.stringify(value);}
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

test("transport: changed root on a new SessionStart cannot preserve the old generation",options,t=>{
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
