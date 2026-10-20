// Regression tests from round 2 of the cross-family H-review of #1916 (GPT-6.1
// Sol high, NO-GO on b182fdb): a seal record is judged only from the procfs
// that recorded it (design v2.12). The reviewer's probe runs unchanged
// (tests/fenced-lock/sol-r2/seal-domain-probe.mjs, sha256 in the review
// package); the other two cover the inherited procfs and the reverse route.
// Red on b182fdb, green after the fix. Linux with unprivileged user and PID
// namespaces only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = pathToFileURL(path.join(ROOT, "plugins/codex/scripts/lib/fenced-lock.mjs")).href;
const PROBE = path.join(ROOT, "tests/fenced-lock/sol-r2/seal-domain-probe.mjs");
const unshareWorks = (flags) => process.platform === "linux" && spawnSync("unshare", [...flags, "true"]).status === 0;
const argvMatch = "(argv) => argv.includes('/p/scripts/codex-companion.mjs') ? { script: 'codex-companion.mjs', sub: 'task-worker' } : null";
const argvMatchFn = (argv) => (argv.includes("/p/scripts/codex-companion.mjs") ? { script: "codex-companion.mjs", sub: "task-worker" } : null);

function oldChild(t) {
  const child = spawn(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000)', "/p/scripts/codex-companion.mjs", "task-worker"], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise((r) => child.once("exit", r));
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  return { child, ready: new Promise((r) => child.stdout.once("data", r)) };
}

function aliveOnHost(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

function tmpFence(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "1916-sol-r2-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "state.lock");
}

test("Sol r2 probe: a nested own-procfs reader never seals a host record whose old process lives", (t) => {
  if (!unshareWorks(["-r", "-p", "-f", "--mount-proc"])) {
    t.skip("unshare -r -p -f --mount-proc not available");
    return;
  }
  const run = spawnSync(process.execPath, [PROBE], { encoding: "utf8", env: { ...process.env, REVIEW_PLUGIN: ROOT } });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const out = JSON.parse(run.stdout);
  assert.equal(out.oldStillAlive, true);
  assert.equal(out.result.acquired, false, JSON.stringify(out.result));
  assert.equal(out.result.after.sealedAt, null);
});

test("inherited procfs: a nested reader that shares the host procfs judges the host record and does not seal while the old process lives", async (t) => {
  if (!unshareWorks(["-r", "-p", "-f"])) {
    t.skip("unshare -r -p -f not available");
    return;
  }
  const { child, ready } = oldChild(t);
  await ready;
  const { openFencedLock } = await import(MODULE);
  const F = tmpFence(t);
  const lock = openFencedLock(F, { argvMatch: argvMatchFn });
  assert.equal(lock.tryAcquire(), null, "precondition: the host waits");
  assert.ok(lock.status().record.S0.some((p) => p.pid === child.pid), "precondition: the old process is in S0");
  const script = `const {openFencedLock,domainVerdict}=await import(process.argv[1]);const l=openFencedLock(process.argv[2]);const h=l.tryAcquire();console.log(JSON.stringify({domain:domainVerdict().verdict,acquired:!!h,record:l.status().record}));if(h)l.release(h);`;
  const run = spawnSync("unshare", ["-r", "-p", "-f", process.execPath, "--input-type=module", "-e", script, MODULE, F], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.domain, "nested");
  assert.equal(aliveOnHost(child.pid), true);
  assert.equal(out.acquired, false, JSON.stringify(out));
  assert.equal(out.record.sealedAt, null);
});

test("reverse route: a record made in a nested own procfs (with a declaration) is scanned again by the host, which then waits for its own old process", async (t) => {
  if (!unshareWorks(["-r", "-p", "-f", "--mount-proc"])) {
    t.skip("unshare -r -p -f --mount-proc not available");
    return;
  }
  const { child, ready } = oldChild(t);
  await ready;
  const F = tmpFence(t);
  // In the nested namespace: an old process of its own, the fence, a
  // declaration; the record holds nested pids and is not sealed.
  const script = `
    const {spawn}=await import('node:child_process');
    const {openFencedLock}=await import(process.argv[1]);
    const c=spawn(process.execPath,['-e','console.log(1);setInterval(()=>{},1000)','/p/scripts/codex-companion.mjs','task-worker'],{stdio:['ignore','pipe','ignore']});
    await new Promise(r=>c.stdout.once('data',r));
    const l=openFencedLock(process.argv[2],{argvMatch:${argvMatch}});
    const h=l.tryAcquire();
    const s=l.seal({domainDeclaration:'test: nested sandbox'});
    console.log(JSON.stringify({acquired:!!h,seal:s.result,record:l.status().record}));
    c.kill('SIGKILL');
  `;
  const run = spawnSync("unshare", ["-r", "-p", "-f", "--mount-proc", process.execPath, "--input-type=module", "-e", script, MODULE, F], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const nested = JSON.parse(run.stdout);
  assert.equal(nested.acquired, false, "precondition: the nested old process holds the seal there");
  assert.equal(nested.record.verdict, "nested");
  assert.ok(nested.record.S0.length > 0);
  // On the host: the nested pids mean nothing here; the host scans again and
  // finds its own old process.
  const { openFencedLock } = await import(MODULE);
  const lock = openFencedLock(F, { argvMatch: argvMatchFn });
  assert.equal(lock.tryAcquire(), null, "the host sealed a foreign record while its old process lives");
  const record = lock.status().record;
  assert.equal(record.verdict, "initial");
  assert.equal(record.sealedAt, null);
  assert.ok(record.S0.some((p) => p.pid === child.pid), JSON.stringify(record));
});
