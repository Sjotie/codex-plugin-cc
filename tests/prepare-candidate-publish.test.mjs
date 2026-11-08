// The publication step of macos-d-pty-probe.py --prepare-candidate (#1916):
// after a long green run it writes the fixtures, the evidence and the manifest
// to the checkout. It must never overwrite what it did not read, and never
// write outside the checkout; a refusal leaves everything as it was.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("./fenced-lock/macos-d-pty-probe.py", import.meta.url));
const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
const options = { skip: process.platform === "win32" ? "the probe is macOS-only (pty)" : python ? false : "python3 not available" };
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
// prelude: Python run after the import, with m (the probe), a (the input), os,
// signal and time in scope; it injects a fault or a pause.
function driverInput(c, startBytes, { failManifestReplace = false, changeAfterLink = null, prelude = "", version = VERSION, name = "input" } = {}) {
  const input = path.join(c.root, `${name}.json`);
  const candidate = { ...entry(version), evidenceCommit: "0".repeat(40), evidenceSummarySha256: "0".repeat(64), fixturesSha256: "0".repeat(64) };
  fs.writeFileSync(input, JSON.stringify({ probe, repo: c.repo, root: c.root, startBytes, candidate, failManifestReplace, changeAfterLink, prelude }));
  return input;
}
const result = (stdout, stderr) => ({ ...JSON.parse(stdout.trim().split("\n").at(-1)), stderr });

