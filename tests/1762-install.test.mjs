// #1762 installer tests on a fake HOME. Needs CX1762_ORIGIN: a local clone of Sjotie/codex-plugin-cc that has
// 943b1a9 (sjotie.23), 1e234e3 and branch release/1762-sjotie.24 (9d0dcc1). CX1762_SCRIPT picks the script under test.
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
      { scope: "project", projectPath: H, installPath: ip, version: V23, installedAt: "2026-10-13T00:00:00.000Z", lastUpdated: "2026-10-21T00:00:00.000Z", gitCommitSha: S23 }
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
  return { H, P, market: path.join(P, "marketplaces/openai-codex"), installed: path.join(P, "installed_plugins.json") };
}
function run(H, argv, { env = {}, nodeArgs = [] } = {}) {
  const r = spawnSync(process.execPath, [...nodeArgs, SCRIPT, ...argv], { env: { ...process.env, HOME: H, ...env }, encoding: "utf8", timeout: 180_000 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
const apply = (f, extra = []) => run(f.H, ["apply", ...A24, "--branch", B24, ...extra]);
const codex = (f, file = f.installed) => JSON.parse(fs.readFileSync(file, "utf8")).plugins["codex@openai-codex"];
const plugins = (f) => JSON.parse(fs.readFileSync(f.installed, "utf8")).plugins;
const rows = (out) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

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

test("P2-1: a plugin installed after apply survives undo", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  const d = JSON.parse(fs.readFileSync(f.installed, "utf8"));
  d.plugins["new@market"] = [{ scope: "user", installPath: "/x/new", version: "2.0.0", gitCommitSha: "b".repeat(40) }];
  fs.writeFileSync(f.installed, JSON.stringify(d, null, 2));
  const r = run(f.H, ["undo", "--version", V24]);
  assert.ok(plugins(f)["new@market"], `new plugin gone after undo:\n${r.out}`);
  assert.deepEqual(codex(f).map((e) => e.version), [V23, V23]);
});

test("P2-1: a plugin installed between read and rename survives apply", () => {
  const f = fakeHome();
  const mutate = path.join(f.H, "mutate.mjs"), ran = path.join(f.H, "mutate.ran");
  fs.writeFileSync(mutate, `import fs from "node:fs"; if (!fs.existsSync(${JSON.stringify(ran)})) { const p = ${JSON.stringify(f.installed)};
    const d = JSON.parse(fs.readFileSync(p, "utf8")); d.plugins["race@market"] = [{ scope: "user", installPath: "/x/race", version: "3.0.0" }];
    fs.writeFileSync(p, JSON.stringify(d, null, 2)); fs.writeFileSync(${JSON.stringify(ran)}, "1"); }\n`);
  const r = run(f.H, ["apply", ...A24, "--branch", B24], { env: { CX1762_TEST_HOOKS: JSON.stringify({ execBeforeRename: [process.execPath, mutate] }) } });
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(ran), "hook did not run");
  assert.ok(plugins(f)["race@market"], "plugin installed during apply was lost");
  assert.deepEqual(codex(f).map((e) => e.version), [V24, V24]);
});

test("P2-1: undo leaves a codex entry alone that changed since apply", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  const d = JSON.parse(fs.readFileSync(f.installed, "utf8"));
  Object.assign(d.plugins["codex@openai-codex"][0], { version: "1.0.7-sjotie.25", gitCommitSha: "c".repeat(40) });
  fs.writeFileSync(f.installed, JSON.stringify(d, null, 2));
  const r = run(f.H, ["undo", "--version", V24]);
  assert.notEqual(r.code, 0, r.out);
  assert.deepEqual(codex(f).map((e) => e.version), ["1.0.7-sjotie.25", V23]);
});

test("P2-3: the restore point survives a marketplace move between two applies", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  git(f.market, "checkout", "-q", "--detach", S_MOVED); // e.g. an auto-update
  let r = apply(f); assert.equal(r.code, 0, r.out);
  r = run(f.H, ["undo", "--version", V24]);
  assert.equal(git(f.market, "rev-parse", "HEAD"), S23, r.out);
});

