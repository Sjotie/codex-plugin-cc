// #4648: a start command that finds the fence unsealed waits once, up front,
// for the old plugin processes that hold it, and a failure names them and the
// routes. Fake lock: the real seal scan needs /proc.
import test from "node:test";
import assert from "node:assert/strict";

import { StateLockRefused, StateLockTimeout } from "../plugins/codex/scripts/lib/fenced-lock.mjs";
import {
  DEFAULT_SEAL_WAIT_MS,
  MAX_SEAL_WAIT_MS,
  acquireWithSealWait,
  startCommandSealWaitMs
} from "../plugins/codex/scripts/lib/seal-wait.mjs";

const OLD_TASK_WORKER = { pid: 1902705, start: "123456", uid: 1000, comm: "node", script: "codex-companion.mjs", sub: "task-worker", verdict: "unproven", reason: "no marker fd" };
const OLD_BROKER = { pid: 1902787, start: "123999", uid: 1000, comm: "node", script: "app-server-broker.mjs", sub: null, verdict: "unproven", reason: "no marker fd" };

const describeOne = (pid) => ({ user: "sjoerd", ppid: 1, running: pid === 1902705 ? "03:12:09" : "1-02:00:00", cwd: "/home/sjoerd/work" });

const SEAL_REASON = "fence not sealed yet; old plugin processes from before the fence: pid 1902705";

function timeout(reason = SEAL_REASON) {
  return Object.assign(new StateLockTimeout(`Timed out waiting for state lock: /x/state.lock (${reason})`, reason), { refusal: "transient" });
}

// A lock whose acquire follows a script: each entry is a handle or an error.
// processes: the blockers status lists; or a function of the number of acquires so far.
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
      const list = typeof processes === "function" ? processes(calls.length) : processes;
      return { waitingOn: list.length ? { kind: "processes", processes: list } : { kind: "nothing" } };
    }
  };
}

function options(extra = {}) {
  const described = [];
  return {
    described,
    describe: (pid) => {
      described.push(pid);
      return describeOne(pid);
    },
    log: (line) => extra.logs?.push(line),
    companionScript: "/plugin/scripts/codex-companion.mjs",
    cwd: "/work",
    ...extra
  };
}

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
      assert.equal(error.cause, original, "the original error is kept as the cause");
      assert.match(error.message, /2 old plugin processes from before the fence are still running and could still write state/);
      assert.match(error.message, /pid 1902705 \(codex-companion\.mjs task-worker; user sjoerd, parent 1, running 03:12:09, cwd \/home\/sjoerd\/work\)/);
      assert.match(error.message, /pid 1902787 \(app-server-broker\.mjs; user sjoerd, parent 1, running 1-02:00:00/);
      assert.match(error.message, /not stale: alive by pid and start time/);
      assert.match(error.message, /Wait for them to finish/);
      assert.match(error.message, /state-lock stop-old --cwd '\/work'/);
      assert.match(error.message, /Timed out waiting for state lock/, "the original message stays in it");
      assert.equal(error.blockers.length, 2);
      return true;
    }
  );
  assert.deepEqual(lock.calls, [{}], "no wait without a wait budget");
});

test("a start command waits for the old processes: the second try gets the rest of the budget and succeeds", () => {
  const handle = { id: "h" };
  const lock = fakeLock({ outcomes: [timeout(), handle] });
  const logs = [];
  const got = acquireWithSealWait(lock, options({ waitMs: 60_000, logs }));
  assert.equal(got, handle);
  assert.equal(lock.calls.length, 2);
  assert.deepEqual(lock.calls[0], {});
  const rest = lock.calls[1].deadlineMs;
  assert.ok(rest > 59_000 && rest <= 60_000, `the budget is a total, the first try already counted: ${rest}`);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /waiting up to \d+ s more for old plugin processes from before the fence: pid 1902705 \(codex-companion\.mjs task-worker/);
});

test("a wait that does not help ends in the named error", () => {
  const lock = fakeLock({ outcomes: [timeout(), timeout()] });
  assert.throws(
    () => acquireWithSealWait(lock, options({ waitMs: 10_000 })),
    (error) => {
      assert.match(error.message, /pid 1902705/);
      return true;
    }
  );
  assert.equal(lock.calls.length, 2);
});

