// #1762 installer tests on a fake HOME. Needs CX1762_ORIGIN: a local clone of Sjotie/codex-plugin-cc that has
// 943b1a9 (sjotie.23), 1e234e3 and branch release/1762-sjotie.24 (9d0dcc1). CX1762_SCRIPT picks the script under test.
// Test dependencies (a write between read and rename, stub lifetime, a pause before cleanup) go in through
// tests/harness.mjs, which calls the script's main(); the script itself reads no test hooks.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.CX1762_SCRIPT ?? path.join(here, "../scripts/1762-install.mjs");
const ORIGIN = process.env.CX1762_ORIGIN ?? assert.fail("CX1762_ORIGIN ontbreekt");
const V23 = "1.0.7-sjotie.23", S23 = "943b1a908f0859e10ee1822ca9843ccd99fec483";
const V24 = "1.0.7-sjotie.24", S24 = "9d0dcc16f719e132fbc2eac20588f6837ee429c2", B24 = "release/1762-sjotie.24";
const S_MOVED = "1e234e3c35052bf82cb731b8aef0ae44dd4cd8b3";
const A24 = ["--version", V24, "--sha", S24];
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Fake HOME: ~/.claude/plugins with marketplace on main@943b1a9, cache 1.0.7-sjotie.23, two codex entries and one other
 *  plugin; accounts in `shared` symlink their plugins to it, accounts in `own` get a copy of their own. */
