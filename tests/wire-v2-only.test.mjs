import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const guard = new URL("./fenced-lock/wire-v2-only.mjs", import.meta.url).href;
for (const [name, source, allowed] of [
  ["v2", "export const ENVELOPE_VERSION = 2;", true],
  ["v2 whitespace", "export const ENVELOPE_VERSION=2;", true],
  ["v3", "export const ENVELOPE_VERSION = 3;", false],
  ["v4", "export const ENVELOPE_VERSION = 4;", false],
  ["missing version", "", false],
  ["comment only", "// export const ENVELOPE_VERSION = 2;", false],
  ["ambiguous", "export const ENVELOPE_VERSION = 2;\nexport const ENVELOPE_VERSION = 4;", false]
]) {
  test(`wire-v2 harness guard: ${name}`, () => {
    const code = `import { requireWireV2 } from ${JSON.stringify(guard)}; requireWireV2(${JSON.stringify(source)}, "fixture"); console.log("ran");`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    assert.equal(result.status, allowed ? 0 : 2, result.stderr);
    assert.equal(result.stdout, allowed ? "ran\n" : "");
    if (!allowed) assert.match(result.stderr, /out of service/);
  });
}
