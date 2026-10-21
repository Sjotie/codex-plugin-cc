// LOW-4 (#1916): how long the receipt check takes against transcript size.
// The check runs under A in finish(compact) and in every consumer acquire,
// so its duration is time A is held. Run through the machine test slot:
//   bun ~/Projects/homebase/scripts/test-slot.ts run -- node tests/fenced-lock/receipt-bench.mjs
// Prints JSON: per size the median and p95 of N runs. Process platform/arch
// are set to the proven darwin/arm64 so the manifest admits the fixture.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const host = `${os.type()} ${process.arch} ${os.cpus()[0]?.model ?? ""}`.trim();
Object.defineProperty(process, "platform", { value: "darwin" });
Object.defineProperty(process, "arch", { value: "arm64" });
const { readSessionReceipt, SESSION_START_COMMAND } = await import("../../plugins/codex/scripts/lib/session-admission.mjs");

const sizesMb = (process.env.RECEIPT_BENCH_SIZES_MB ?? "0.1,1,10,50,100").split(",").map(Number);
const runs = Number(process.env.RECEIPT_BENCH_RUNS ?? 7);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-bench-"));
const hex = (s) => createHash("sha256").update(s).digest("hex");
const locator = { sessionId: "bench-session", root: path.join(root, "state"), cwd: fs.realpathSync(root), transcriptPath: path.join(fs.realpathSync(root), "transcript.jsonl") };
const expected = { capabilityId: hex("c"), attemptId: hex("t"), source: "compact" };
const receipt = JSON.stringify({ type: "attachment", version: "2.1.301", sessionId: locator.sessionId, cwd: locator.cwd, isSidechain: false,
  attachment: { type: "hook_success", hookEvent: "SessionStart", hookName: "SessionStart:compact", exitCode: 0, command: SESSION_START_COMMAND,
    stdout: JSON.stringify({ continue: true, suppressOutput: true, codexStateLockAdmission: { ...expected, sessionId: locator.sessionId, root: locator.root } }) } });
// A conversation-like line of about 2 KB.
const filler = JSON.stringify({ type: "assistant", sessionId: locator.sessionId, message: { content: [{ type: "text", text: "x".repeat(1900) }] } });
const results = [];
try {
  for (const mb of sizesMb) {
    const lines = Math.max(1, Math.round((mb * 1024 * 1024) / (filler.length + 1)));
    fs.writeFileSync(locator.transcriptPath, `${`${filler}\n`.repeat(lines)}${receipt}\n`);
    const bytes = fs.statSync(locator.transcriptPath).size;
    const times = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const token = readSessionReceipt(locator, expected);
      times.push(performance.now() - t0);
      if (token.attemptId !== expected.attemptId) throw new Error("bench receipt not accepted");
    }
    times.sort((a, b) => a - b);
    results.push({ transcriptMb: +(bytes / 1024 / 1024).toFixed(2), lines: lines + 1, runs, medianMs: +times[Math.floor(runs / 2)].toFixed(2), p95Ms: +times[Math.min(runs - 1, Math.ceil(runs * 0.95) - 1)].toFixed(2) });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ node: process.version, host, results }, null, 2));
