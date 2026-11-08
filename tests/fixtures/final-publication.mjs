// Drive the real runTrackedJob publication through scripted lock outcomes.
// Only its state storage is substituted; the retry loop, errors and log are real.
import { mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateLockRefused, StateLockTimeout } from "../../plugins/codex/scripts/lib/fenced-lock.mjs";

const { steps, waitMs } = JSON.parse(process.argv[2]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "final-publication-"));
const logFile = path.join(root, "job.log");
const jobFile = path.join(root, "job.json");
let stored = { id: "fixture-job", status: "queued" };
let attempts = 0;
let now = 0;
Object.defineProperty(performance, "now", { value: () => now });
globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };
process.env.CODEX_COMPANION_FINAL_PUBLISH_WAIT_MS = String(waitMs);

mock.module(new URL("../../plugins/codex/scripts/lib/state.mjs", import.meta.url).href, {
  namedExports: {
    ensureStateDir() {},
    readJobFile: () => stored,
    resolveJobFile: () => jobFile,
    resolveJobLogFile: () => logFile,
    upsertJob() { throw new Error("unexpected upsert"); },
    updateJobRecord(cwd, id, update, unused, lockOptions) {
      if (lockOptions) {
        if (lockOptions.deadlineMs !== 0) throw new Error("expected a single lock attempt");
        const step = steps[attempts++];
        if (!step) throw new Error("unexpected extra publication attempt");
        now = step.at;
        if (step.error === "definitive") throw new StateLockRefused("session capability revoked");
        if (step.error === "io") throw Object.assign(new Error("publication I/O failed"), { code: "EIO" });
        if (step.error) throw Object.assign(new StateLockTimeout(step.error), { refusal: step.error === "transient" ? "transient" : null });
      }
      stored = update(stored);
      fs.writeFileSync(jobFile, JSON.stringify(stored));
      return stored;
    }
  }
});

let error = null;
try {
  const { runTrackedJob } = await import("../../plugins/codex/scripts/lib/tracked-jobs.mjs");
  await runTrackedJob({ ...stored, workspaceRoot: root, logFile }, async () => ({
    exitStatus: 0, rendered: "preserved result", payload: { ok: true }
  }));
} catch (e) {
  error = { code: e.code, message: e.message };
}
console.log(JSON.stringify({ error, attempts, stored, log: fs.readFileSync(logFile, "utf8") }));
fs.rmSync(root, { recursive: true, force: true });
