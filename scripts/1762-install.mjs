#!/usr/bin/env node
// #1762: install a codex-plugin-cc release (Sjotie fork) into every Claude config home on this machine.
// Use the same script on the Mac (1.0.7-sjotie.22.1) and on omarchy (1.0.7-sjotie.24).
//
//   node codex-plugin-install.mjs plan    --version V --sha SHA --branch B   only reads; shows what apply would change
//   node codex-plugin-install.mjs apply   --version V --sha SHA --branch B   installs; skips what is already right
//   node codex-plugin-install.mjs verify  --version V --sha SHA              per account: version, cache, marketplace, fix present
//   node codex-plugin-install.mjs proof   --version V                         spawns via the installed broker code of every account
//   node codex-plugin-install.mjs brokers                                     read-only: running brokers, their version and tag
//   node codex-plugin-install.mjs undo    --version V                         restores installed_plugins.json and the marketplace HEAD
//
// What it touches, per real plugins directory (account homes that symlink to the same directory count once):
//   marketplaces/openai-codex   git checkout, detached at SHA (fetched from origin BRANCH); refuses a dirty checkout
//   cache/openai-codex/codex/V  new directory = `git archive SHA plugins/codex`; refuses an existing one that differs
//   installed_plugins.json      the codex@openai-codex entries: installPath (version segment), version, gitCommitSha,
//                               lastUpdated; backup first (installed_plugins.json.bak-1762-pre-V); atomic replace
// What it does not touch: plugin state (CLAUDE_PLUGIN_DATA, state locks, job index), older cache versions (running
// companions keep using them), running processes other than the ones `proof` starts itself, settings, logins.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MARKET = "openai-codex", PLUGIN = "codex", KEY = `${PLUGIN}@${MARKET}`;
const TAG_NAME = "FACTORY_PROC_TAG";
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
const die = (msg) => { console.error(`FOUT: ${msg}`); process.exit(1); };
const need = (name) => opt(name) ?? die(`--${name} ontbreekt`);
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

