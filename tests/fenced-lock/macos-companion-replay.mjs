// Check expiry of this owned fixture's saved session admission.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (process.env.FENCED_LOCK_NATIVE_ROOT !== root) throw new Error("owned replay root required");
const state = await import(pathToFileURL(path.join(root, "plugin/scripts/lib/state.mjs")));
const file = state.resolveStateFile(root);
const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
const lock = state.openStateLock(root), handle = lock.tryAcquire();
if (handle) lock.release(handle);
const after = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
console.log(JSON.stringify({ acquired: Boolean(handle), stateUnchanged: before === after }));
