// Mutation proofs for the fenced lock (#1916, design §11: "Elke fix krijgt
// ook een mutatieproef"). Each mutation removes or inverts one rule in the
// product code, runs the tests that should catch it, and restores the file.
// A mutation that leaves every named test green "survived": the tests do not
// prove that rule. Run from the repository root:
//   node tests/fenced-lock/mutations.mjs [id ...]
// Exit code 1 when a mutation survived or could not be applied.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FL = "plugins/codex/scripts/lib/fenced-lock.mjs";
const STATE = "plugins/codex/scripts/lib/state.mjs";
const UNIT = "tests/state-lock-unit.test.mjs";
const SEAL = "tests/state-lock-seal.test.mjs";
const FENCE = "tests/state-lock-fence.test.mjs";
const ART = "tests/state-artifacts.test.mjs";

export const MUTATIONS = [
  {
    id: "residue-check-skipped",
    rule: "I6/I5b: the residue check before the scan",
    file: FL,
    from: "const found = residues(); // first the residue check",
    to: "const found = []; // first the residue check",
    tests: [[SEAL, "N31a|N31f"], [UNIT, "N31d|N31g"]]
  },
  {
    id: "residue-lstat",
    rule: "N31d: stat, not lstat (O2 follows a symlink)",
    file: FL,
    from: "st = fs.statSync(path.join(dir, name), { bigint: true }); // stat: O2",
    to: "st = fs.lstatSync(path.join(dir, name), { bigint: true }); // stat: O2",
    tests: [[UNIT, "N31d"]]
  },
  {
    id: "residue-gone-reuses-old-S0",
    rule: "I6: after the residue disappears, a new scan instead of the old S0",
    file: FL,
    from: "        }\n        // residue gone, or rescan",
    to: "          writeRecord({ ...r, residues: [], S0: [] });\n          r = readRecord();\n          continue;\n        }\n        // residue gone, or rescan",
    tests: [[SEAL, "N31a|N31f"]]
  },
  {
    id: "no-rescan-from-initial",
    rule: "v2.7: the first initial-domain process scans again",
    file: FL,
    from: "    if (!sameProc(r, here) || (here.domain.verdict === \"initial\" && r.verdict !== \"initial\" && !r.declaration)) return { state: \"rescan\", here };",
    to: "    if (!sameProc(r, here)) return { state: \"rescan\", here };",
    tests: [[SEAL, "N32b"]]
  },
  {
    id: "broker-in-S0",
    rule: "v2.7/v2.8: an old broker is no-lock-path, not unproven",
    file: FL,
    from: "  } else if (o.noLockPathScripts.has(entry.script)) {",
    to: "  } else if (false) {",
    tests: [[SEAL, "N32a"]]
  },
  {
    id: "zombie-counts-alive",
    rule: "N27c: a zombie in S0 counts as gone",
    file: FL,
    from: "  return !String(id.state).startsWith(\"Z\");\n}",
    to: "  return true;\n}",
    tests: [[SEAL, "N27c"]]
  },
  {
    id: "alive-on-pid-only",
    rule: "N27c/N32d: liveness on pid and start time",
    file: FL,
    from: "  if (p.start !== null && id.start !== p.start) return false;\n  return !String",
    to: "  return !String",
    tests: [[SEAL, "N27c"], [UNIT, "N32d"]]
  },
  {
    id: "missing-record-is-empty-S0",
    rule: "N27e: a missing record means a new scan, never an empty S0",
    file: FL,
    from: "      if (!r) {\n        if (!writeSealRecord()) return { reason: PROC_MOVED };\n        r = readRecord();\n        if (!r) return { reason: \"seal record unreadable after writing\" };\n      }\n      for (let round",
    to: "      if (!r) return { sealed: true };\n      for (let round",
    tests: [[SEAL, "N27e|N27g"]]
  },
  {
    id: "scan-every-round",
    rule: "N27d: wait rounds read only S0",
    file: FL,
    from: "    const read = inView(here, () => r.S0.filter(",
    to: "    writeSealRecord();\n    r = readRecord();\n    const read = inView(here, () => r.S0.filter(",
    tests: [[SEAL, "N27d"]]
  },
  {
    id: "self-not-excluded",
    rule: "U7: the scanner does not count itself",
    file: FL,
    from: "    if (pid === self.pid && first.start === self.start) {",
    to: "    if (false) {",
    tests: [[UNIT, "U7"]]
  },
  {
    id: "self-by-process-pid",
    rule: "U7e/P15: self from /proc/self, not process.pid",
    file: FL,
    from: "  const self = { ...reader.self(), matched: false };",
    to: "  const self = { pid: process.pid, start: reader.self().start, matched: false };",
    tests: [[UNIT, "U7e"]]
  },
  {
    id: "fd-unreadable-skipped",
    rule: "N30d1/U3: unreadable fds make a matching process unproven",
    file: FL,
    from: "        links = reader.fds(pid);\n      } catch (error) {\n        if (GONE_CODES.has(error.code)) continue;",
    to: "        links = reader.fds(pid);\n      } catch (error) {\n        continue;",
    tests: [[UNIT, "N30d|U3: an unreadable"]]
  },
  {
    id: "argv-unreadable-skipped",
    rule: "N30d2: unreadable argv with comm node is unproven",
    file: FL,
    from: "      argvReason = `argv unreadable (${error.code})`;",
    to: "      continue;",
    tests: [[UNIT, "N30d"]]
  },
  {
    id: "comm-rule-inverted",
    rule: "N30d2/d3: only node*/bun* with unreadable argv are candidates",
    file: FL,
    from: "      if (first.comm && !JS_RUNTIME.test(first.comm)) continue;\n      entry = { pid, start: first.start",
    to: "      if (first.comm && JS_RUNTIME.test(first.comm)) continue;\n      entry = { pid, start: first.start",
    tests: [[UNIT, "N30d"]]
  },
  {
    id: "kthread-not-skipped",
    rule: "N30d5: kernel threads are no candidates",
    file: FL,
    from: "    if (first.flags & PF_KTHREAD) continue;",
    to: "",
    tests: [[UNIT, "N30d"]]
  },
  {
    id: "identity-pid-only",
    rule: "N32j/N32f: identity on pid, start time and script",
    file: FL,
    from: "  const id = readIdentity(o, target);\n  if (id.gone || String(id.state).startsWith(\"Z\")) return { status: \"gone\" };",
    to: "  const id = readIdentity(o, target);\n  if (id.gone || String(id.state).startsWith(\"Z\")) return { status: \"gone\" };\n  return { status: \"same\", stopped: /^[Tt]/.test(String(id.state)) };",
    tests: [[UNIT, "N32j|N32f"]]
  },
  {
    id: "no-reread-before-sigkill",
    rule: "N32f: identity read again right before SIGKILL",
    file: FL,
    from: "      done = before(\"terminated\"); // the identity and the marker read again right before SIGKILL\n      if (done) return done;",
    to: "",
    tests: [[UNIT, "N32f"]]
  },
  {
    id: "eperm-as-gone",
    rule: "N32g: EPERM is not gone",
    file: FL,
    from: "      if (term === \"eperm\") return result(\"eperm\");",
    to: "      if (term === \"eperm\") return result(\"already-gone\");",
    tests: [[UNIT, "N32g"]]
  },
  {
    id: "A-held-during-grace",
    rule: "N32c: signals and grace outside A",
    file: FL,
    from: "      } finally {\n        unlock(h);\n      }\n    }\n    // 2. Signals",
    to: "      } finally {\n        globalThis.__heldDuringGrace = h;\n      }\n    }\n    // 2. Signals",
    tests: [[SEAL, "N32c"]]
  },
  {
    id: "unverified-as-changed",
    rule: "v2.9 N32k: an exiting process is not identity-changed",
    file: FL,
    from: "    if (argv.length === 0) return { status: \"unverified\" };",
    to: "    if (argv.length === 0) return { status: \"changed\" };",
    tests: [[UNIT, "N32k"]]
  },
  {
    id: "unverified-as-same",
    rule: "v2.9 N32l: an empty argv never gets a signal",
    file: FL,
    from: "    if (argv.length === 0) return { status: \"unverified\" };",
    to: "    if (argv.length === 0) return { status: \"same\", stopped: false };",
    tests: [[UNIT, "N32l"]]
  },
  {
    id: "isBusy-exact-code",
    rule: "U1: BUSY by primary code (errcode & 0xff)",
    file: FL,
    from: "(Number(error.errcode) & 0xff) === 5) return true;",
    to: "Number(error.errcode) === 5) return true;",
    tests: [[UNIT, "U1"]]
  },
  {
    id: "isBusy-any-error",
    rule: "U1: NOTADB and LOCKED are not BUSY",
    file: FL,
    from: "export function isBusy(error) {\n  if (!error) return false;",
    to: "export function isBusy(error) {\n  if (!error) return false;\n  return true;",
    tests: [[UNIT, "U1"]]
  },
  {
    id: "fsVerdict-signed",
    rule: "U2: statfs type as unsigned",
    file: FL,
    from: "LINUX_REFUSED_FS.get(Number(statfsType) >>> 0);",
    to: "LINUX_REFUSED_FS.get(Number(statfsType));",
    tests: [[UNIT, "U2"]]
  },
  {
    id: "hidepid-ignored",
    rule: "U6: hidepid makes the domain unknown",
    file: FL,
    from: "    if (hidepid && !",
    to: "    if (false && hidepid && !",
    tests: [[UNIT, "U6: domainVerdict from fixtures"]]
  },
  {
    id: "no-strong-ref",
    rule: "N25: the module keeps held connections alive",
    file: FL,
    from: "    HELD.add(h);\n    return h;",
    to: "    return h;",
    tests: [[FENCE, "N25"]]
  },
  {
    id: "no-marker-recheck",
    rule: "v2.10 R3: an S0 member that now holds the marker no longer holds the seal",
    file: FL,
    from: "  return aliveIn(o, p) && markerNow(o, p) !== true;",
    to: "  return aliveIn(o, p);",
    tests: [[UNIT, "R3"]]
  },
  {
    id: "editor-comm-signalled",
    rule: "v2.10 R4: no signal to a non-runtime comm without the flag",
    file: FL,
    from: "      if (t.script && t.comm && !JS_RUNTIME.test(t.comm) && !includeUnidentified) {",
    to: "      if (false) {",
    tests: [[UNIT, "R4"]]
  },
  {
    id: "start-null-signalled",
    rule: "v2.10 R5: no signal without a recorded start time",
    file: FL,
    from: "      if (t.start === null) return",
    to: "      if (false) return",
    tests: [[UNIT, "R5"]]
  },
  {
    id: "effective-by-reference",
    rule: "R1: effective fields compare by content",
    file: STATE,
    from: "!sameValue(effective.record[field], job[field])",
    to: "effective.record[field] !== job[field]",
    tests: [[ART, "R1"]]
  },
  {
    id: "listJobs-no-fallback",
    rule: "R2: reading never depends on the lock",
    file: STATE,
    from: "    if (!(error instanceof StateLockUnavailable || error instanceof StateLockTimeout)) {",
    to: "    if (true) {",
    tests: [[ART, "R2"]]
  },
  {
    id: "waiter-any-pid",
    rule: "A4b: the waiter only fails the same dead worker",
    file: "plugins/codex/scripts/lib/job-control.mjs",
    from: "            if (existing.pid !== stalePid || isProcessAlive(existing.pid)) {",
    to: "            if (Number.isInteger(existing.pid) && existing.pid > 0 && isProcessAlive(existing.pid)) {",
    tests: [[ART, "A4b"]]
  },
  {
    id: "listJobs-mtime-gate",
    rule: "v2.11 R6: a file time does not tell whether the index holds a job file",
    file: STATE,
    from: "  if (workerGone(job)) {\n    return true;\n  }\n  const effective = readEffective(cwd, job);",
    to: "  if (workerGone(job)) {\n    return true;\n  }\n  if (fs.statSync(resolveJobFile(cwd, job.id)).mtimeMs < fs.statSync(resolveStateFile(cwd)).mtimeMs) return false;\n  const effective = readEffective(cwd, job);",
    tests: [[ART, "R6"]]
  },
  {
    id: "no-marker-before-signal",
    rule: "v2.11 R7: the marker is checked again right before every signal",
    file: FL,
    from: "        if (marker.value === true) {\n          return result(\"now-proven\"",
    to: "        if (false) {\n          return result(\"now-proven\"",
    tests: [[UNIT, "R7"]]
  },
  {
    id: "stop-old-any-namespace",
    rule: "v2.11 R8: stop-old signals only from the init PID namespace",
    file: FL,
    from: "        if (o.platform === \"linux\") {\n          view = hereNow();",
    to: "        if (false) {\n          view = hereNow();",
    tests: [[UNIT, "R8"], [SEAL, "R8"]]
  },
  {
    id: "no-procfs-binding",
    rule: "v2.12 Sol r2: a seal record is judged only from the procfs that recorded it",
    file: FL,
    from: "    if (o.platform !== \"linux\") return true; // macOS: one process table, no PID namespaces",
    to: "    return true; // MUTATION",
    tests: [["tests/state-lock-sol-r2.test.mjs", "probe|reverse"]]
  },
  {
    id: "foreign-judged",
    rule: "v2.12 R9a: a reader of another procfs never judges the record",
    file: FL,
    from: "    if (!canJudge(r, here)) return { state: \"foreign\", here };\n",
    to: "",
    tests: [[UNIT, "R9a|R9d"], ["tests/state-lock-sol-r2.test.mjs", "probe"]]
  },
  {
    id: "no-init-key",
    rule: "v2.12 R9b: two procfs mounts in the init namespace agree",
    file: FL,
    from: "    if (mine.init && there.init) return true;\n",
    to: "",
    tests: [[UNIT, "R9b"]]
  },
  {
    id: "declaration-carries-anywhere",
    rule: "v2.12 R9c: a declaration carries over only within the same procfs",
    file: FL,
    from: "    const decl = declaration ?? (same ? previous.declaration : null) ?? null;",
    to: "    const decl = declaration ?? previous?.declaration ?? null;",
    tests: [[UNIT, "R9c"]]
  },
  {
    id: "seal-stamps-foreign",
    rule: "v2.12 R9e: a declaration on a foreign record scans here, it is not stamped on it",
    file: FL,
    from: "        if (r && sameProc(r, here)) {",
    to: "        if (r) {",
    tests: [[UNIT, "R9e"]]
  },
  {
    id: "stop-old-keeps-foreign",
    rule: "v2.12 R9f: stop-old scans a foreign record again before choosing targets",
    file: FL,
    from: "          if (r.verdict !== \"initial\" || !sameProc(r, view)) {",
    to: "          if (r.verdict !== \"initial\") {",
    tests: [[UNIT, "R9f"]]
  },
  {
    id: "init-from-own-domain",
    rule: "v2.12 R9g: init comes from the reader's own domain",
    file: FL,
    from: "  return { dev, bootId: bootId(), init: domain.verdict === \"initial\" };",
    to: "  return { dev, bootId: bootId(), init: true };",
    tests: [[UNIT, "R9g"]]
  },
  {
    id: "boot-id-required",
    rule: "v2.12 R9h: an unreadable boot id is not compared",
    file: FL,
    from: "    if (mine.bootId && there.bootId && mine.bootId !== there.bootId) return false;",
    to: "    if (!mine.bootId || !there.bootId || mine.bootId !== there.bootId) return false;",
    tests: [[UNIT, "R9h"]]
  },
  {
    id: "seal-reopens-sealed",
    rule: "v2.12 R9i: seal on a sealed record changes nothing",
    file: FL,
    from: "      if (r?.sealedAt) return { result: \"sealed\", record: r };\n",
    to: "",
    tests: [[UNIT, "R9i"]]
  },
  {
    id: "replaced-foreign-dropped",
    rule: "v2.14 R9j/R9j2: replacedForeign stays on every later scan, also of another procfs",
    file: FL,
    from: "    const replacedForeign = replaced ?? previous?.replacedForeign ?? null;",
    to: "    const replacedForeign = replaced ?? null;",
    tests: [[UNIT, "R9j"]]
  },
  {
    id: "unknown-domain-cached",
    rule: "v2.12 R9k: a passing unknown verdict is read again (macOS, where the verdict is kept)",
    file: FL,
    from: "    if (keepView && here.domain.verdict !== \"unknown\") viewMemo = here;",
    to: "    if (keepView) viewMemo = here;",
    tests: [[UNIT, "R9k"]]
  },
  {
    id: "view-kept-per-lock",
    rule: "v2.13 Sol r3: on Linux the view (domain and procfs) is read for every judgment, never kept per lock",
    file: FL,
    from: "  const keepView = o.platform !== \"linux\";",
    to: "  const keepView = true;",
    tests: [[UNIT, "R10a|R10b"], ["tests/state-lock-sol-r3.test.mjs", "probe"]]
  },
  {
    id: "judge-ignores-move",
    rule: "v2.13 R10c: liveness reads count only when the procfs is still the judged one",
    file: FL,
    from: "    const read = inView(here, () => r.S0.filter((p) => stillWaitingOn(o, p)));",
    to: "    const read = { moved: false, value: r.S0.filter((p) => stillWaitingOn(o, p)) };",
    tests: [[UNIT, "R10c"]]
  },
  {
    id: "scan-ignores-move",
    rule: "v2.13 R10d: a scan during which the procfs changed is not written",
    file: FL,
    from: "    const scan = inView(here, () => scanProcesses(o));",
    to: "    const scan = { moved: false, value: scanProcesses(o) };",
    tests: [[UNIT, "R10d"]]
  },
  {
    id: "rescan-from-another-view",
    rule: "v2.13: a rescan runs only in the view that decided it",
    file: FL,
    from: "    if (view && !sameView(o, view, here)) return false;\n",
    to: "",
    tests: [[UNIT, "R10f"]]
  },
  {
    id: "signal-ignores-move",
    rule: "v2.13 R10e: every identity read in stop-old counts only in the view the targets were chosen in",
    file: FL,
    from: "        const read = inView(view, () => {",
    to: "        const read = ((_view, fn) => ({ moved: false, value: fn() }))(view, () => {",
    tests: [[UNIT, "R10e"]]
  },
  {
    id: "choice-ignores-move",
    rule: "v2.13 R10e: the target choice counts only when the procfs did not change during it",
    file: FL,
    from: "        if (chosen.moved) return { ok: false, result: \"moved\"",
    to: "        if (false) return { ok: false, result: \"moved\"",
    tests: [[UNIT, "R10e"]]
  },
  {
    id: "view-check-off",
    rule: "v2.13: inView is the one place that compares the view after the reads",
    file: FL,
    from: "    if (view && o.platform === \"linux\" && !sameView(o, view, hereNow())) return { moved: true };",
    to: "",
    tests: [[UNIT, "R10c|R10e|R10g"], ["tests/state-lock-sol-r3.test.mjs", "probe"]]
  },

  {
    id: "status-argv-any-view",
    rule: "v2.13 R10g: status shows no argv from another procfs",
    file: FL,
    from: "          out.waitingOn = shown.moved ?",
    to: "          out.waitingOn = false ?",
    tests: [[UNIT, "R10g"]]
  },
  {
    id: "drain-ignores-move",
    rule: "v2.14 R10h: a drain check during which /proc changes is not drained",
    file: FL,
    from: "  const moved = o.platform === \"linux\" && !sameView(o, before, viewOf(o));",
    to: "  const moved = false;",
    tests: [[UNIT, "R10h|R10i"]]
  },
  {
    id: "adopt-ignores-move",
    rule: "v2.14 R10i: adopt-legacy checks the drain check's view and domain",
    file: FL,
    from: "      if (drain.result === \"moved\" || drain.verdict !== domain.verdict) {",
    to: "      if (false) {",
    tests: [[UNIT, "R10i"]]
  },
  {
    id: "vouched-by-dropped",
    rule: "v2.14 R9j2: the replaced record names the declaration that vouched for it",
    file: FL,
    from: "                  vouchedBy: domainDeclaration,\n",
    to: "",
    tests: [[UNIT, "R9j2"]]
  },
  {
    id: "no-assertOwned-before-rename",
    rule: "A6/§6: assertOwned before every rename",
    file: STATE,
    from: "    ctx.lock.assertOwned(ctx.handle);\n    fs.renameSync(tempFile, target);",
    to: "    fs.renameSync(tempFile, target);",
    tests: [[ART, "A6"]]
  }
];