test("P2-2: proof never signals a stored pid (no process.kill), also when its children end early", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  const log = path.join(f.H, "spy.log");
  fs.writeFileSync(log, "");
  const r = run(f.H, ["proof", "--version", V24], { nodeArgs: ["--import", path.join(here, "preload-spy.mjs")],
    // Every stub ends on its own (600 ms) before the cleanup starts (1500 ms after the last measurement).
    env: { CX1762_SPY_LOG: log, CX1762_TEST_HOOKS: JSON.stringify({ stubLifetimeMs: 600, stopDelayMs: 1500 }) } });
  const spy = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(spy.filter((x) => x.kind === "process.kill"), [], r.out);
  // The proof really ran: children were spawned, measured, and some had already ended before the cleanup.
  assert.equal(r.code, 0, r.out);
  assert.ok(spy.filter((x) => x.kind === "spawn" && x.file === process.execPath).length >= 3, r.out);
  const ends = rows(r.out).find((x) => x.opruimen)?.opruimen;
  assert.ok(ends?.["al beëindigd"] >= 1, r.out);
  assert.equal(ends?.["loopt nog"], undefined, r.out);
});

test("self-review: undo removes a field that did not exist before apply", () => {
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

test("self-review: a dangling symlink at the cache path is refused before anything is written", () => {
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

test("self-review: a differing cache in the second plugins directory stops apply before the first is touched", () => {
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

test("self-review: an untracked file in a marketplace already at the sha does not block apply", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  fs.writeFileSync(path.join(f.market, "untracked.txt"), "x");
  const d = JSON.parse(fs.readFileSync(f.installed, "utf8"));
  d.plugins["codex@openai-codex"][0].version = V23; // something for the second apply to do
  fs.writeFileSync(f.installed, JSON.stringify(d, null, 2));
  const r = apply(f);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(codex(f).map((e) => e.version), [V24, V24]);
});

test("self-review: test hooks are ignored when HOME is not under the temporary directory", () => {
  const f = fakeHome();
  const otherTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cx1762o-"));
  const mutate = path.join(f.H, "mutate.mjs"), ran = path.join(f.H, "mutate.ran");
  fs.writeFileSync(mutate, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(ran)}, "1");\n`);
  const r = run(f.H, ["apply", ...A24, "--branch", B24], { env: { TMPDIR: otherTmp, CX1762_TEST_HOOKS: JSON.stringify({ execBeforeRename: [process.execPath, mutate] }) } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /genegeerd/);
  assert.ok(!fs.existsSync(ran), "hook ran in a non-test HOME");
});

test("P3: proof gives children a minimal environment and checks marker and CLAUDE_CONFIG_DIR", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  const log = path.join(f.H, "spy.log");
  fs.writeFileSync(log, "");
  const r = run(f.H, ["proof", "--version", V24], { nodeArgs: ["--import", path.join(here, "preload-spy.mjs")], env: { CX1762_SPY_LOG: log, CX1762_UNRELATED: "1" } });
  assert.equal(r.code, 0, r.out);
  const spawns = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.kind === "spawn" && x.file === process.execPath);
  assert.ok(spawns.length >= 2, r.out);
  for (const s of spawns) assert.ok(!s.envKeys.includes("CX1762_UNRELATED"), `child got the inherited environment: ${s.envKeys.join(",")}`);
  const accounts = rows(r.out).filter((x) => x.account);
  assert.ok(accounts.length >= 3);
  for (const a of accounts) { assert.equal(a.marker, true, r.out); assert.equal(a.configDir, true, r.out); assert.equal(a.tag, null, r.out); }
});

test("P3: no homes at all is red for verify and proof", () => {
  const H = fs.mkdtempSync(path.join(os.tmpdir(), "cx1762e-"));
  assert.notEqual(run(H, ["verify", ...A24]).code, 0);
  assert.notEqual(run(H, ["proof", "--version", V24]).code, 0);
});

test("P3: a config home without plugins is red unless skipped by name", () => {
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

test("P3: verify compares the cache with the archive, not a substring", () => {
  const f = fakeHome();
  assert.equal(apply(f).code, 0);
  fs.appendFileSync(path.join(f.P, "cache/openai-codex/codex", V24, "CHANGELOG.md"), "x\n");
  assert.notEqual(run(f.H, ["verify", ...A24]).code, 0);
});

test("P3: an invalid version is refused before anything is written", () => {
  const f = fakeHome();
  const before = fs.readFileSync(f.installed, "utf8");
  const cacheBefore = fs.readdirSync(path.join(f.P, "cache/openai-codex"));
  const r = run(f.H, ["apply", "--version", "../../x", "--sha", S24, "--branch", B24]);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(fs.readFileSync(f.installed, "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.join(f.P, "cache/openai-codex")), cacheBefore);
  assert.equal(git(f.market, "rev-parse", "HEAD"), S23);
});

test("P3: an installPath that resolves outside the cache is refused before anything is written", () => {
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
