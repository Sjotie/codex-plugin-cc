// Regression tests from the cross-family H-review of #1916 (GPT-6.1 Sol high,
// round 1, NO-GO on 4ad0c73): the reviewer's own probes, kept as written
// (sha256 2cf00516… in homebase docs/design/1916-build/sol-r1/), with only the
// plugin root taken from this checkout instead of REVIEW_PLUGIN. Red on
// 4ad0c73, green after the fix.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
const root = process.env.REVIEW_PLUGIN ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(root, 'plugins/codex/scripts/lib');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'1916-independent-'));
const scope = path.join(tmp,'scope');
fs.writeFileSync(scope,'');
process.env.FENCED_LOCK_SCAN_SCOPE=scope;
await import(pathToFileURL(path.join(root,'tests/fenced-lock/scan-scope.mjs')));
const state = await import(pathToFileURL(path.join(lib,'state.mjs')));
const {openFencedLock} = await import(pathToFileURL(path.join(lib,'fenced-lock.mjs')));
test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('independent: unrelated commit must not hide a crashed restore JSON',()=>{
  process.env.CLAUDE_PLUGIN_DATA=path.join(tmp,'data');
  const cwd=path.join(tmp,'workspace'); fs.mkdirSync(cwd);
  state.ensureStateDir(cwd);
  const j={id:'j',status:'cancelled',phase:'cancelled',pid:process.pid};
  const index=state.resolveStateFile(cwd), json=state.resolveJobFile(cwd,'j');
  fs.writeFileSync(index,JSON.stringify({version:1,config:{},jobs:[j]}));
  fs.writeFileSync(json,JSON.stringify({...j,status:'running',phase:'running'}));
  // These times are the real JSON-before-index crash ordering, made deterministic.
  const past=(Date.now()-10_000)/1000;
  fs.utimesSync(index,past-1,past-1); fs.utimesSync(json,past,past);
  state.upsertJob(cwd,{id:'b',status:'completed',phase:'completed'});
  const actual=state.listJobs(cwd).find(x=>x.id==='j');
  console.log('mtime evidence',JSON.stringify({actual:actual.status,json:JSON.parse(fs.readFileSync(json)).status,jsonMtime:fs.statSync(json).mtimeMs,indexMtime:fs.statSync(index).mtimeMs}));
  assert.equal(actual.status,'running');
});

test('independent: a process acquiring marker after target selection must get no signal',()=>{
  const dir=path.join(tmp,'late-marker'); fs.mkdirSync(dir);
  const fence=path.join(dir,'state.lock'); fs.mkdirSync(fence);
  const target={pid:4242,start:'100',script:'codex-companion.mjs',sub:'task-worker',comm:'node'};
  fs.writeFileSync(path.join(fence,'fence.json'),JSON.stringify({version:1,verdict:'initial',residues:[],S0:[target],sealedAt:null}));
  let reads=0, marker=false; const signals=[];
  // Not in the original probe: the domain and platform are pinned, so the
  // namespace gate of v2.11 cannot make this test green on a non-initial host.
  const lock=openFencedLock(fence,{
    domain:()=>({verdict:'initial',reason:'test',scope:'test'}),
    platform:'linux',
    identityReader:()=>{ reads++; if(reads>=2) marker=true; return {start:'100',state:'S',argv:['node','/p/scripts/codex-companion.mjs','task-worker'],comm:'node'};},
    markerReader:()=>marker,
    kill:(pid,sig)=>{signals.push({pid,sig,marker});throw Object.assign(new Error('spy'),{code:'EPERM'});}
  });
  const result=lock.stopOld({graceMs:0});
  console.log('marker evidence',JSON.stringify({signals,result}));
  assert.deepEqual(signals,[]);
});

test('independent: inherited procfs pid differs from signal namespace pid',(t)=>{
  if (process.platform !== 'linux' || spawnSync('unshare',['-r','-p','-f','true']).status !== 0) { t.skip('unshare -r -p -f not available'); return; }
  const script=`
    import fs from 'node:fs';
    import path from 'node:path';
    import {spawn} from 'node:child_process';
    const {openFencedLock}=await import(process.argv[1]);
    const child=spawn(process.execPath,['-e',"const fs=require('fs');console.log(JSON.stringify({pid:process.pid,procPid:Number(fs.readlinkSync('/proc/self'))}));setInterval(()=>{},1000);",'/p/scripts/codex-companion.mjs','task-worker'],{stdio:['ignore','pipe','pipe']});
    const exit=new Promise(r=>child.once('exit',r));
    const info=await new Promise(r=>child.stdout.once('data',d=>r(JSON.parse(d))));
    const dir=process.argv[2];fs.mkdirSync(dir);
    const F=path.join(dir,'state.lock');
    const signals=[];
    const lock=openFencedLock(F,{
      argvMatch:argv=>argv.includes('/p/scripts/codex-companion.mjs')?{script:'codex-companion.mjs',sub:'task-worker'}:null,
      kill:(pid,sig)=>{signals.push({pid,sig});throw Object.assign(new Error('spy'),{code:'EPERM'});}
    });
    lock.tryAcquire(); // actual publication + /proc scan record, no synthetic S0
    const record=lock.status().record;
    const result=lock.stopOld({graceMs:0});
    console.log(JSON.stringify({nativePid:process.pid,targetNativePid:child.pid,targetInfo:info,record,signals,result}));
    child.kill('SIGKILL'); await exit;
  `;
  const r=spawnSync('unshare',['-r','-p','-f',process.execPath,'--input-type=module','-e',script,pathToFileURL(path.join(lib,'fenced-lock.mjs')).href,path.join(tmp,'ns')],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const data=JSON.parse(r.stdout);console.log('namespace evidence',JSON.stringify(data));
  assert.equal(data.nativePid,1);
  assert.equal(data.targetNativePid,data.targetInfo.pid);
  assert.notEqual(data.targetNativePid,data.targetInfo.procPid);
  assert.ok(data.record.S0.some(p=>p.pid===data.targetInfo.procPid));
  assert.equal(data.signals.length,0,'must refuse or translate a procfs PID that belongs to an ancestor namespace');
});