function runTests(file, pattern) {
  const r = spawnSync(process.execPath, ["--test", "--test-timeout=60000", `--test-name-pattern=${pattern}`, file], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    timeout: 300_000
  });
  const out = `${r.stdout}${r.stderr}`;
  const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0);
  const fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 0);
  const failed = [...new Set([...out.matchAll(/^✖ (.+?)(?: \(\d)/gm)].map((m) => m[1]))];
  return { pass, fail, failed };
}

const only = process.argv.slice(2);
if (process.env.MUTATIONS_LIST_ONLY) {
  for (const m of MUTATIONS) {
    const n = fs.readFileSync(path.join(ROOT, m.file), "utf8").split(m.from).length - 1;
    if (n !== 1) console.log(`BAD ${m.id} ${n}`);
  }
  console.log(`checked ${MUTATIONS.length}`);
  process.exit(0);
}
let bad = 0;
for (const m of MUTATIONS.filter((x) => only.length === 0 || only.includes(x.id))) {
  const file = path.join(ROOT, m.file);
  const original = fs.readFileSync(file, "utf8");
  const count = original.split(m.from).length - 1;
  if (count !== 1) {
    console.log(`NOT-APPLIED ${m.id}: pattern found ${count} times in ${m.file}`);
    bad += 1;
    continue;
  }
  let results;
  try {
    fs.writeFileSync(file, original.replace(m.from, m.to));
    results = m.tests.map(([f, p]) => ({ file: f, pattern: p, ...runTests(f, p) }));
  } finally {
    fs.writeFileSync(file, original);
  }
  const ran = results.reduce((n, r) => n + r.pass + r.fail, 0);
  const red = results.some((r) => r.fail > 0);
  if (!red || ran === 0) bad += 1;
  const verdict = ran === 0 ? "NO-TESTS" : red ? "RED" : "SURVIVED";
  console.log(`${verdict} ${m.id} — ${m.rule}`);
  for (const r of results) {
    console.log(`    ${r.file} /${r.pattern}/: pass ${r.pass}, fail ${r.fail}${r.failed.length ? `; failing: ${r.failed.join(" | ")}` : ""}`);
  }
}
process.exitCode = bad > 0 ? 1 : 0;
