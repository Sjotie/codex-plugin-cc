import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const probe = fileURLToPath(new URL("./fixtures/final-publication.mjs", import.meta.url));

function publication(steps, waitMs = 60_000) {
  const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", probe, JSON.stringify({ steps, waitMs })], {
    encoding: "utf8", timeout: 10_000
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("final publication survives BUSY after transient admission beyond the ordinary deadline", () => {
  const out = publication([{ at: 0, error: "transient" }, { at: 11_000, error: "busy" }, { at: 11_500 }]);
  assert.equal(out.error, null);
  assert.equal(out.stored.status, "completed");
  assert.equal(out.stored.rendered, "preserved result");
  assert.equal(out.attempts, 3);
});

test("BUSY after transient admission still expires at the original admission deadline", () => {
  const out = publication([{ at: 0, error: "transient" }, { at: 59_500, error: "busy" }, { at: 60_000, error: "busy" }]);
  assert.equal(out.error?.code, "ESTATELOCKTIMEOUT");
  assert.equal(out.stored.status, "running");
  assert.equal(out.attempts, 3);
  assert.match(out.log, /preserved result/);
  assert.match(out.log, /was not published/);
});

test("BUSY without a transient admission retains the ordinary deadline", () => {
  const out = publication([{ at: 0, error: "busy" }, { at: 10_000, error: "busy" }]);
  assert.equal(out.error?.code, "ESTATELOCKTIMEOUT");
  assert.equal(out.attempts, 2);
});

test("disabled admission wait does not extend BUSY after a transient refusal", () => {
  const out = publication([{ at: 0, error: "transient" }, { at: 10_000, error: "busy" }], 0);
  assert.equal(out.error?.code, "ESTATELOCKTIMEOUT");
  assert.equal(out.attempts, 2);
});

test("a definitive refusal after transient admission stops publication immediately", () => {
  const out = publication([{ at: 0, error: "transient" }, { at: 500, error: "definitive" }]);
  assert.equal(out.error?.code, "ESTATELOCKREFUSED");
  assert.equal(out.attempts, 2);
  assert.equal(out.stored.status, "running");
});

test("a publication I/O failure after transient admission is not retried", () => {
  const out = publication([{ at: 0, error: "transient" }, { at: 500, error: "io" }]);
  assert.equal(out.error?.code, "EIO");
  assert.equal(out.attempts, 2);
});
