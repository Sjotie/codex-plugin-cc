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
    from: "        writeSealRecord(); // a new check and a new scan, after T_r\n        r = readRecord();",
    to: "        writeRecord({ ...r, residues: [], S0: [] });\n        r = readRecord();",
    tests: [[SEAL, "N31a|N31f"]]
  },
  {
    id: "no-rescan-from-initial",
    rule: "v2.7: the first initial-domain process scans again",
    file: FL,
    from: "      if (r.verdict !== \"initial\" && !r.declaration && currentDomain().verdict === \"initial\") {",
    to: "      if (false) {",
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
    from: "      if (!r) {\n        writeSealRecord();\n        r = readRecord();\n        if (!r) return { reason: \"zegelrecord onleesbaar na schrijven\" };\n      }\n      if (r.sealedAt)",
    to: "      if (!r) return { sealed: true };\n      if (r.sealedAt)",
    tests: [[SEAL, "N27e|N27g"]]
  },
  {
    id: "scan-every-round",
    rule: "N27d: wait rounds read only S0",
    file: FL,
    from: "      const rest = r.S0.filter((p) => aliveIn(o, p));\n      if (rest.length === 0) {\n        writeRecord",
    to: "      writeSealRecord();\n      r = readRecord();\n      const rest = r.S0.filter((p) => aliveIn(o, p));\n      if (rest.length === 0) {\n        writeRecord",
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
    from: "      argvReason = `argv onleesbaar (${error.code})`;",
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
    from: "      c = settled();\n      if (c.status === \"gone\") return { ...who, outcome: \"terminated\" };",
    to: "      c = { status: \"same\" };\n      if (c.status === \"gone\") return { ...who, outcome: \"terminated\" };",
    tests: [[UNIT, "N32f"]]
  },
  {
    id: "eperm-as-gone",
    rule: "N32g: EPERM is not gone",
    file: FL,
    from: "      if (term === \"eperm\") return { ...who, outcome: \"eperm\" };",
    to: "      if (term === \"eperm\") return { ...who, outcome: \"already-gone\" };",
    tests: [[UNIT, "N32g"]]
  },
  {
    id: "A-held-during-grace",
    rule: "N32c: signals and grace outside A",
    file: FL,
    from: "        targets = r.S0.filter((p) => aliveIn(o, p));\n      } finally {\n        unlock(h);\n      }",
    to: "        targets = r.S0.filter((p) => aliveIn(o, p));\n      } finally {\n        globalThis.__heldDuringGrace = h;\n      }",
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
