// A new-code process for the drain-check tests (#1916, U3, U7): it loads the
// module (and so holds the protocol marker), optionally pauses before its
// scan, runs one drain-check, and optionally stays alive until released.
// Run with plugin-like argv after the script, e.g.
//   node drain-driver.mjs /plugin/scripts/codex-companion.mjs state-lock drain-check
//
// Environment:
//   DRIVER_BARRIERS   directory for event files
//   DRIVER_ROLE       name of this driver
//   DRIVER_OP         "drain" (default) or "idle" (no scan, wait for release)
//   DRIVER_PAUSE      "1": signal <role>.paused and wait for <role>.resume before the scan
//   DRIVER_HOLD       "1": after the scan, wait for <role>.release before exiting
//   DRIVER_FENCED_LOCK  module to load (default: this checkout's fenced-lock.mjs)
//
// Events: <role>.ready, <role>.paused, <role>.done (JSON)
import "./scan-scope.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const env = process.env;
const role = env.DRIVER_ROLE ?? "driver";
const barriers = env.DRIVER_BARRIERS;
const eventPath = (name) => path.join(barriers, name);
const signal = (name, body = "") => fs.writeFileSync(eventPath(`${role}.${name}`), body);
const waitFor = (name) => {
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(eventPath(`${role}.${name}`))) {
    if (Date.now() >= deadline) throw new Error(`driver ${role} timed out waiting for ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = env.DRIVER_FENCED_LOCK ?? path.resolve(here, "..", "..", "plugins", "codex", "scripts", "lib", "fenced-lock.mjs");
const statePath = path.resolve(here, "..", "..", "plugins", "codex", "scripts", "lib", "state.mjs");
const { drainCheck } = await import(pathToFileURL(modulePath).href);
const { matchPluginArgv } = await import(pathToFileURL(statePath).href);

signal("ready", String(process.pid));
if ((env.DRIVER_OP ?? "drain") === "idle") {
  waitFor("release");
} else {
  if (env.DRIVER_PAUSE === "1") {
    signal("paused");
    waitFor("resume");
  }
  const result = drainCheck({ argvMatch: matchPluginArgv, noLockPathScripts: new Set(["app-server-broker.mjs"]) });
  signal("done", JSON.stringify(result));
  if (env.DRIVER_HOLD === "1") waitFor("release");
}