test("a total below the ordinary deadline caps the first try", () => {
  // The fake returns at once, so some of the 3 s is left for the second try; in
  // real use the first try has spent it.
  const lock = fakeLock({ outcomes: [timeout(), timeout()] });
  assert.throws(() => acquireWithSealWait(lock, options({ waitMs: 3000 })), (error) => /pid 1902705/.test(error.message));
  assert.deepEqual(lock.calls[0], { deadlineMs: 3000 });
  const off = fakeLock({ outcomes: [timeout()] });
  assert.throws(() => acquireWithSealWait(off, options({ waitMs: 0 })));
  assert.deepEqual(off.calls, [{}], "0 switches the wait off: the ordinary deadline");
});

test("every blocker is described once, however often it is shown", () => {
  const lock = fakeLock({ outcomes: [timeout(), timeout()], processes: [OLD_TASK_WORKER, OLD_BROKER] });
  const opts = options({ waitMs: 10_000, logs: [] });
  assert.throws(() => acquireWithSealWait(lock, opts));
  assert.deepEqual(opts.described.sort(), [1902705, 1902787]);
});

test("a caller with its own deadline gets the plain lock: no wait, no diagnosis, no ps", () => {
  const original = timeout();
  const lock = fakeLock({ outcomes: [original] });
  const opts = options({ waitMs: 60_000 });
  assert.throws(() => acquireWithSealWait(lock, { ...opts, deadlineMs: 0 }), (error) => error === original);
  assert.deepEqual(lock.calls, [{ deadlineMs: 0 }]);
  assert.deepEqual(opts.described, []);
  const handle = {};
  assert.equal(acquireWithSealWait(fakeLock({ outcomes: [handle] }), { ...opts, deadlineMs: 250 }), handle);
});

test("a timeout with no old process listed (busy, transient refusal) is rethrown unchanged, with no wait", () => {
  for (const reason of ["busy: another process holds the lock", "admission: transient refusal", SEAL_REASON]) {
    const original = timeout(reason);
    const lock = fakeLock({ outcomes: [original], processes: [] });
    assert.throws(() => acquireWithSealWait(lock, options({ waitMs: 60_000 })), (error) => error === original);
    assert.equal(lock.calls.length, 1);
  }
});

test("when the old processes ended during the wait and something else holds the lock, the new error is not blamed on them", () => {
  const busy = timeout("busy: another process holds the lock");
  const lock = fakeLock({ outcomes: [timeout(), busy], processes: (calls) => (calls < 2 ? [OLD_TASK_WORKER] : []) });
  const logs = [];
  assert.throws(() => acquireWithSealWait(lock, options({ waitMs: 10_000, logs })), (error) => error === busy);
  assert.equal(logs.length, 1, "it did wait for the old process first");
});

test("a definitive refusal and other errors pass through untouched", () => {
  const refused = new StateLockRefused("State lock refused: /x (revoked)", "revoked");
  assert.throws(() => acquireWithSealWait(fakeLock({ outcomes: [refused] }), options({ waitMs: 60_000 })), (error) => error === refused);
  const other = new Error("EACCES");
  assert.throws(() => acquireWithSealWait(fakeLock({ outcomes: [other] }), options({ waitMs: 60_000 })), (error) => error === other);
});

test("a failing status read keeps the original timeout", () => {
  const original = timeout();
  const lock = { acquire() { throw original; }, status() { throw new Error("boom"); } };
  assert.throws(() => acquireWithSealWait(lock, options({ waitMs: 1000 })), (error) => error === original);
});

test("the route in the message is quoted for a shell", () => {
  const lock = fakeLock({ outcomes: [timeout()] });
  assert.throws(
    () => acquireWithSealWait(lock, options({ cwd: "/work/it's $(x)", companionScript: "/plug in/codex-companion.mjs" })),
    (error) => {
      assert.ok(error.message.includes(`node '/plug in/codex-companion.mjs' state-lock stop-old --cwd '/work/it'\\''s $(x)'`), error.message);
      return true;
    }
  );
});

test("the total wait of start commands: default, override, off, clamp", () => {
  assert.equal(startCommandSealWaitMs({}), DEFAULT_SEAL_WAIT_MS);
  assert.equal(startCommandSealWaitMs({ CODEX_COMPANION_SEAL_WAIT_MS: "0" }), 0);
  assert.equal(startCommandSealWaitMs({ CODEX_COMPANION_SEAL_WAIT_MS: "12000" }), 12000);
  assert.equal(startCommandSealWaitMs({ CODEX_COMPANION_SEAL_WAIT_MS: "999999999" }), MAX_SEAL_WAIT_MS);
  assert.equal(startCommandSealWaitMs({ CODEX_COMPANION_SEAL_WAIT_MS: "nonsense" }), DEFAULT_SEAL_WAIT_MS);
});
