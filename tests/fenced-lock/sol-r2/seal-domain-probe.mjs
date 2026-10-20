import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
const url=pathToFileURL(path.join(process.env.REVIEW_PLUGIN,'plugins/codex/scripts/lib/fenced-lock.mjs')).href;
const {openFencedLock,domainVerdict}=await import(url);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'1916-r2-seal-domain-'));const F=path.join(root,'state.lock');
const old=spawn(process.execPath,['-e','console.log("ready");setInterval(()=>{},1000)','/p/scripts/codex-companion.mjs','task-worker'],{stdio:['ignore','pipe','pipe']});const exited=new Promise(r=>old.once('exit',r));
try {
 await new Promise(r=>old.stdout.once('data',r));
 const lock=openFencedLock(F,{argvMatch:argv=>argv.includes('/p/scripts/codex-companion.mjs')?{script:'codex-companion.mjs',sub:'task-worker'}:null});
 const before=lock.tryAcquire();if(before)throw Error('precondition: host admitted');
 const record=lock.status().record;if(!record.S0.some(p=>p.pid===old.pid))throw Error('precondition: old pid not scanned');
 const child=`const fs=await import('node:fs');const {openFencedLock,domainVerdict}=await import(process.argv[1]);const l=openFencedLock(process.argv[2]);const before=l.status();const h=l.tryAcquire();console.log(JSON.stringify({pid:process.pid,domain:domainVerdict(),before:before.record,acquired:!!h,after:l.status().record}));if(h)l.release(h);`;
 const run=spawnSync('unshare',['-r','-p','-f','--mount-proc',process.execPath,'--input-type=module','-e',child,url,F],{encoding:'utf8'});
 if(run.status!==0)throw Error(run.stderr);const result=JSON.parse(run.stdout);
 const stat=fs.readFileSync(`/proc/${old.pid}/stat`,'utf8');const alive=stat.slice(stat.lastIndexOf(')')+2)[0]!=='Z';
 console.log(JSON.stringify({hostDomain:domainVerdict(),oldHostPid:old.pid,oldStillAlive:alive,result},null,2));
 process.exitCode=result.acquired&&alive?1:0;
}finally {old.kill('SIGKILL');await exited;fs.rmSync(root,{recursive:true,force:true});}
