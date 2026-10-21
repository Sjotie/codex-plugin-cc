// Run through the machine test slot. Product snapshots never replace a checkout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const repo=fileURLToPath(new URL("../../",import.meta.url));
const root=fs.mkdtempSync(path.join(os.tmpdir(),"session-transport-controls-"));
const baseline="129692effddb0f6a780817cdfd56a3b296851211";
const git=(args)=>{const r=spawnSync("git",args,{cwd:repo,encoding:"utf8"});if(r.status!==0)throw Error(r.stderr);return r.stdout;};
const snapshot=path.join(root,"pre-transport");
for(const file of git(["ls-tree","-r","--name-only",baseline,"--","plugins/codex"]).trim().split("\n")){
  const dest=path.join(snapshot,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,git(["show",`${baseline}:${file}`]));
}
const r=spawnSync(process.execPath,["--test",path.join(repo,"tests/state-lock-session-start.test.mjs")],{cwd:repo,env:{...process.env,FENCED_LOCK_SESSION_PRODUCT_ROOT:snapshot},encoding:"utf8",timeout:120000});
fs.writeFileSync(path.join(root,"pre-transport.log"),r.stdout+r.stderr);
const summary=r=>(r.stdout+r.stderr).split("\n").filter(s=>/ℹ (tests|pass|fail|skipped)/.test(s));
const results=[{name:"pre-transport",status:r.status,summary:summary(r),causal:r.status===1&&r.stdout.includes("✔ route2: hook seal is consumed")&&summary(r).some(s=>/fail [1-9]/.test(s))}];
const transport="plugins/codex/scripts/lib/session-admission.mjs";
const state="plugins/codex/scripts/lib/state.mjs";
const lifecycle="plugins/codex/scripts/session-lifecycle-hook.mjs";
const cases=[
  ["receipt-check-removed",transport,"no receipt|nonzero success",'    readSessionReceipt(locator, ctx.generation, source);',''],
  ["numeric-exit-code-removed",transport,"nonzero success|string zero",'a.exitCode !== 0 || ',''],
  ["version-check-removed",transport,"wrong version",'latest.version !== "2.1.301" || ',''],
  ["own-command-relevance-removed",transport,"missing hook identity",'a?.command === SESSION_START_COMMAND || ',''],
  ["outer-record-type-removed",transport,"wrong record type",'latest?.type !== "attachment" || ',''],
  ["command-check-removed",transport,"wrong command",['      if (typeof a.command === "string" && a.command.trim() !== "" && a.command !== SESSION_START_COMMAND) continue;',' || a.command !== SESSION_START_COMMAND'],['','']],
  ["receipt-session-check-removed",transport,"wrong session cannot",'latest.sessionId !== locator.sessionId || ',''],
  ["receipt-cwd-check-removed",transport,"wrong cwd",'!path.isAbsolute(latest.cwd ?? "") || fs.realpathSync(latest.cwd) !== locator.cwd ||',''],
  ["sidechain-check-removed",transport,"sidechain",'latest.isSidechain !== false ||',''],
  ["source-check-removed",transport,"wrong source",'a.hookName !== `SessionStart:${token.source}` || ',''],
  ["nonce-check-removed",transport,"old token",'token.generation !== generation ||',''],
  ["latest-failure-ignored",transport,"latest failure|unknown command cannot",'      latest = r;', '      if(a.exitCode === 0) latest = r;'],
  ["known-other-hooks-shadow",transport,"cannot shadow",'      if (typeof a.command === "string" && a.command.trim() !== "" && a.command !== SESSION_START_COMMAND) continue;',''],
  ["unknown-command-ignored",transport,"unknown command cannot",'typeof a.command === "string" && a.command.trim() !== "" && a.command !== SESSION_START_COMMAND','a.command !== SESSION_START_COMMAND'],
  ["locator-file-identity-removed",transport,"replaced copy locator",'value.locatorId !== identity(st) || ',''],
  ["fixed-event-check-removed",state,"arbitrary hook",'  if (!["Stop", "SessionEnd"].includes(event)) throw new StateLockUnavailable("Only fixed Stop and SessionEnd hooks may activate admission");',''],
  ["fixed-entrypoint-check-removed",state,"event name alone",'  if (!process.argv[1] || fs.realpathSync(process.argv[1]) !== fs.realpathSync(entry) ||\n    (event === "SessionEnd" && process.argv[2] !== "SessionEnd")) throw new StateLockUnavailable("Admission activation requires its fixed hook entrypoint");',''],
  ["preparse-revocation-removed",lifecycle,"malformed input revokes|env-file failure",'    started = beginSessionStateLockStart();',''],
  ["early-env-write-restored",lifecycle,"env-file failure",'    started = beginSessionStateLockStart();\n    clearSessionAdmission();','    clearSessionAdmission();\n    started = beginSessionStateLockStart();'],
  ["teardown-error-swallowed",lifecycle,"aborts teardown",'      throw error;','      continue;'],
  ["context-exclusion-removed",transport,"official additional-context metadata after success",'if (a?.command !== SESSION_START_COMMAND && r?.type === "attachment"','if (false && a?.command !== SESSION_START_COMMAND && r?.type === "attachment"'],
  ["context-shape-unchecked",transport,"unproven string additional-context",'Array.isArray(a.content) && a.content.length === 1 && typeof a.content[0] === "string" && ',''],
  ["end-activation-object-unchecked",state,"forged End completion",'!activeFixedEndAdmissions.has(envelope) || ',''],
  ["end-completion-path-unchecked",state,"wrong path End completion",'if (!process.argv[1] || fs.realpathSync(process.argv[1]) !== fs.realpathSync(entry) || process.argv[2] !== "SessionEnd" ||\n    !envelope','if (!envelope'],
  ["stale-end-adopts-latest",state,"older End completion",'export function completeFixedSessionEndAdmission(envelope) {','export function completeFixedSessionEndAdmission(envelope) {\n  envelope = activateFixedHookAdmission({session_id:envelope.sessionId,cwd:readSessionLocator(envelope.sessionId).cwd,transcript_path:envelope.transcriptPath},"SessionEnd");']
];
for(const [name,file,pattern,from,to]of cases){
  const dir=path.join(root,name);fs.mkdirSync(dir);fs.cpSync(path.join(repo,"plugins"),path.join(dir,"plugins"),{recursive:true});
  const target=path.join(dir,file);let source=fs.readFileSync(target,"utf8");
  const edits=Array.isArray(from)?from.map((f,i)=>[f,to[i]]):[[from,to]];
  for(const [f,t]of edits){if(!source.includes(f))throw Error(`Mutation target missing: ${name}`);source=source.replace(f,t);}
  fs.writeFileSync(target,source);
  const m=spawnSync(process.execPath,["--test",`--test-name-pattern=${pattern}`,path.join(repo,"tests/state-lock-session-start.test.mjs")],{cwd:repo,env:{...process.env,FENCED_LOCK_SESSION_PRODUCT_ROOT:dir},encoding:"utf8",timeout:30000});
  fs.writeFileSync(path.join(root,`${name}.log`),m.stdout+m.stderr);
  results.push({name,status:m.status,summary:summary(m),causal:m.status===1&&!/SyntaxError|Mutation target/.test(m.stderr+m.stdout)&&summary(m).some(s=>/fail [1-9]/.test(s))});
}
const result={root,baseline,results};
fs.writeFileSync(path.join(root,"summary.json"),JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify(result,null,2));
if(results.some(r=>!r.causal))process.exitCode=1;
