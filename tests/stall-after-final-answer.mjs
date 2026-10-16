// Preload (node --import) that freezes the process for STALL_AFTER_FINAL_ANSWER_MS
// right after the companion logs the main turn's final answer, the way a CPU-starved
// machine deschedules it. The freeze runs in its own callback, after the read that
// delivered the final answer has returned, so data that arrives meanwhile waits in the
// pipe and the next loop iteration runs its due timers before it reads that data.
import fs from "node:fs";

const stallMs = Number(process.env.STALL_AFTER_FINAL_ANSWER_MS || 0);
const appendFileSync = fs.appendFileSync;
let stalled = false;
fs.appendFileSync = function (file, data, ...rest) {
  const result = appendFileSync.call(this, file, data, ...rest);
  if (stallMs > 0 && !stalled && String(data).includes("Assistant message captured")) {
    stalled = true;
    setImmediate(() => {
      const until = Date.now() + stallMs;
      while (Date.now() < until) {}
      // Lets the test check that the stall really happened.
      process.stderr.write(`[stall-after-final-answer] stalled ${stallMs} ms\n`);
    });
  }
  return result;
};
