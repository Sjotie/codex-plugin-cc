// The publication step of macos-d-pty-probe.py --prepare-candidate (#1916):
// after a long green run it writes the fixtures, the evidence and the manifest
// to the checkout. It must never overwrite what it did not read, and never
// write outside the checkout; a refusal leaves everything as it was.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("./fenced-lock/macos-d-pty-probe.py", import.meta.url));
const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
const options = { skip: python ? false : "python3 not available" };
const MANIFEST = "plugins/codex/scripts/lib/provider-receipts.json";
const VERSION = "9.9.9";
const FIXTURES = `tests/fixtures/provider-receipts/claude-code-${VERSION}.json`;
const EVIDENCE = `docs/releases/claude-code-${VERSION}-receipt-evidence.json`;

const entry = (version) => ({ provider: "claude-code", version, platform: "darwin", arch: "arm64", receiptAdapter: "session-start-hook-success-v1",
  binarySha256: "a".repeat(64), evidenceCommit: "b".repeat(40), evidenceSummary: `docs/releases/claude-code-${version}-receipt-evidence.json`,
  evidenceSummarySha256: "c".repeat(64), fixtures: `tests/fixtures/provider-receipts/claude-code-${version}.json`, fixturesSha256: "d".repeat(64) });
const manifestText = (...versions) => JSON.stringify({ entries: versions.map(entry) }, null, 2) + "\n";

function checkout(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "publish-candidate-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  for (const dir of [path.dirname(MANIFEST), path.dirname(FIXTURES), path.dirname(EVIDENCE)]) fs.mkdirSync(path.join(repo, dir), { recursive: true });
  fs.writeFileSync(path.join(repo, MANIFEST), manifestText("2.1.301"));
  return { root, repo, read: (rel) => fs.readFileSync(path.join(repo, rel), "utf8"), exists: (rel) => fs.existsSync(path.join(repo, rel)) };
}

// Calls publish_candidate with the manifest bytes as read at the run's start.
function publish(c, startBytes, { failManifestReplace = false } = {}) {
  const input = path.join(c.root, "input.json");
  const candidate = { ...entry(VERSION), evidenceCommit: "0".repeat(40), evidenceSummarySha256: "0".repeat(64), fixturesSha256: "0".repeat(64) };
  fs.writeFileSync(input, JSON.stringify({ probe, repo: c.repo, startBytes, candidate, failManifestReplace }));
  const driver = `
import importlib.util, json, os, sys
a = json.load(open(sys.argv[1]))
spec = importlib.util.spec_from_file_location("probe", a["probe"]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
if a["failManifestReplace"]:
    real = os.replace
    def replace(src, dst, *rest, **kw):
        if str(dst).endswith("provider-receipts.json"):
            raise OSError("injected: manifest replace failed")
        return real(src, dst, *rest, **kw)
    os.replace = replace
try:
    written = m.publish_candidate(a["repo"], a["startBytes"].encode(), a["candidate"], "e" * 40, '{"shapes": 1}\\n', '{"evidence": 1}\\n')
    print(json.dumps({"ok": True, "written": written}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;
  const r = spawnSync(python, ["-I", "-B", "-c", driver, input], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

const leftovers = (c) => [path.dirname(MANIFEST), path.dirname(FIXTURES), path.dirname(EVIDENCE)]
  .flatMap((dir) => fs.readdirSync(path.join(c.repo, dir)).filter((n) => n.includes(".candidate-")));

test("publish: a clean checkout gets the fixtures, the evidence and the completed entry", options, (t) => {
  const c = checkout(t);
  const r = publish(c, c.read(MANIFEST));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.written.sort(), [EVIDENCE, FIXTURES, MANIFEST].sort());
  const entries = JSON.parse(c.read(MANIFEST)).entries;
  assert.deepEqual(entries.map((e) => e.version), ["2.1.301", VERSION]);
  assert.equal(entries[1].evidenceCommit, "e".repeat(40));
  assert.equal(c.read(FIXTURES), '{"shapes": 1}\n');
  assert.deepEqual(leftovers(c), []);
});

test("publish: an entry added to the manifest during the run is kept, and publication refuses", options, (t) => {
  const c = checkout(t);
  const start = c.read(MANIFEST);
  fs.writeFileSync(path.join(c.repo, MANIFEST), manifestText("2.1.301", "8.8.8"));
  const r = publish(c, start);
  assert.equal(r.ok, false);
  assert.match(r.error, /provider-receipts\.json changed during the run/);
  assert.equal(c.read(MANIFEST), manifestText("2.1.301", "8.8.8"));
  assert.equal(c.exists(FIXTURES), false);
  assert.equal(c.exists(EVIDENCE), false);
  assert.deepEqual(leftovers(c), []);
});

test("publish: an entry for the candidate version already in the manifest refuses", options, (t) => {
  const c = checkout(t);
  fs.writeFileSync(path.join(c.repo, MANIFEST), manifestText("2.1.301", VERSION));
  const r = publish(c, c.read(MANIFEST));
  assert.equal(r.ok, false);
  assert.match(r.error, /already listed/);
  assert.equal(c.read(MANIFEST), manifestText("2.1.301", VERSION));
  assert.equal(c.exists(FIXTURES), false);
});

for (const rel of [FIXTURES, EVIDENCE]) {
  test(`publish: an existing ${path.basename(path.dirname(rel))} target is never overwritten`, options, (t) => {
    const c = checkout(t);
    fs.writeFileSync(path.join(c.repo, rel), "earlier\n");
    const r = publish(c, c.read(MANIFEST));
    assert.equal(r.ok, false);
    assert.match(r.error, /already exists/);
    assert.equal(c.read(rel), "earlier\n");
    assert.equal(c.read(MANIFEST), manifestText("2.1.301"));
    for (const other of [FIXTURES, EVIDENCE].filter((x) => x !== rel)) assert.equal(c.exists(other), false);
    assert.deepEqual(leftovers(c), []);
  });
}

for (const existing of [true, false]) {
  test(`publish: a docs/releases symlink out of the checkout refuses${existing ? " and leaves the outside file" : ""}`, options, (t) => {
    const c = checkout(t);
    const outside = path.join(c.root, "outside");
    fs.mkdirSync(outside);
    if (existing) fs.writeFileSync(path.join(outside, path.basename(EVIDENCE)), "outside\n");
    fs.rmSync(path.join(c.repo, "docs/releases"), { recursive: true });
    fs.symlinkSync(outside, path.join(c.repo, "docs/releases"));
    const r = publish(c, c.read(MANIFEST));
    assert.equal(r.ok, false);
    assert.match(r.error, /outside the checkout/);
    assert.deepEqual(fs.readdirSync(outside), existing ? [path.basename(EVIDENCE)] : []);
    if (existing) assert.equal(fs.readFileSync(path.join(outside, path.basename(EVIDENCE)), "utf8"), "outside\n");
    assert.equal(c.read(MANIFEST), manifestText("2.1.301"));
    assert.equal(c.exists(FIXTURES), false);
  });
}

test("publish: a failing manifest write rolls back the files already placed", options, (t) => {
  const c = checkout(t);
  const r = publish(c, c.read(MANIFEST), { failManifestReplace: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /injected/);
  assert.equal(c.read(MANIFEST), manifestText("2.1.301"));
  assert.equal(c.exists(FIXTURES), false);
  assert.equal(c.exists(EVIDENCE), false);
  assert.deepEqual(leftovers(c), []);
});
