// Preload for state-concurrency.test.mjs (#1822). Pauses this process at one
// point in the state lock protocol until the test lets it continue, so the
// test can order two writers exactly instead of hoping the OS does.
//
//   LOCK_PAUSE_DIR   directory for the marker files
//   LOCK_PAUSE_NAME  this writer's name
//   LOCK_PAUSE_AT    "lock-visible": right after state.lock appears on disk
//                    "state-read":   right after reading state.json under the lock
//
// Writes <name>.paused when it stops and waits for <name>.go. Writes
// <name>.waiting when it finds state.lock held by another live PID.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.LOCK_PAUSE_DIR;
const name = process.env.LOCK_PAUSE_NAME;
const pauseAt = process.env.LOCK_PAUSE_AT;
let paused = false;

function pause(point) {
  if (point !== pauseAt || paused) return;
  paused = true;
  fs.writeFileSync(path.join(dir, `${name}.paused`), "");
  const go = path.join(dir, `${name}.go`);
  while (!fs.existsSync(go)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
}

const isLock = (p) => typeof p === "string" && path.basename(p) === "state.lock";
const { openSync, linkSync, renameSync, readFileSync } = fs;

// state.lock can appear through any of these, depending on the implementation.
fs.openSync = function (p, ...rest) {
  const fd = openSync.call(this, p, ...rest);
  if (isLock(p)) pause("lock-visible");
  return fd;
};
fs.linkSync = function (from, to) {
  linkSync.call(this, from, to);
  if (isLock(to)) pause("lock-visible");
};
fs.renameSync = function (from, to) {
  renameSync.call(this, from, to);
  if (isLock(to)) pause("lock-visible");
};
fs.readFileSync = function (p, ...rest) {
  const out = readFileSync.call(this, p, ...rest);
  if (isLock(p)) {
    const pid = Number.parseInt(String(out), 10);
    if (pid && pid !== process.pid) fs.writeFileSync(path.join(dir, `${name}.waiting`), String(pid));
  }
  if (typeof p === "string" && path.basename(p) === "state.json") pause("state-read");
  return out;
};

// The new lock (#1916): state.lock is a fence directory and the lock is an
// SQLite transaction on state.lock.db. "lock-visible" is right after BEGIN
// EXCLUSIVE succeeds; a BUSY means another writer holds it.
try {
  const { DatabaseSync } = await import("node:sqlite");
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    const begin = String(sql).trim().toUpperCase().startsWith("BEGIN");
    try {
      const out = exec.call(this, sql);
      if (begin) pause("lock-visible");
      return out;
    } catch (error) {
      if (begin && (error.errcode & 0xff) === 5) fs.writeFileSync(path.join(dir, `${name}.waiting`), "busy");
      throw error;
    }
  };
} catch {
  // no node:sqlite: only the old lock
}
