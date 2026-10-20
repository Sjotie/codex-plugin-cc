import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const url=pathToFileURL(path.join(process.env.REVIEW_PLUGIN,'plugins/codex/scripts/lib/fenced-lock.mjs')).href;
const {openFencedLock}=await import(url);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'1916-r3-mount-'));
const F=path.join(root,'state.lock');
const old=spawn(process.execPath,['-e','console.log("ready");setInterval(()=>{},1000)','/review-only/scripts/codex-companion.mjs','task-worker'],{stdio:['ignore','pipe','pipe']});
const exited=new Promise(r=>old.once('exit',r));
try{
 await new Promise(r=>old.stdout.once('data',r));
 const l=openFencedLock(F,{argvMatch:a=>a.includes('/review-only/scripts/codex-companion.mjs')?{script:'codex-companion.mjs',sub:'task-worker'}:null});
 if(l.tryAcquire())throw Error('host precondition admitted');
 if(!l.status().record.S0.some(p=>p.pid===old.pid))throw Error('missing old pid');
 const code=`
 const fs=await import('node:fs');const {spawnSync}=await import('node:child_process');
 const {openFencedLock,domainVerdict}=await import(process.argv[1]);
 const l=openFencedLock(process.argv[2]);const before=l.status();
 const beforeDev=String(fs.statSync('/proc').dev);
 const m=spawnSync('mount',['-t','proc','proc','/proc'],{encoding:'utf8'});
 if(m.status!==0)throw Error('mount failed: '+m.stderr);
 const afterDev=String(fs.statSync('/proc').dev);
 const h=l.tryAcquire();const after=l.status();
 console.log(JSON.stringify({beforeDev,afterDev,before:before.waitingOn,domain:domainVerdict(),acquired:!!h,after:after.record}));
 if(h)l.release(h);
 `;
 const run=spawnSync('unshare',['-r','-p','-f','-m',process.execPath,'--input-type=module','-e',code,url,F],{encoding:'utf8'});
 if(run.status!==0)throw Error(run.stderr);
 const result=JSON.parse(run.stdout);
 const stat=fs.readFileSync('/proc/'+old.pid+'/stat','utf8');
 const alive=stat.slice(stat.lastIndexOf(')')+2)[0]!=='Z';
 console.log(JSON.stringify({oldPid:old.pid,alive,result},null,2));
 process.exitCode=result.acquired&&alive?1:0;
}finally{old.kill('SIGKILL');await exited;fs.rmSync(root,{recursive:true,force:true});}
