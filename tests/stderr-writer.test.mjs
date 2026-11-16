// #4212: stderr has one writer. Paths, working directories and state fields from other
// workspace roots are untrusted fragments: escaped completely, line feeds included.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { StateLockTimeout, openFencedLock } from "../plugins/codex/scripts/lib/fenced-lock.mjs";
import { acquireWithSealWait } from "../plugins/codex/scripts/lib/seal-wait.mjs";
import { formatStderr, sanitizeChunk } from "../plugins/codex/scripts/lib/stderr-writer.mjs";

const SCRIPTS = path.resolve(import.meta.dirname, "../plugins/codex/scripts");
const COMPANION = path.join(SCRIPTS, "codex-companion.mjs");
const FORGED = "\nstate-lock: forged line \u001b[2J\u009b2J\u{E0001}";

// Records what reaches the stream below the guard (the stream's own _write).
function capture(fn) {
  const chunks = [];
  const original = process.stderr._write;
  process.stderr._write = (chunk, _encoding, callback) => {
    chunks.push(String(chunk));
    callback();
  };
  try {
    fn();
  } finally {
    process.stderr._write = original;
  }
  return chunks.join("");
}

function assertOneLine(text) {
  assert.equal(text.split("\n").length, 2, `one line ending in a newline, got ${JSON.stringify(text)}`);
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]|[\u{E0000}-\u{E007F}]/u);
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(mjs|js|cjs)$/.test(entry.name) ? [file] : [];
  });
}

test("nothing in the plugin scripts writes to stderr except the one writer", () => {
  const offenders = [];
  for (const file of sourceFiles(SCRIPTS)) {
    // fenced-lock.mjs is the vendored byte-equal core copy; the guard in stderr-writer.mjs covers it.
    if (["stderr-writer.mjs", "fenced-lock.mjs"].includes(path.basename(file))) continue;
    const text = fs.readFileSync(file, "utf8");
    if (/process\.stderr|console\.(error|warn|trace)\b|fs\.(write|writeSync)\(\s*2\b/.test(text)) offenders.push(path.relative(SCRIPTS, file));
  }
  assert.deepEqual(offenders, []);
});

test("the stream guard keeps only a final line feed, so a vendored raw write cannot forge a line", () => {
  assert.equal(sanitizeChunk(`state-lock: statfs /r/a${FORGED} failed\n`).split("\n").length, 2);
  assert.equal(sanitizeChunk("plain\n"), "plain\n");
  assert.equal(sanitizeChunk("no newline"), "no newline");
});

test("formatStderr keeps the literal text and escapes every fragment, line feeds included", () => {
  const line = formatStderr`state-lock: statfs ${"/r/a" + FORGED} failed (${"EACCES"}); continuing\n`;
  assertOneLine(line);
  assert.match(line, /^state-lock: statfs \/r\/a\\u000astate-lock: forged line \\u001b\[2J\\u009b2J\\udb40\\udc01 failed \(EACCES\); continuing\n$/);
});

test("a statfs failure on a foreign directory prints one escaped line (fenced-lock)", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-writer-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, `root${FORGED}`);
  fs.mkdirSync(dir);
  const original = fs.statfsSync;
  fs.statfsSync = () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  };
  t.after(() => {
    fs.statfsSync = original;
  });
  const lock = openFencedLock(path.join(dir, "state.lock"), {});
  const text = capture(() => {
    try {
      lock.acquire({ deadlineMs: 200 });
    } catch {
      // the lock may refuse afterwards; only the stderr line matters here
    }
  });
  assert.match(text, /^state-lock: statfs /);
  assertOneLine(text);
});

test("the seal wait line escapes the working directory of a blocking process (seal-wait sink)", () => {
  const reason = "fence not sealed yet; old plugin processes from before the fence: pid 7";
  const blocked = () => Object.assign(new StateLockTimeout("Timed out waiting for state lock: /x", reason), { refusal: "transient" });
  let calls = 0;
  const lock = {
    acquire() {
      calls += 1;
      if (calls === 1) throw blocked();
      return { release() {} };
    },
    status: () => ({ waitingOn: { kind: "processes", processes: [{ pid: 7, start: "1", uid: 1, comm: "node", script: "codex-companion.mjs", sub: null, verdict: "unproven", reason: "x" }] } })
  };
  const text = capture(() => {
    acquireWithSealWait(lock, { waitMs: 60_000, describe: () => ({ user: "u", ppid: 1, running: "1:00", cwd: `/work${FORGED}` }) });
  });
  assert.match(text, /^state lock: waiting up to \d+ s more/);
  assertOneLine(text);
});

test("a foreign path in a thrown filesystem error cannot forge a second message (main handler)", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-writer-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, `a${FORGED}`);
  fs.writeFileSync(file, "x");
  const result = spawnSync(process.execPath, [COMPANION, "task", "--cwd", path.join(file, "child"), "--resume-last", "hello"], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(base, "data") }
  });
  assert.match(result.stderr, /^ENOTDIR/);
  assertOneLine(result.stderr);
});
