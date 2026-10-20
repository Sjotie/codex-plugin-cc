// U1 (#1916): isBusy under the runtime running this script (Node 22, Node 26,
// Bun). argv[2] is a database another process holds with BEGIN EXCLUSIVE,
// argv[3] a file that is not a database. Prints one JSON line.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { isBusy, sqliteRuntime } = await import(
  pathToFileURL(path.resolve(here, "..", "..", "plugins", "codex", "scripts", "lib", "fenced-lock.mjs")).href
);
const [held, notADb] = process.argv.slice(2);
const open =
  typeof globalThis.Bun !== "undefined"
    ? (await import("bun:sqlite")).Database
    : (await import("node:sqlite")).DatabaseSync;

function attempt(file, sql) {
  let db;
  try {
    db = new open(file);
    db.exec(sql);
    return { error: null };
  } catch (error) {
    return { error: { code: error.code, errcode: error.errcode, errno: error.errno }, busy: isBusy(error) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

const bun = typeof globalThis.Bun !== "undefined";
const locked = bun
  ? Object.assign(new Error("database table is locked"), { code: "SQLITE_LOCKED", errno: 6 })
  : Object.assign(new Error("database table is locked"), { code: "ERR_SQLITE_ERROR", errcode: 6 });
const busyTimeout = bun
  ? Object.assign(new Error("busy"), { code: "SQLITE_BUSY_TIMEOUT", errno: 773 })
  : Object.assign(new Error("busy"), { code: "ERR_SQLITE_ERROR", errcode: 773 });
process.stdout.write(
  `${JSON.stringify({
    runtime: sqliteRuntime(),
    version: bun ? `bun ${Bun.version}` : process.version,
    held: attempt(held, "BEGIN EXCLUSIVE"),
    notADb: attempt(notADb, "BEGIN EXCLUSIVE; SELECT * FROM sqlite_master"),
    locked: isBusy(locked),
    busyTimeout: isBusy(busyTimeout),
    nullError: isBusy(null),
    fsError: isBusy(Object.assign(new Error("x"), { code: "EBUSY", errno: -16 }))
  })}\n`
);
fs.closeSync(1);
