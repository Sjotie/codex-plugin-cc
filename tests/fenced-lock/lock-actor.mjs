// One state-lock operation of the new code in a real process (#1916): hold
// the lock, adopt-legacy, seal, stop-old, unfence, status, drain-check. Gates
// on fs calls and on the SQLite transaction let a test pause or kill it at an
// exact step. Test processes only.
//
// Environment:
//   ACTOR_WORKSPACE, ACTOR_BARRIERS, ACTOR_ROLE   as in job-actor.mjs
//   ACTOR_OP     JSON {op, ...args}
//   ACTOR_GATES  JSON [{fn, match, when: "before"|"after", nth, action, name}]
//                fn: any fs function name (the path is the first argument, for
//                renameSync/linkSync the target), or "sql" (match on the statement)
//
// Events: <role>.paused.<name>, <role>.held, <role>.done (JSON), <role>.error
import "./scan-scope.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const env = process.env;
const role = env.ACTOR_ROLE;
const barriers = env.ACTOR_BARRIERS;
const workspace = env.ACTOR_WORKSPACE;
const op = JSON.parse(env.ACTOR_OP);
const gates = JSON.parse(env.ACTOR_GATES ?? "[]").map((g) => ({ ...g, seen: 0, re: new RegExp(g.match) }));

const write = fs.writeFileSync;
const exists = fs.existsSync;
const eventPath = (name) => path.join(barriers, name);
const signal = (name, body = "") => write.call(fs, eventPath(`${role}.${name}`), body);
const waitFor = (name) => {
  const deadline = Date.now() + 60_000;
  while (!exists.call(fs, eventPath(name))) {
    if (Date.now() >= deadline) throw new Error(`actor ${role} timed out waiting for ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};

function fire(gate) {
  if (gate.action === "kill") {
    process.kill(process.pid, "SIGKILL");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  }
  if (gate.action.startsWith("fail:")) {
    const code = gate.action.slice(5);
    throw Object.assign(new Error(`fixture: ${code}`), { code });
  }
  signal(`paused.${gate.name}`);
  waitFor(`${role}.resume.${gate.name}`);
}

function around(fn, target, call) {
  const matching = gates.filter((g) => g.fn === fn && g.re.test(target));
  for (const g of matching) {
    g.seen += 1;
    if (g.when === "before" && g.seen === (g.nth ?? 1)) fire(g);
  }
  const result = call();
  for (const g of matching) {
    if (g.when === "after" && g.seen === (g.nth ?? 1)) fire(g);
  }
  return result;
}

for (const fn of new Set(gates.map((g) => g.fn).filter((fn) => fn !== "sql"))) {
  const original = fs[fn];
  fs[fn] = function (first, second, ...rest) {
    const target = String(fn === "renameSync" || fn === "linkSync" ? second : first);
    return around(fn, target, () => original.call(this, first, second, ...rest));
  };
}
let begins = 0;
if (op.countBegins) {
  const { DatabaseSync } = await import("node:sqlite");
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (String(sql).trim().toUpperCase().startsWith("BEGIN")) begins += 1;
    return exec.call(this, sql);
  };
}
if (gates.some((g) => g.fn === "sql")) {
  const { DatabaseSync } = await import("node:sqlite");
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    return around("sql", String(sql), () => exec.call(this, sql));
  };
}

const STATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "codex", "scripts", "lib", "state.mjs");
const { openStateLock, ensureStateDir, updateState } = await import(pathToFileURL(STATE).href);

try {
  ensureStateDir(workspace);
  const lock = openStateLock(workspace);
  let result = null;
  switch (op.op) {
    case "hold": {
      const handle = lock.acquire({ deadlineMs: op.deadlineMs ?? 10_000 });
      signal("held");
      if (op.detachChild) {
        const { spawn } = await import("node:child_process");
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { detached: true, stdio: "ignore" });
        child.unref();
        signal("child", String(child.pid));
      }
      if (op.diagnose) {
        lock.status();
        fs.statSync(lock.authorityPath);
      }
      if (op.violateP5) {
        fs.closeSync(fs.openSync(lock.authorityPath, "r"));
      }
      if (op.exitHolding) process.exit(0);
      waitFor(`${role}.release`);
      lock.release(handle);
      break;
    }
    case "gcHold": {
      // N25: no reference to the handle in this code; the module keeps one.
      lock.acquire({ deadlineMs: op.deadlineMs ?? 10_000 });
      for (let i = 0; i < 5; i++) globalThis.gc?.();
      signal("held", String(typeof globalThis.gc));
      waitFor(`${role}.release`);
      break;
    }
    case "write": {
      updateState(workspace, (state) => {
        state.jobs.push({ id: role, status: "completed", updatedAt: new Date().toISOString() });
      });
      break;
    }
    case "acquire": {
      try {
        const handle = lock.acquire({ deadlineMs: op.deadlineMs ?? 10_000 });
        lock.release(handle);
        result = { acquired: true, begins };
      } catch (error) {
        result = { acquired: false, code: error.code, message: error.message, begins };
      }
      break;
    }
    case "adopt":
      try {
        result = lock.adoptLegacy(op.args);
      } catch (error) {
        result = { ok: false, code: error.code, message: error.message };
      }
      break;
    case "seal":
      result = lock.seal(op.args ?? {});
      break;
    case "stopOld":
      result = lock.stopOld(op.args ?? {});
      break;
    case "unfence":
      result = lock.unfence(op.args ?? {});
      break;
    case "status":
      result = lock.status();
      break;
    case "drain":
      result = lock.drainCheck();
      break;
    default:
      throw new Error(`unknown op ${op.op}`);
  }
  signal("done", JSON.stringify(result));
} catch (error) {
  signal("error", String(error?.stack ?? error));
  process.exitCode = 1;
}