/** Every Claude config home: ~/.claude plus each Factory account home (Mac and Linux use the same layout). */
function homes() {
  const out = fs.readdirSync(os.homedir()).filter((n) => n.startsWith(".claude") && fs.existsSync(path.join(os.homedir(), n, "plugins")))
    .sort().map((n) => path.join(os.homedir(), n));
  const acc = path.join(os.homedir(), ".homebase/factory-acp/accounts/claude");
  for (const name of fs.existsSync(acc) ? fs.readdirSync(acc).sort() : []) out.push(path.join(acc, name));
  return out.map((home) => ({ home, plugins: path.join(home, "plugins"), real: real(path.join(home, "plugins")) }));
}
/** Real plugins directories with the homes that use them. */
function pluginDirs() {
  const map = new Map();
  for (const h of homes()) {
    if (!h.real) continue;
    if (!map.has(h.real)) map.set(h.real, []);
    map.get(h.real).push(h.home);
  }
  return map;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
function writeJsonAtomic(p, data) {
  const tmp = `${p}.tmp-1762-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: fs.statSync(p).mode });
  fs.renameSync(tmp, p);
}
function treeEqual(a, b) {
  // diff -r, ignoring the .in_use marker Claude Code keeps in a cache directory.
  try { execFileSync("diff", ["-r", "-q", "-x", ".in_use", a, b], { stdio: "ignore", timeout: 60_000 }); return true; } catch { return false; }
}
function archiveTo(repo, sha, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tar = execFileSync("git", ["archive", sha, "plugins/codex"], { cwd: repo, maxBuffer: 256 << 20, timeout: 120_000 });
  execFileSync("tar", ["-x", "-C", dest, "--strip-components=2"], { input: tar, timeout: 120_000 });
}
const versionPath = (installPath, version) => path.join(path.dirname(installPath), version);

function planOrApply(apply) {
  const version = need("version"), sha = need("sha"), branch = need("branch");
  if (!/^[0-9a-f]{40}$/.test(sha)) die("--sha moet de volle 40-tekens sha zijn");
  let changes = 0;
  for (const [dir, users] of pluginDirs()) {
    console.log(`\n== ${dir}  (gebruikt door: ${users.join(", ")})`);
    const market = path.join(dir, "marketplaces", MARKET);
    const installed = path.join(dir, "installed_plugins.json");
    if (!fs.existsSync(path.join(market, ".git")) || !fs.existsSync(installed)) { console.log("   geen codex-marketplace of installed_plugins.json hier: overgeslagen"); continue; }
    // 1. marketplace checkout
    const head = git(market, "rev-parse", "HEAD");
    if (head === sha) console.log(`   marketplace: al op ${sha.slice(0, 9)}`);
    else {
      if (git(market, "status", "--porcelain")) die(`${market} heeft lokale wijzigingen; niets aangeraakt`);
      console.log(`   marketplace: ${head.slice(0, 9)} -> ${sha.slice(0, 9)} (fetch origin ${branch}, checkout --detach)`);
      changes++;
      if (apply) {
        let branchName = "";
        try { branchName = git(market, "symbolic-ref", "-q", "--short", "HEAD"); } catch { /* detached */ }
        fs.writeFileSync(path.join(dir, `marketplace-head.bak-1762-pre-${version}`), `${head} ${branchName}\n`);
        git(market, "fetch", "--quiet", "origin", branch);
        try { git(market, "cat-file", "-e", `${sha}^{commit}`); } catch { die(`sha ${sha} niet opgehaald van origin ${branch}`); }
        git(market, "checkout", "--quiet", "--detach", sha);
        if (git(market, "rev-parse", "HEAD") !== sha) die("marketplace HEAD is na checkout niet de sha");
      }
    }
    // 2. cache directory for this version
    const cache = path.join(dir, "cache", MARKET, PLUGIN, version);
    const ref = fs.mkdtempSync(path.join(os.tmpdir(), "cx1762-"));
    try {
      if (!apply && head !== sha) {
        try { git(market, "cat-file", "-e", `${sha}^{commit}`); archiveTo(market, sha, ref); } catch { console.log(`   cache: ${version} wordt bij apply gemaakt uit ${sha.slice(0, 9)} (sha nog niet lokaal)`); }
      } else archiveTo(market, sha, ref);
      if (fs.existsSync(cache)) {
        if (!fs.readdirSync(ref).length) console.log(`   cache: ${version} bestaat al; vergelijking met ${sha.slice(0, 9)} volgt bij apply`);
        else if (!treeEqual(ref, cache)) die(`${cache} bestaat al en verschilt van ${sha.slice(0, 9)}; niets overschreven`);
        else console.log(`   cache: ${version} bestaat al en klopt`);
      } else {
        console.log(`   cache: ${version} nieuw uit ${sha.slice(0, 9)}`);
        changes++;
        if (apply) {
          const tmp = `${cache}.tmp-1762-${process.pid}`;
          archiveTo(market, sha, tmp);
          fs.renameSync(tmp, cache);
        }
      }
    } finally { fs.rmSync(ref, { recursive: true, force: true }); }
    // 3. installed_plugins.json
    const data = readJson(installed);
    const entries = data.plugins?.[KEY];
    if (!Array.isArray(entries) || !entries.length) { console.log(`   installed_plugins.json: geen ${KEY}-regels; niets gewijzigd`); continue; }
    const stale = entries.filter((e) => e.version !== version || e.gitCommitSha !== sha || path.basename(e.installPath) !== version);
    if (!stale.length) { console.log(`   installed_plugins.json: alle ${entries.length} regels al op ${version}`); continue; }
    for (const e of stale) console.log(`   installed_plugins.json: ${e.scope}${e.projectPath ? ` (${e.projectPath})` : ""} ${e.version} -> ${version}`);
    changes++;
    if (apply) {
      const bak = `${installed}.bak-1762-pre-${version}`;
      if (!fs.existsSync(bak)) fs.copyFileSync(installed, bak);
      const now = new Date().toISOString();
      for (const e of stale) Object.assign(e, { installPath: versionPath(e.installPath, version), version, gitCommitSha: sha, lastUpdated: now });
      writeJsonAtomic(installed, data);
    }
  }
  console.log(`\n${apply ? "toegepast" : "plan"}: ${changes} wijziging(en)${apply ? "" : " (niets geschreven)"}`);
}

function verify() {
  const version = need("version"), sha = need("sha");
  let bad = 0;
  for (const h of homes()) {
    const row = { account: h.home, plugins: h.real ?? "(ontbreekt)" };
    if (h.real) {
      const installed = path.join(h.real, "installed_plugins.json");
      const entries = fs.existsSync(installed) ? readJson(installed).plugins?.[KEY] ?? [] : [];
      row.installed = entries.map((e) => `${e.scope}:${e.version}@${(e.gitCommitSha ?? "").slice(0, 9)}`).join(" ") || "(geen)";
      const paths = entries.map((e) => real(e.installPath));
      row.cacheOk = paths.length > 0 && paths.every((p) => p && treeOk(p));
      const market = path.join(h.real, "marketplaces", MARKET);
      row.marketplace = fs.existsSync(market) ? git(market, "rev-parse", "--short=9", "HEAD") : "(geen)";
      const ok = entries.length > 0 && entries.every((e) => e.version === version && e.gitCommitSha === sha) && row.cacheOk && row.marketplace === sha.slice(0, 9);
      row.ok = ok;
      if (!ok) bad++;
    } else bad++;
    console.log(JSON.stringify(row));
  }
  console.log(bad ? `verify: ${bad} account(s) niet op ${version}` : `verify: alle accounts op ${version} (${sha.slice(0, 9)})`);
  process.exitCode = bad ? 1 : 0;
}
function treeOk(installPath) {
  const f = path.join(installPath, "scripts/lib/broker-lifecycle.mjs");
  return fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("env: brokerSpawnEnv(env)");
}

/** Environment of a running pid: /proc on Linux, `ps -E` (KERN_PROCARGS2) on macOS. Null when unreadable. */
function envOf(pid) {
  try {
    if (process.platform === "linux") return Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
    const line = execFileSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
    const m = line.match(new RegExp(`(?:^|\\s)${TAG_NAME}=([0-9a-f]+)`));
    return { [TAG_NAME]: m ? m[1] : undefined, __raw: line.length };
  } catch { return null; }
}

async function proof() {
  const version = need("version");
  const tag = process.env[TAG_NAME] && /^[0-9a-f]{32}$/.test(process.env[TAG_NAME]) ? process.env[TAG_NAME] : "0123456789abcdef0123456789abcdef";
  const source = process.env[TAG_NAME] ? "de eigen sessietag" : "een testtag (deze shell heeft geen sessietag)";
  console.log(`proof met ${source}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx1762p-"));
  const stub = path.join(dir, "stub-broker.mjs");
  // Stands in for app-server-broker.mjs: lives 20 s so its environment can be read from outside, starts no app-server.
  fs.writeFileSync(stub, "setTimeout(() => {}, 20000);\n");
  const started = [];
  let bad = 0;
  try {
    // Control: a plain spawn with the tag must show the tag through the same reader, or the reader proves nothing.
    const ctl = spawn(process.execPath, [stub], { env: { ...process.env, [TAG_NAME]: tag }, detached: true, stdio: "ignore" });
    started.push(ctl.pid);
    await new Promise((r) => setTimeout(r, 300));
    const ctlEnv = envOf(ctl.pid);
    const ctlSeen = ctlEnv?.[TAG_NAME] === tag;
    console.log(JSON.stringify({ control: "gewone spawn met tag", pid: ctl.pid, tagGezien: ctlSeen }));
    if (!ctlSeen) { console.log("proof ONGELDIG: de lezer ziet de tag niet eens bij de controle"); bad++; }
    for (const h of homes()) {
      if (!h.real) continue;
      const entries = fs.existsSync(path.join(h.real, "installed_plugins.json")) ? readJson(path.join(h.real, "installed_plugins.json")).plugins?.[KEY] ?? [] : [];
      const e = entries.find((x) => x.version === version);
      if (!e) { console.log(JSON.stringify({ account: h.home, fout: `geen ${version}-installatie` })); bad++; continue; }
      const mod = await import(pathToFileURL(path.join(e.installPath, "scripts/lib/broker-lifecycle.mjs")).href + `?a=${encodeURIComponent(h.home)}`);
      const child = mod.spawnBrokerProcess({
        scriptPath: stub, cwd: dir, endpoint: `unix:${path.join(dir, "b.sock")}`, pidFile: path.join(dir, `b-${started.length}.pid`), logFile: path.join(dir, "b.log"),
        env: { ...process.env, [TAG_NAME]: tag, CLAUDE_CONFIG_DIR: h.home }
      });
      started.push(child.pid);
      await new Promise((r) => setTimeout(r, 300));
      const env = envOf(child.pid);
      const row = { account: h.home, code: e.installPath, pid: child.pid, envGelezen: env !== null, tag: env ? (env[TAG_NAME] ?? null) : "onleesbaar" };
      if (!env || env[TAG_NAME] !== undefined) bad++;
      console.log(JSON.stringify(row));
    }
  } finally {
    for (const pid of started) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(bad ? `proof: ${bad} fout(en)` : "proof: geen enkele via de geïnstalleerde code gestarte broker draagt de tag; de controle wel");
  process.exitCode = bad ? 1 : 0;
}

function brokers() {
  // Read-only: every running app-server-broker.mjs of this user, its plugin version (from the script path) and tag.
  const out = execFileSync("ps", ["-axww", "-o", "pid=,user=,command="], { encoding: "utf8", timeout: 10_000 });
  const me = os.userInfo().username;
  let n = 0;
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*app-server-broker\.mjs.*)$/);
    if (!m || m[2] !== me) continue;
    n++;
    const script = m[3].split(/\s+/).find((a) => a.endsWith("app-server-broker.mjs"));
    const env = envOf(Number(m[1]));
    console.log(JSON.stringify({ pid: Number(m[1]), version: script?.match(/codex\/([^/]+)\/scripts/)?.[1] ?? "?", script, realScript: script ? real(script) : null, tag: env ? (env[TAG_NAME] ? "JA" : "nee") : "onleesbaar" }));
  }
  console.log(`brokers: ${n} draaiend (alleen gelezen)`);
}