function fakeHome({ shared = ["tiemdev", "a"], own = [] } = {}) {
  const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cx1762t-")));
  const P = path.join(H, ".claude/plugins");
  const acc = path.join(H, ".homebase/factory-acp/accounts/claude");
  fs.mkdirSync(path.join(P, "marketplaces"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--shared", ORIGIN, path.join(P, "marketplaces/openai-codex")]);
  git(path.join(P, "marketplaces/openai-codex"), "checkout", "-q", "-B", "main", S23);
  const cache = path.join(P, "cache/openai-codex/codex", V23);
  fs.mkdirSync(cache, { recursive: true });
  execFileSync("tar", ["-x", "-C", cache, "--strip-components=2"], { input: execFileSync("git", ["archive", S23, "plugins/codex"], { cwd: ORIGIN, maxBuffer: 256 << 20 }) });
  const ip = path.join(acc, "tiemdev/plugins/cache/openai-codex/codex", V23);
  fs.writeFileSync(path.join(P, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "codex@openai-codex": [
      { scope: "user", installPath: ip, version: V23, installedAt: "2026-10-11T00:00:00.000Z", lastUpdated: "2026-10-21T00:00:00.000Z", gitCommitSha: S23 },
      { scope: "project", projectPath: H, installPath: ip, version: V23, installedAt: "2026-10-13T00:00:00.000Z", lastUpdated: "2026-10-21T00:00:01.000Z", gitCommitSha: S23 }
    ],
    "other@elsewhere": [{ scope: "user", installPath: "/x/other", version: "1.0.0", gitCommitSha: "a".repeat(40) }]
  } }, null, 2));
  fs.writeFileSync(path.join(P, "known_marketplaces.json"), JSON.stringify({ "openai-codex": { source: { source: "github", repo: "Sjotie/codex-plugin-cc" }, installLocation: path.join(P, "marketplaces/openai-codex") } }));
  for (const a of shared) { fs.mkdirSync(path.join(acc, a), { recursive: true }); fs.symlinkSync(P, path.join(acc, a, "plugins")); }
  for (const a of own) {
    fs.mkdirSync(path.join(acc, a), { recursive: true });
    const own = path.join(acc, a, "plugins");
    execFileSync("cp", ["-a", P, own]);
    const f = path.join(own, "installed_plugins.json"), d = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const e of d.plugins["codex@openai-codex"]) e.installPath = path.join(own, "cache/openai-codex/codex", V23);
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
  }
  return { H, P, market: path.join(P, "marketplaces/openai-codex"), installed: path.join(P, "installed_plugins.json"), ip23: ip };
}
/** Runs the installer as a CLI; with `harness`, through tests/harness.mjs with those injected dependencies. */
function run(H, argv, { env = {}, nodeArgs = [], harness = null } = {}) {
  const target = harness ? [path.join(here, "harness.mjs"), JSON.stringify(harness)] : [SCRIPT];
  const r = spawnSync(process.execPath, [...nodeArgs, ...target, ...argv], { env: { ...process.env, HOME: H, CX1762_SCRIPT: SCRIPT, ...env }, encoding: "utf8", timeout: 180_000 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
const apply = (f, extra = []) => run(f.H, ["apply", ...A24, "--branch", B24, ...extra]);
const codex = (f, file = f.installed) => JSON.parse(fs.readFileSync(file, "utf8")).plugins["codex@openai-codex"];
const plugins = (f) => JSON.parse(fs.readFileSync(f.installed, "utf8")).plugins;
const rows = (out) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
const restoreFile = (f) => path.join(f.P, `codex-restore-1762-${V24}.json`);
const addCodexEntry = (f, entry) => {
  const d = JSON.parse(fs.readFileSync(f.installed, "utf8"));
  d.plugins["codex@openai-codex"].push(entry);
  fs.writeFileSync(f.installed, JSON.stringify(d, null, 2));
};
const spyRows = (log) => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ---- round 1 and 2 cases --------------------------------------------------------------------------------------------

test("happy path: plan writes nothing, apply, second apply changes nothing, verify, proof, undo restores", () => {
  const f = fakeHome({ own: ["c"] });
  const before = fs.readFileSync(f.installed, "utf8");
  const plan = run(f.H, ["plan", ...A24, "--branch", B24]);
  assert.equal(plan.code, 0, plan.out);
  assert.equal(fs.readFileSync(f.installed, "utf8"), before);
  assert.equal(git(f.market, "rev-parse", "HEAD"), S23);
  let r = apply(f); assert.equal(r.code, 0, r.out);
  r = apply(f); assert.equal(r.code, 0, r.out); assert.match(r.out, /toegepast: 0 wijziging/);
  r = run(f.H, ["verify", ...A24]); assert.equal(r.code, 0, r.out);
  assert.equal(rows(r.out).length, 4, r.out); // .claude, a, c, tiemdev
  r = run(f.H, ["proof", "--version", V24]); assert.equal(r.code, 0, r.out);
  r = run(f.H, ["undo", "--version", V24]); assert.equal(r.code, 0, r.out);
  assert.deepEqual(codex(f).map((e) => [e.version, e.gitCommitSha]), [[V23, S23], [V23, S23]]);
  assert.equal(git(f.market, "rev-parse", "HEAD"), S23);
  assert.equal(git(f.market, "symbolic-ref", "--short", "HEAD"), "main");
  assert.ok(plugins(f)["other@elsewhere"]);
});

test("r1 P2-1: a plugin installed after apply survives undo", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  const d = JSON.parse(fs.readFileSync(f.installed, "utf8"));
  d.plugins["new@market"] = [{ scope: "user", installPath: "/x/new", version: "2.0.0", gitCommitSha: "b".repeat(40) }];
  fs.writeFileSync(f.installed, JSON.stringify(d, null, 2));
  const r = run(f.H, ["undo", "--version", V24]);
  assert.ok(plugins(f)["new@market"], `new plugin gone after undo:\n${r.out}`);
  assert.deepEqual(codex(f).map((e) => e.version), [V23, V23]);
});

test("r1 P2-1: a plugin installed between read and rename survives apply (injected write)", () => {
  const f = fakeHome();
  const mutate = path.join(f.H, "mutate.mjs"), ran = path.join(f.H, "mutate.ran");
  fs.writeFileSync(mutate, `import fs from "node:fs"; if (!fs.existsSync(${JSON.stringify(ran)})) { const p = ${JSON.stringify(f.installed)};
    const d = JSON.parse(fs.readFileSync(p, "utf8")); d.plugins["race@market"] = [{ scope: "user", installPath: "/x/race", version: "3.0.0" }];
    fs.writeFileSync(p, JSON.stringify(d, null, 2)); fs.writeFileSync(${JSON.stringify(ran)}, "1"); }\n`);
  const r = run(f.H, ["apply", ...A24, "--branch", B24], { harness: { beforeRenameScript: mutate } });
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(ran), "injected write did not run");
  assert.ok(plugins(f)["race@market"], "plugin installed during apply was lost");
  assert.deepEqual(codex(f).map((e) => e.version), [V24, V24]);
});

test("r1 P2-1: undo leaves a codex entry alone that changed since apply", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  const d = JSON.parse(fs.readFileSync(f.installed, "utf8"));
  Object.assign(d.plugins["codex@openai-codex"][0], { version: "1.0.7-sjotie.25", gitCommitSha: "c".repeat(40) });
  fs.writeFileSync(f.installed, JSON.stringify(d, null, 2));
  const r = run(f.H, ["undo", "--version", V24]);
  assert.notEqual(r.code, 0, r.out);
  assert.deepEqual(codex(f).map((e) => e.version), ["1.0.7-sjotie.25", V23]);
});