function publish(c, startBytes, opts = {}) {
  const r = spawnSync(python, ["-I", "-B", "-c", DRIVER, driverInput(c, startBytes, opts)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return result(r.stdout, r.stderr);
}

function publishAsync(c, startBytes, opts) {
  const child = spawn(python, ["-I", "-B", "-c", DRIVER, driverInput(c, startBytes, opts)], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
  return new Promise((resolve) => child.once("close", (status) => { assert.equal(status, 0, stderr); resolve(result(stdout, stderr)); }));
}

const DRIVER = `
import importlib.util, json, os, signal, sys, time
a = json.load(open(sys.argv[1]))
spec = importlib.util.spec_from_file_location("probe", a["probe"]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
if a["failManifestReplace"]:
    real = os.replace
    def replace(src, dst, *rest, **kw):
        if str(dst).endswith("provider-receipts.json"):
            raise OSError("injected: manifest replace failed")
        return real(src, dst, *rest, **kw)
    os.replace = replace
if a["changeAfterLink"]:
    real_link = os.link
    def link(src, dst, *rest, **kw):
        real_link(src, dst, *rest, **kw)
        open(os.path.join(a["repo"], "plugins/codex/scripts/lib/provider-receipts.json"), "w").write(a["changeAfterLink"])
    os.link = link
exec(a["prelude"])
try:
    written = m.publish_candidate(a["repo"], a["startBytes"].encode(), a["candidate"], "e" * 40, '{"shapes": 1}\\n', '{"evidence": 1}\\n')
    print(json.dumps({"ok": True, "written": written}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;

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
    assert.match(r.error, new RegExp(`left by an earlier publication: ${rel.replace(/[.]/g, "\\.")}`));
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

test("publish: a manifest change while the new files are placed refuses and removes them", options, (t) => {
  const c = checkout(t);
  const changed = manifestText("2.1.301", "8.8.8");
  const r = publish(c, c.read(MANIFEST), { changeAfterLink: changed });
  assert.equal(r.ok, false);
  assert.match(r.error, /provider-receipts\.json changed during the run/);
  assert.equal(c.read(MANIFEST), changed);
  assert.equal(c.exists(FIXTURES), false);
  assert.equal(c.exists(EVIDENCE), false);
  assert.deepEqual(leftovers(c), []);
});

// The commit runs with SIGTERM/SIGHUP/SIGINT blocked: a signal that comes in
// during it is handled after it, and the publication is complete.
for (const [label, prelude] of [
  ...["SIGTERM", "SIGHUP", "SIGINT"].map((sig) => [`${sig} right after the first link`, `real_link = os.link
def link(src, dst, *rest, **kw):
    real_link(src, dst, *rest, **kw)
    os.kill(os.getpid(), signal.${sig})
os.link = link`]),
  ["SIGTERM right after the manifest rename", `real_replace = os.replace
def replace(src, dst, *rest, **kw):
    real_replace(src, dst, *rest, **kw)
    os.kill(os.getpid(), signal.SIGTERM)
os.replace = replace`]
]) {
  test(`publish: ${label} completes the publication, then is handled`, options, (t) => {
    const c = checkout(t);
    const r = publish(c, c.read(MANIFEST), { prelude });
    assert.equal(r.ok, true, r.error);
    assert.match(r.stderr, /signal \d+ came in during the commit; the publication is complete/);
    assert.deepEqual(JSON.parse(c.read(MANIFEST)).entries.map((e) => e.version), ["2.1.301", VERSION]);
    assert.equal(c.exists(FIXTURES), true);
    assert.equal(c.exists(EVIDENCE), true);
    assert.deepEqual(leftovers(c), []);
  });
}

test("publish: SIGTERM before the commit rolls back with nothing written", options, (t) => {
  const c = checkout(t);
  const r = publish(c, c.read(MANIFEST), { prelude: `real_lexists = os.path.lexists
def lexists(path):
    os.kill(os.getpid(), signal.SIGTERM)
    return real_lexists(path)
os.path.lexists = lexists` });
  assert.equal(r.ok, false);
  assert.match(r.error, /signal 15 during publication, before its commit; nothing written/);
  assert.equal(c.read(MANIFEST), manifestText("2.1.301"));
  assert.equal(c.exists(FIXTURES), false);
  assert.equal(c.exists(EVIDENCE), false);
  assert.deepEqual(leftovers(c), []);
});

test("publish: a rollback leaves a file it did not create and names it", options, (t) => {
  const c = checkout(t);
  // The second link fails after someone replaced the first linked file.
  const r = publish(c, c.read(MANIFEST), { prelude: `real_link = os.link
calls = []
def link(src, dst, *rest, **kw):
    calls.append(dst)
    if len(calls) == 2:
        other = os.path.join(a["root"], "foreign")
        open(other, "w").write("foreign\\n")
        os.replace(other, calls[0])
        raise OSError("injected: second link failed")
    return real_link(src, dst, *rest, **kw)
os.link = link` });
  assert.equal(r.ok, false);
  assert.match(r.error, /injected: second link failed/);
  assert.equal(c.read(FIXTURES), "foreign\n");
  assert.match(r.stderr, /left in place, not created by this run: .*claude-code-9\.9\.9\.json/);
  assert.equal(c.exists(EVIDENCE), false);
  assert.equal(c.read(MANIFEST), manifestText("2.1.301"));
  assert.deepEqual(leftovers(c), []);
});

test("publish: two publications from the same start never both succeed", options, async (t) => {
  const c = checkout(t);
  const start = c.read(MANIFEST);
  // Each pauses at its manifest rename until released; with the lock only one gets there.
  const prelude = `real_replace = os.replace
def replace(src, dst, *rest, **kw):
    if str(dst).endswith("provider-receipts.json"):
        open(os.path.join(a["root"], "ready-" + a["candidate"]["version"]), "w").write("")
        deadline = time.monotonic() + 10
        while not os.path.exists(os.path.join(a["root"], "release")):
            if time.monotonic() > deadline:
                raise RuntimeError("test barrier timeout")
            time.sleep(0.01)
    return real_replace(src, dst, *rest, **kw)
os.replace = replace`;
  const runs = [publishAsync(c, start, { prelude, version: "8.8.8", name: "a" }), publishAsync(c, start, { prelude, version: VERSION, name: "b" })];
  const ready = () => fs.readdirSync(c.root).filter((n) => n.startsWith("ready-"));
  let atRelease;
  try {
    // The first to reach the rename may take a while on a loaded machine; then
    // give the other a fixed interval in which it must not get there too.
    for (let i = 0; i < 6000 && ready().length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 1500));
    atRelease = ready().length;
  } finally {
    fs.writeFileSync(path.join(c.root, "release"), "");
  }
  const results = await Promise.all(runs);
  assert.equal(atRelease, 1, "only the lock holder reaches the rename");
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.match(results.find((r) => !r.ok).error, /changed during the run; nothing written/);
  const won = results[0].ok ? "8.8.8" : VERSION;
  assert.deepEqual(JSON.parse(c.read(MANIFEST)).entries.map((e) => e.version), ["2.1.301", won]);
  const artifacts = [path.dirname(FIXTURES), path.dirname(EVIDENCE)].flatMap((d) => fs.readdirSync(path.join(c.repo, d)));
  assert.deepEqual(artifacts.sort(), [`claude-code-${won}-receipt-evidence.json`, `claude-code-${won}.json`].sort());
});

test("publish: a lock held past the wait refuses with nothing written", options, async (t) => {
  const c = checkout(t);
  const holder = spawn(python, ["-I", "-B", "-c", `import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_RDONLY); fcntl.flock(fd, fcntl.LOCK_EX); print("held", flush=True); time.sleep(600)`, path.join(c.repo, path.dirname(MANIFEST))], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const r = publish(c, c.read(MANIFEST), { prelude: "m.PUBLISH_LOCK_WAIT_S = 0.3" });
  assert.equal(r.ok, false);
  assert.match(r.error, /holds the lock .* nothing written/);
  assert.equal(c.read(MANIFEST), manifestText("2.1.301"));
  assert.equal(c.exists(FIXTURES), false);
  assert.deepEqual(leftovers(c), []);
});

test("publish: a signal during a commit that then fails keeps the real error and rolls back", options, (t) => {
  const c = checkout(t);
  const changed = manifestText("2.1.301", "8.8.8");
  const r = publish(c, c.read(MANIFEST), { prelude: `real_link = os.link
def link(src, dst, *rest, **kw):
    real_link(src, dst, *rest, **kw)
    os.kill(os.getpid(), signal.SIGTERM)
    open(os.path.join(a["repo"], "plugins/codex/scripts/lib/provider-receipts.json"), "w").write(${JSON.stringify(changed)})
os.link = link` });
  assert.equal(r.ok, false);
  assert.match(r.error, /provider-receipts\.json changed during the run; nothing written/);
  assert.equal(c.read(MANIFEST), changed);
  assert.equal(c.exists(FIXTURES), false);
  assert.equal(c.exists(EVIDENCE), false);
  assert.deepEqual(leftovers(c), []);
});

test("publish: SIGTERM while waiting for the lock refuses with nothing written", options, async (t) => {
  const c = checkout(t);
  const holder = spawn(python, ["-I", "-B", "-c", `import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_RDONLY); fcntl.flock(fd, fcntl.LOCK_EX); print("held", flush=True); time.sleep(600)`, path.join(c.repo, path.dirname(MANIFEST))], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const r = publish(c, c.read(MANIFEST), { prelude: `import threading
threading.Timer(0.3, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()` });
  assert.equal(r.ok, false);
  assert.match(r.error, /signal 15 during publication, before its commit; nothing written/);
  assert.equal(c.read(MANIFEST), manifestText("2.1.301"));
  assert.equal(c.exists(FIXTURES), false);
});

test("publish: a second publication after the first finished refuses", options, (t) => {
  const c = checkout(t);
  const start = c.read(MANIFEST);
  assert.equal(publish(c, start).ok, true);
  const after = c.read(MANIFEST);
  const r = publish(c, start);
  assert.equal(r.ok, false);
  assert.match(r.error, /left by an earlier publication/);
  assert.equal(c.read(MANIFEST), after);
});

test("publish: a temp left by a killed publication is named, not overwritten", options, (t) => {
  const c = checkout(t);
  const stray = `${MANIFEST}.candidate-4242`;
  fs.writeFileSync(path.join(c.repo, stray), "stray\n");
  const r = publish(c, c.read(MANIFEST));
  assert.equal(r.ok, false);
  assert.match(r.error, new RegExp(`left by an earlier publication: ${stray.replace(/[.]/g, "\\.")}`));
  assert.equal(fs.readFileSync(path.join(c.repo, stray), "utf8"), "stray\n");
  assert.equal(c.read(MANIFEST), manifestText("2.1.301"));
});

test("publish: a signal that reaches another thread during the commit is handled after it", options, (t) => {
  const c = checkout(t);
  // The probe has live helper threads (transcript watches, the pty pump).
  const r = publish(c, c.read(MANIFEST), { prelude: `import threading
helper = threading.Thread(target=lambda: time.sleep(5), daemon=True)
helper.start()
real_link = os.link
def link(src, dst, *rest, **kw):
    real_link(src, dst, *rest, **kw)
    signal.pthread_kill(helper.ident, signal.SIGTERM)
    time.sleep(0.05)
os.link = link` });
  assert.equal(r.ok, true, r.error);
  assert.match(r.stderr, /signal 15 came in during the commit; the publication is complete/);
  assert.equal(c.exists(FIXTURES), true);
  assert.equal(c.exists(EVIDENCE), true);
  assert.deepEqual(JSON.parse(c.read(MANIFEST)).entries.map((e) => e.version), ["2.1.301", VERSION]);
});