function undo() {
  const version = need("version");
  for (const [dir] of pluginDirs()) {
    const installed = path.join(dir, "installed_plugins.json");
    const bak = `${installed}.bak-1762-pre-${version}`;
    const headBak = path.join(dir, `marketplace-head.bak-1762-pre-${version}`);
    if (fs.existsSync(bak)) { fs.copyFileSync(bak, `${installed}.tmp-undo`); fs.renameSync(`${installed}.tmp-undo`, installed); console.log(`${installed}: teruggezet uit ${path.basename(bak)}`); }
    if (fs.existsSync(headBak)) {
      const market = path.join(dir, "marketplaces", MARKET);
      const [head, branchName] = fs.readFileSync(headBak, "utf8").trim().split(" ");
      let tip = "";
      try { tip = branchName ? git(market, "rev-parse", `refs/heads/${branchName}`) : ""; } catch { /* branch gone */ }
      if (branchName && tip === head) git(market, "checkout", "--quiet", branchName);
      else git(market, "checkout", "--quiet", "--detach", head);
      console.log(`${market}: terug op ${head.slice(0, 9)}${branchName && tip === head ? ` (${branchName})` : ""}`);
    }
    console.log(`${dir}: cache/${MARKET}/${PLUGIN}/${version} blijft staan (een draaiende companion kan hem gebruiken); weghalen mag pas als brokers geen ${version} meer toont`);
  }
}

if (cmd === "plan") planOrApply(false);
else if (cmd === "apply") planOrApply(true);
else if (cmd === "verify") verify();
else if (cmd === "proof") await proof();
else if (cmd === "brokers") brokers();
else if (cmd === "undo") undo();
else die("gebruik: plan|apply|verify|proof|brokers|undo (zie de kop van dit script)");