test("r1 P2-3: a marketplace moved after apply: reapply refuses, the restore point keeps the original HEAD, undo leaves the moved checkout", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  git(f.market, "checkout", "-q", "--detach", S_MOVED); // e.g. an auto-update
  let r = apply(f);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(JSON.parse(fs.readFileSync(restoreFile(f), "utf8")).marketplace.head, S23);
  r = run(f.H, ["undo", "--version", V24]);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(git(f.market, "rev-parse", "HEAD"), S_MOVED);
  assert.ok(fs.existsSync(restoreFile(f)), "restore point dropped after an incomplete undo");
});

test("r1 P2-2: proof never signals a stored pid (no process.kill), also when its children end early", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  const log = path.join(f.H, "spy.log");
  fs.writeFileSync(log, "");
  // Every stub ends on its own (600 ms) before the cleanup starts (1500 ms after the last measurement).
  const r = run(f.H, ["proof", "--version", V24], { nodeArgs: ["--import", path.join(here, "preload-spy.mjs")],
    env: { CX1762_SPY_LOG: log }, harness: { stubLifetimeMs: 600, stopDelayMs: 1500 } });
  const spy = spyRows(log);
  assert.deepEqual(spy.filter((x) => x.kind === "process.kill"), [], r.out);
  assert.equal(r.code, 0, r.out);
  assert.ok(spy.filter((x) => x.kind === "spawn" && x.file === process.execPath).length >= 3, r.out);
  const ends = rows(r.out).filter((x) => x.opruimen).map((x) => x.opruimen.einde);
  assert.ok(ends.includes("al beëindigd"), r.out);
  assert.ok(!ends.includes("loopt nog"), r.out);
});

test("r1 P3: proof gives children a minimal environment and checks marker and CLAUDE_CONFIG_DIR", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  const log = path.join(f.H, "spy.log");
  fs.writeFileSync(log, "");
  const r = run(f.H, ["proof", "--version", V24], { nodeArgs: ["--import", path.join(here, "preload-spy.mjs")], env: { CX1762_SPY_LOG: log, CX1762_UNRELATED: "1" } });
  assert.equal(r.code, 0, r.out);
  const spawns = spyRows(log).filter((x) => x.kind === "spawn" && x.file === process.execPath);
  assert.ok(spawns.length >= 2, r.out);
  for (const s of spawns) assert.ok(!s.envKeys.includes("CX1762_UNRELATED"), `child got the inherited environment: ${s.envKeys.join(",")}`);
  const accounts = rows(r.out).filter((x) => x.account);
  assert.ok(accounts.length >= 3);
  for (const a of accounts) { assert.equal(a.marker, true, r.out); assert.equal(a.configDir, true, r.out); assert.equal(a.tag, null, r.out); }
});

test("r1 P3: no homes at all is red for verify and proof", () => {
  const H = fs.mkdtempSync(path.join(os.tmpdir(), "cx1762e-"));
  assert.notEqual(run(H, ["verify", ...A24]).code, 0);
  assert.notEqual(run(H, ["proof", "--version", V24]).code, 0);
});

test("r1 P3: a config home without plugins is red unless skipped by name", () => {
  const f = fakeHome();
  fs.mkdirSync(path.join(f.H, ".claude-extra"));
  fs.mkdirSync(path.join(f.H, ".homebase/factory-acp/accounts/claude/empty"));
  let r = apply(f);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /\.claude-extra/); assert.match(r.out, /accounts\/claude\/empty/);
  assert.deepEqual(codex(f).map((e) => e.version), [V23, V23]);
  const skip = ["--skip-home", path.join(f.H, ".claude-extra"), "--skip-home", path.join(f.H, ".homebase/factory-acp/accounts/claude/empty")];
  r = apply(f, skip); assert.equal(r.code, 0, r.out);
  r = run(f.H, ["verify", ...A24]); assert.notEqual(r.code, 0, r.out);
  r = run(f.H, ["verify", ...A24, ...skip]); assert.equal(r.code, 0, r.out);
});

test("r1 P3: verify compares the cache with the archive, not a substring", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  fs.appendFileSync(path.join(f.P, "cache/openai-codex/codex", V24, "CHANGELOG.md"), "x\n");
  assert.notEqual(run(f.H, ["verify", ...A24]).code, 0);
});

