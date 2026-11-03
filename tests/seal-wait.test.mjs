// #4648: a start command that finds the fence unsealed waits for the old plugin
// processes that hold it, and a failure names them and the routes.
import test from "node:test";
import assert from "node:assert/strict";

import { StateLockRefused, StateLockTimeout } from "../plugins/codex/scripts/lib/fenced-lock.mjs";
import {
  DEFAULT_SEAL_WAIT_MS,
  MAX_SEAL_WAIT_MS,
  acquireWithSealWait,
  getStateLockSealWait,
  setStateLockSealWait,
  startCommandSealWaitMs
} from "../plugins/codex/scripts/lib/seal-wait.mjs";

const OLD_TASK_WORKER = { pid: 1902705, start: "123456", uid: 1000, comm: "node", script: "codex-companion.mjs", sub: "task-worker", verdict: "unproven", reason: "no marker fd" };
const OLD_BROKER = { pid: 1902787, start: "123999", uid: 1000, comm: "node", script: "app-server-broker.mjs", sub: null, verdict: "unproven", reason: "no marker fd" };

const describe = (pid) => ({ user: "sjoerd", ppid: 1, running: pid === 1902705 ? "03:12:09" : "1-02:00:00", cwd: "/home/sjoerd/work" });

function timeout(reason = "fence not sealed yet; old plugin processes from before the fence: pid 1902705") {
  return Object.assign(new StateLockTimeout(`Timed out waiting for state lock: /x/state.lock (${reason})`, reason), { refusal: "transient" });
}

// A lock whose acquire follows a script: each entry is a handle or an error.
function fakeLock({ outcomes, processes = [OLD_TASK_WORKER] }) {
  const calls = [];
  return {
    calls,
    acquire(options) {
      calls.push(options);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    status() {
      return { waitingOn: processes.length ? { kind: "processes", processes } : { kind: "nothing" } };
    }
  };
}

const options = (extra = {}) => ({ describe, log: (line) => extra.logs?.push(line), companionScript: "/plugin/scripts/codex-companion.mjs", cwd: "/work", ...extra });

test("a blocked seal names every old process with user, parent, age and cwd, and the two routes", () => {
  const original = timeout();
  const lock = fakeLock({ outcomes: [original], processes: [OLD_TASK_WORKER, OLD_BROKER] });
  assert.throws(
    () => acquireWithSealWait(lock, options({ waitMs: 0 })),
    (error) => {
      assert.ok(error instanceof StateLockTimeout);
      assert.ok(!(error instanceof StateLockRefused));
      assert.equal(error.refusal, "transient");
      assert.equal(error.reason, original.reason);
      assert.match(error.message, /2 old plugin processes from before the fence are still running and could still write state/);
      assert.match(error.message, /pid 1902705 \(codex-companion\.mjs task-worker; user sjoerd, parent 1, running 03:12:09, cwd \/home\/sjoerd\/work\)/);
      assert.match(error.message, /pid 1902787 \(app-server-broker\.mjs; user sjoerd, parent 1, running 1-02:00:00/);
      assert.match(error.message, /not stale: alive by pid and start time/);
      assert.match(error.message, /Wait for them to finish/);
      assert.match(error.message, /state-lock stop-old --cwd "\/work"/);
      assert.match(error.message, /Timed out waiting for state lock/, "the original message stays in it");
      assert.equal(error.blockers.length, 2);
      return true;
    }
  );
  assert.equal(lock.calls.length, 1, "no wait without a seal wait");
});

test("a start command waits for the old processes: the second try succeeds when they ended", () => {
  const handle = { id: "h" };
  const lock = fakeLock({ outcomes: [timeout(), handle] });
  const logs = [];
  const got = acquireWithSealWait(lock, options({ waitMs: 50_000, logs }));
  assert.equal(got, handle);
  assert.deepEqual(lock.calls, [{}, { deadlineMs: 50_000 }]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /waiting up to 50 s for old plugin processes from before the fence: pid 1902705 \(codex-companion\.mjs task-worker/);
});

test("a wait that does not help ends in the named error and says how long it waited", () => {
  const lock = fakeLock({ outcomes: [timeout(), timeout()] });
  assert.throws(
    () => acquireWithSealWait(lock, options({ waitMs: 5 })),
    (error) => {
      assert.match(error.message, /pid 1902705/);
      assert.match(error.message, /\(waited \d+ s\)/);
      return true;
    }
  );
  assert.deepEqual(lock.calls, [{}, { deadlineMs: 5 }]);
});

test("a timeout that is not about old processes is rethrown unchanged, with no wait", () => {
  const original = timeout("busy: another process holds the lock");
  const lock = fakeLock({ outcomes: [original], processes: [] });
  assert.throws(() => acquireWithSealWait(lock, options({ waitMs: 50_000 })), (error) => error === original);
  assert.equal(lock.calls.length, 1);
});

test("a definitive refusal and other errors pass through untouched", () => {
  const refused = new StateLockRefused("State lock refused: /x (revoked)", "revoked");
  assert.throws(() => acquireWithSealWait(fakeLock({ outcomes: [refused] }), options({ waitMs: 50_000 })), (error) => error === refused);
  const other = new Error("EACCES");
  assert.throws(() => acquireWithSealWait(fakeLock({ outcomes: [other] }), options({ waitMs: 50_000 })), (error) => error === other);
});

test("the deadline given by the caller reaches the first try", () => {
  const handle = {};
  const lock = fakeLock({ outcomes: [handle] });
  assert.equal(acquireWithSealWait(lock, options({ deadlineMs: 0 })), handle);
  assert.deepEqual(lock.calls, [{ deadlineMs: 0 }]);
});

test("a failing status read keeps the original timeout", () => {
  const original = timeout();
  const lock = { acquire() { throw original; }, status() { throw new Error("boom"); } };
  assert.throws(() => acquireWithSealWait(lock, options({ waitMs: 1000 })), (error) => error === original);
});

test("the seal wait of start commands: default, override, off, clamp; hooks keep zero", () => {
  assert.equal(getStateLockSealWait(), 0, "hooks and read paths keep the ordinary deadline");
  assert.equal(startCommandSealWaitMs({}), DEFAULT_SEAL_WAIT_MS);
  assert.equal(startCommandSealWaitMs({ CODEX_COMPANION_SEAL_WAIT_MS: "0" }), 0);
  assert.equal(startCommandSealWaitMs({ CODEX_COMPANION_SEAL_WAIT_MS: "12000" }), 12000);
  assert.equal(startCommandSealWaitMs({ CODEX_COMPANION_SEAL_WAIT_MS: "999999999" }), MAX_SEAL_WAIT_MS);
  assert.equal(startCommandSealWaitMs({ CODEX_COMPANION_SEAL_WAIT_MS: "nonsense" }), DEFAULT_SEAL_WAIT_MS);
  setStateLockSealWait(7000);
  assert.equal(getStateLockSealWait(), 7000);
  setStateLockSealWait(0);
  assert.equal(getStateLockSealWait(), 0);
});
