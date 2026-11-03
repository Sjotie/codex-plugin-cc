// #4653: long JSONL lines from the app-server.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as appServer from "../plugins/codex/scripts/lib/app-server.mjs";

const { AppServerClientBase, CodexAppServerClient } = appServer;

function installLongLineCodex(lineEnding) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "long-line-codex-"));
  const bin = path.join(dir, "codex");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
setTimeout(() => process.exit(0), 20000); // safety net: never outlive the test
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method !== "initialize") return;
  // > 64 KiB, with U+2028/U+2029 (left unescaped by JSON.stringify) in the middle, written in small chunks.
  const text = "a".repeat(30000) + "\\u2028" + "b".repeat(40000) + "\\u2029" + "c".repeat(30000);
  const out = JSON.stringify({ id: msg.id, result: { userAgent: "fake", text } }) + ${JSON.stringify(lineEnding)};
  for (let i = 0; i < out.length; i += 7000) process.stdout.write(out.slice(i, i + 7000));
});
`,
    { mode: 0o755 }
  );
  return dir;
}

test("direct app-server client parses a >64 KiB line with U+2028/2029 delivered in chunks", async () => {
  const dir = installLongLineCodex("\n");
  let timer;
  const client = await Promise.race([
    CodexAppServerClient.connect(process.cwd(), {
      disableBroker: true,
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("connect did not settle within 10s")), 10000);
    })
  ]).finally(() => clearTimeout(timer));
  try {
    assert.equal(client.exitError, null);
  } finally {
    await client.close();
  }
});

class RecordingClient extends AppServerClientBase {
  seen = [];
  handleLine(line) {
    this.seen.push(line);
  }
}

test("handleChunk buffers a line across chunk boundaries and flushes a last line without newline", () => {
  const client = new RecordingClient(process.cwd());
  const big = "x".repeat(200000);
  client.handleChunk(big.slice(0, 70000));
  client.handleChunk(big.slice(70000) + "\nnext");
  assert.deepEqual(client.seen, [big]);
  client.flushLineBuffer();
  assert.deepEqual(client.seen, [big, "next"]);
});

test("handleChunk fails loudly, with the size, when a line exceeds the limit", () => {
  const client = new AppServerClientBase(process.cwd());
  client.maxLineChars = 100;
  client.handleChunk("y".repeat(150));
  assert.match(client.exitError.message, /at least 150 characters.*limit is 100/);
  assert.equal(appServer.MAX_LINE_CHARS, 64 * 1024 * 1024);
});
