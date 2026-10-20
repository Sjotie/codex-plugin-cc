// Regression test from round 3 of the cross-family H-review of #1916 (GPT-6.1
// Sol high, P1 on 96f296a): the procfs identity was kept per lock, so a new
// procfs mounted on /proc under a lock that had already judged the host
// record let a nested reader seal while the old host process lived (design
// v2.13). The reviewer's probe runs unchanged
// (tests/fenced-lock/sol-r3/proc-remount.mjs, sha256 in the review package).
// Red on 96f296a, green after the fix. Linux with unprivileged user, PID and
// mount namespaces only.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = path.join(ROOT, "tests/fenced-lock/sol-r3/proc-remount.mjs");
const unshareWorks = (flags) => process.platform === "linux" && spawnSync("unshare", [...flags, "true"]).status === 0;

test("Sol r3 probe: a new procfs mounted on /proc under a lock never lets it seal a host record whose old process lives", (t) => {
  if (!unshareWorks(["-r", "-p", "-f", "-m"]) || !unshareWorks(["-r", "-p", "-f", "--mount-proc"])) {
    t.skip("unshare -r -p -f -m with a procfs mount not available");
    return;
  }
  const run = spawnSync(process.execPath, [PROBE], { encoding: "utf8", env: { ...process.env, REVIEW_PLUGIN: ROOT } });
  const out = JSON.parse(run.stdout);
  assert.equal(out.alive, true, "precondition: the old host process lives");
  assert.notEqual(out.result.beforeDev, out.result.afterDev, "precondition: another procfs came on /proc");
  assert.equal(out.result.before.kind, "processes", "precondition: before the mount the nested reader judged and saw the old process");
  assert.equal(out.result.acquired, false, JSON.stringify(out.result));
  assert.equal(out.result.after.sealedAt, null);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
