// Preload (node --import) that stalls the companion after it logs the main turn's
// final answer, the way a CPU-starved machine or a slow synchronous job-file write
// does. Each mode writes a marker to stderr so a test can check that it stalled.
//
// STALL_AFTER_FINAL_ANSWER_MS: one freeze in its own callback, after the read that
//   delivered the final answer has returned. Data that arrives meanwhile waits in the
//   pipe, so the next loop iteration runs its due timers before it reads that data.
// STALL_BEFORE_INFERENCE_CHECK_MS: one freeze in the check phase just ahead of the
//   first setImmediate queued after the final answer (the completion inference
//   check), so the stall falls after the inference timer fired but before it decides.
// STALL_REPEATEDLY_AFTER_FINAL_ANSWER_MS: a freeze of this length on every timers
//   phase from the final answer on, so every later timer fires late.
import fs from "node:fs";

const stallAfterMs = Number(process.env.STALL_AFTER_FINAL_ANSWER_MS || 0);
const stallBeforeCheckMs = Number(process.env.STALL_BEFORE_INFERENCE_CHECK_MS || 0);
const stallRepeatedlyMs = Number(process.env.STALL_REPEATEDLY_AFTER_FINAL_ANSWER_MS || 0);

function freeze(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {}
}

const realSetImmediate = globalThis.setImmediate;
let finalAnswerSeen = false;
let checkStalled = false;
globalThis.setImmediate = function (callback, ...args) {
  if (stallBeforeCheckMs > 0 && finalAnswerSeen && !checkStalled) {
    checkStalled = true;
    realSetImmediate(() => {
      freeze(stallBeforeCheckMs);
      process.stderr.write(`[stall-after-final-answer] stalled ${stallBeforeCheckMs} ms before the inference check\n`);
    });
  }
  return realSetImmediate(callback, ...args);
};

const appendFileSync = fs.appendFileSync;
fs.appendFileSync = function (file, data, ...rest) {
  const result = appendFileSync.call(this, file, data, ...rest);
  if (!finalAnswerSeen && String(data).includes("Assistant message captured")) {
    finalAnswerSeen = true;
    if (stallAfterMs > 0) {
      realSetImmediate(() => {
        freeze(stallAfterMs);
        process.stderr.write(`[stall-after-final-answer] stalled ${stallAfterMs} ms\n`);
      });
    }
    if (stallRepeatedlyMs > 0) {
      process.stderr.write(`[stall-after-final-answer] stalling ${stallRepeatedlyMs} ms per timers phase\n`);
      setInterval(() => freeze(stallRepeatedlyMs), 1).unref();
    }
  }
  return result;
};