test("r1 P3: an invalid version is refused before anything is written", () => {
  const f = fakeHome();
  const before = fs.readFileSync(f.installed, "utf8");
  const cacheBefore = fs.readdirSync(path.join(f.P, "cache/openai-codex"));
  const r = run(f.H, ["apply", "--version", "../../x", "--sha", S24, "--branch", B24]);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(fs.readFileSync(f.installed, "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.join(f.P, "cache/openai-codex")), cacheBefore);
  assert.equal(git(f.market, "rev-parse", "HEAD"), S23);
});

test("r1 P3: an installPath that resolves outside the cache is refused before anything is written", () => {
  const f = fakeHome();
  const cache23 = path.join(f.P, "cache/openai-codex/codex", V23);
  const elsewhere = path.join(f.H, "elsewhere");
  fs.renameSync(cache23, elsewhere);
  fs.symlinkSync(elsewhere, cache23);
  const before = fs.readFileSync(f.installed, "utf8");
  const r = apply(f);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(fs.readFileSync(f.installed, "utf8"), before);
  assert.equal(git(f.market, "rev-parse", "HEAD"), S23);
  assert.ok(!fs.existsSync(path.join(f.P, "cache/openai-codex/codex", V24)));
});

test("r2 self-review: undo removes a field that did not exist before apply", () => {
  const f = fakeHome();
  const d = JSON.parse(fs.readFileSync(f.installed, "utf8"));
  for (const e of d.plugins["codex@openai-codex"]) delete e.gitCommitSha;
  fs.writeFileSync(f.installed, JSON.stringify(d, null, 2));
  assert.equal(apply(f).code, 0);
  assert.deepEqual(codex(f).map((e) => e.gitCommitSha), [S24, S24]);
  const r = run(f.H, ["undo", "--version", V24]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(codex(f).map((e) => ["gitCommitSha" in e, e.version]), [[false, V23], [false, V23]]);
});

test("r2 self-review: a dangling symlink at the cache path is refused before anything is written", () => {
  const f = fakeHome();
  fs.symlinkSync(path.join(f.H, "gone"), path.join(f.P, "cache/openai-codex/codex", V24));
  const before = fs.readFileSync(f.installed, "utf8");
  const r = apply(f);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /FOUT/);
  assert.equal(fs.readFileSync(f.installed, "utf8"), before);
  assert.equal(git(f.market, "rev-parse", "HEAD"), S23);
  assert.ok(!fs.readdirSync(f.P).some((n) => n.startsWith("codex-restore-1762")));
});

test("r2 self-review: a differing cache in the second plugins directory stops apply before the first is touched", () => {
  const f = fakeHome({ own: ["z"] });
  const own = path.join(f.H, ".homebase/factory-acp/accounts/claude/z/plugins");
  const bad = path.join(own, "cache/openai-codex/codex", V24);
  fs.mkdirSync(bad); fs.writeFileSync(path.join(bad, "stray"), "x");
  git(path.join(own, "marketplaces/openai-codex"), "fetch", "-q", "origin", B24); // sha local, so phase 1 can compare
  const before = fs.readFileSync(f.installed, "utf8");
  const r = apply(f);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /verschilt/);
  assert.equal(fs.readFileSync(f.installed, "utf8"), before);
  assert.equal(git(f.market, "rev-parse", "HEAD"), S23);
});

test("r2 self-review: an untracked file in a marketplace already at the sha does not block apply", () => {
  const f = fakeHome();
  git(f.market, "fetch", "-q", "origin", B24);
  git(f.market, "checkout", "-q", "--detach", S24);
  fs.writeFileSync(path.join(f.market, "untracked.txt"), "x");
  const r = apply(f);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(codex(f).map((e) => e.version), [V24, V24]);
});

// ---- round 3 cases (Sol NO-GO on 6af80487) --------------------------------------------------------------------------

test("r3 P2-1: apply and undo refuse while another run holds the lock, and change nothing", () => {
  const f = fakeHome();
  fs.mkdirSync(path.join(f.P, "codex-1762-install.lock"));
  const before = fs.readFileSync(f.installed, "utf8");
  let r = apply(f);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(fs.readFileSync(f.installed, "utf8"), before);
  assert.equal(git(f.market, "rev-parse", "HEAD"), S23);
  assert.ok(!fs.existsSync(restoreFile(f)));
  r = run(f.H, ["undo", "--version", V24]);
  assert.notEqual(r.code, 0, r.out);
});

test("r4 P2: a held lock never reads or prints a file outside it (owner symlink, symlinked lock directory)", () => {
  const f = fakeHome();
  // The sentinel has the exact owner format, so only the symlink guards (not the format check) keep it out.
  const sentinel = path.join(f.H, "outside-secret.txt");
  fs.writeFileSync(sentinel, "pid 1 op SENTINEL-1762 sinds 2026-01-01T00:00:00.000Z\n");
  const lock = path.join(f.P, "codex-1762-install.lock");
  fs.mkdirSync(lock);
  fs.symlinkSync(sentinel, path.join(lock, "owner"));
  let r = apply(f);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /eigenaar onleesbaar/, r.out);
  assert.ok(!r.out.includes("SENTINEL-1762"), `outside file printed:\n${r.out}`);
  r = run(f.H, ["undo", "--version", V24]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /bestaat/, r.out);
  assert.ok(!r.out.includes("SENTINEL-1762"), `outside file printed by undo:\n${r.out}`);
  // A lock directory that is itself a symlink to a directory holding an owner file.
  fs.rmSync(lock, { recursive: true });
  const outsideDir = path.join(f.H, "outside-dir");
  fs.mkdirSync(outsideDir);
  fs.copyFileSync(sentinel, path.join(outsideDir, "owner"));
  fs.symlinkSync(outsideDir, lock);
  r = apply(f);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /geen gewone map/, r.out);
  assert.ok(!r.out.includes("SENTINEL-1762"), `outside file printed via a symlinked lock:\n${r.out}`);
  assert.equal(codex(f)[0].version, V23);
});

