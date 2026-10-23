import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs";
import { createHash } from "node:crypto";

// Exact git blob from PRE_D_PRODUCT_REF, not an invented declaration.
const preD = fs.readFileSync(new URL("./fixtures/session-admission-pre-d.mjs.txt", import.meta.url));
assert.equal(createHash("sha1").update(`blob ${preD.length}\0`).update(preD).digest("hex"), "4155409a29102697cd70263af006c106ca6a97a1");
const guard = new URL("./fenced-lock/wire-v2-only.mjs", import.meta.url).href;
for (const [name, source, allowed] of [
  ["actual pre-D blob", preD.toString("utf8"), true],
  ["modified pre-D blob", preD.toString("utf8") + "\n", false],
  ["invented v2 declaration", "export const ENVELOPE_VERSION = 2;", false],
  ["block comment only", "/*\nexport const ENVELOPE_VERSION = 2;\n*/", false],
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