test("r4 self-review: a real owner record of a held lock is shown, also with a long hostname", () => {
  const f = fakeHome();
  const lock = path.join(f.P, "codex-1762-install.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner"), `pid 4242 op ${"h".repeat(80)}.local sinds 2026-11-02T00:00:00.000Z\n`);
  const r = apply(f);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /pid 4242 op h{80}\.local/, r.out);
});

test("r3 P2-2: reapply refuses when a codex entry the restore point does not know appeared, and changes nothing", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  addCodexEntry(f, { scope: "project", projectPath: "/x/other-project", installPath: f.ip23, version: V23, gitCommitSha: S23, lastUpdated: "2026-11-01T00:00:00.000Z" });
  const before = fs.readFileSync(f.installed, "utf8");
  const r = apply(f);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(fs.readFileSync(f.installed, "utf8"), before);
});

test("r3 P2-2: an undo that cannot set everything back fails and keeps the restore point", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  addCodexEntry(f, { scope: "project", projectPath: "/x/other-project", installPath: path.join(path.dirname(f.ip23), V24), version: V24, gitCommitSha: S24, lastUpdated: "2026-11-01T00:00:00.000Z" });
  const r = run(f.H, ["undo", "--version", V24]);
  assert.notEqual(r.code, 0, r.out);
  assert.ok(fs.existsSync(restoreFile(f)), "restore point renamed after an incomplete undo");
});

// Regression for the pid-based names of 104bf1b/6af8048 (red there: the victim was overwritten). Temp names are now
// random, so this no longer reaches the O_EXCL/O_NOFOLLOW path; the two fixedTmpSuffix tests below cover that.
test("r3 P2-3: a symlink at the old pid-based temporary name is never written through", () => {
  const f = fakeHome();
  const victim = path.join(f.H, "victim.txt");
  fs.writeFileSync(victim, "VICTIM\n");
  // The shell plants symlinks at the names a run with its pid ($$, kept by exec) would use, then becomes the installer.
  const r = spawnSync("sh", ["-c", 'v="$1"; a="$2"; b="$3"; shift 3; ln -s "$v" "$a.tmp-1762-$$" && ln -s "$v" "$b.tmp-1762-$$" && exec "$@"',
    "sh", victim, restoreFile(f), f.installed, process.execPath, SCRIPT, "apply", ...A24, "--branch", B24],
    { env: { ...process.env, HOME: f.H }, encoding: "utf8", timeout: 180_000 });
  assert.equal(fs.readFileSync(victim, "utf8"), "VICTIM\n", (r.stdout ?? "") + (r.stderr ?? ""));
  assert.equal(r.status, 0, (r.stdout ?? "") + (r.stderr ?? "")); // the install itself went through
  assert.deepEqual(codex(f).map((e) => e.version), [V24, V24]);
});

test("r3 P2-3: a symlink planted at the temporary name of the restore point is refused, nothing is written through it", () => {
  const f = fakeHome();
  const victim = path.join(f.H, "victim.txt");
  fs.writeFileSync(victim, "VICTIM\n");
  fs.symlinkSync(victim, `${restoreFile(f)}.tmp-planted`);
  const before = fs.readFileSync(f.installed, "utf8");
  const r = run(f.H, ["apply", ...A24, "--branch", B24], { harness: { fixedTmpSuffix: ".tmp-planted" } });
  assert.notEqual(r.code, 0, r.out);
  assert.equal(fs.readFileSync(victim, "utf8"), "VICTIM\n", r.out);
  assert.equal(fs.readFileSync(f.installed, "utf8"), before);
  assert.equal(git(f.market, "rev-parse", "HEAD"), S23);
});

test("r3 P2-3: a symlink planted at the temporary name of installed_plugins.json is refused before that write; undo then completes", () => {
  const f = fakeHome();
  const victim = path.join(f.H, "victim.txt");
  fs.writeFileSync(victim, "VICTIM\n");
  fs.symlinkSync(victim, `${f.installed}.tmp-planted`);
  const before = fs.readFileSync(f.installed, "utf8");
  let r = run(f.H, ["apply", ...A24, "--branch", B24], { harness: { fixedTmpSuffix: ".tmp-planted" } });
  assert.notEqual(r.code, 0, r.out);
  assert.equal(fs.readFileSync(victim, "utf8"), "VICTIM\n", r.out);
  assert.equal(fs.readFileSync(f.installed, "utf8"), before);
  assert.equal(git(f.market, "rev-parse", "HEAD"), S23, "checkout moved although installed_plugins.json was not written");
  r = run(f.H, ["undo", "--version", V24]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(restoreFile(f)));
});

test("r3 self-review: two codex entries with the same scope and projectPath are refused before anything is written", () => {
  const f = fakeHome();
  addCodexEntry(f, { scope: "user", installPath: f.ip23, version: V23, gitCommitSha: S23 });
  const before = fs.readFileSync(f.installed, "utf8");
  const r = apply(f);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /dezelfde scope/);
  assert.equal(fs.readFileSync(f.installed, "utf8"), before);
});

test("r3 self-review: a restore point of another schema is refused by apply and undo", () => {
  const f = fakeHome();
  fs.writeFileSync(restoreFile(f), JSON.stringify({ version: V24, sha: S24, marketplace: { head: S23, branch: "main" }, entries: [] }));
  const before = fs.readFileSync(f.installed, "utf8");
  let r = apply(f);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /schema/);
  assert.equal(fs.readFileSync(f.installed, "utf8"), before);
  r = run(f.H, ["undo", "--version", V24]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /schema/);
});

test("r3 P3: undo sets lastUpdated back to what it was", () => {
  const f = fakeHome();
  const before = codex(f).map((e) => e.lastUpdated);
  assert.equal(apply(f).code, 0);
  const r = run(f.H, ["undo", "--version", V24]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(codex(f).map((e) => e.lastUpdated), before);
});

test("r3 P3: proof is red when one codex entry of an account is not on the version", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  addCodexEntry(f, { scope: "project", projectPath: "/x/other-project", installPath: f.ip23, version: V23, gitCommitSha: S23 });
  const r = run(f.H, ["proof", "--version", V24]);
  assert.notEqual(r.code, 0, r.out);
});

test("r3 P3: the script honours no test hooks from the environment", () => {
  const f = fakeHome();
  const mutate = path.join(f.H, "mutate.mjs"), ran = path.join(f.H, "mutate.ran");
  fs.writeFileSync(mutate, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(ran)}, "1");\n`);
  const r = run(f.H, ["apply", ...A24, "--branch", B24], { env: { CX1762_TEST_HOOKS: JSON.stringify({ execBeforeRename: [process.execPath, mutate] }) } });
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(ran), "a command from the environment ran during apply");
});

test("r3 P4: proof reports the end of every child it started", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  const r = run(f.H, ["proof", "--version", V24]);
  assert.equal(r.code, 0, r.out);
  const ends = rows(r.out).filter((x) => x.opruimen);
  assert.ok(ends.length >= 4, r.out); // control + .claude, a, tiemdev
  for (const e of ends) { assert.equal(typeof e.opruimen.pid, "number", r.out); assert.ok(e.opruimen.einde, r.out); }
});
