#!/usr/bin/env node
// #1762: install a codex-plugin-cc release (Sjotie fork) into every Claude config home on this machine.
// The same script serves the Mac (1.0.7-sjotie.22.1) and omarchy (1.0.7-sjotie.24).
//
//   node 1762-install.mjs plan    --version V --sha SHA --branch B   reads only; shows what apply would change
//   node 1762-install.mjs apply   --version V --sha SHA --branch B   installs; skips what is already right
//   node 1762-install.mjs verify  --version V --sha SHA              per account: entries, cache == git archive, marketplace
//   node 1762-install.mjs proof   --version V                         per account: spawn via the installed broker code
//   node 1762-install.mjs brokers                                     reads only: running brokers, version, tag
//   node 1762-install.mjs undo    --version V                         undoes exactly what apply V changed, nothing else
//   --skip-home <path> (repeatable): a config home that is known to have no plugins; it is listed, not counted as red.
//
// Homes: every directory ~/.claude* and every ~/.homebase/factory-acp/accounts/claude/<account>. A home without a
// plugins directory is red unless named with --skip-home; no plugins directory at all is red.
//
// Per real plugins directory (homes that symlink to one directory count once), apply:
//   1. validates everything first (version, sha, branch, no symlinks inside the plugins directory on the paths it
//      writes, every codex installPath resolves into this directory's cache); nothing is written if one check fails;
//   2. writes one restore point, once and exclusively (codex-restore-1762-<V>.json: marketplace HEAD and branch, and
//      the codex@openai-codex entries as they were). A later apply V reuses it and never rewrites it;
//   3. marketplaces/openai-codex: fetch origin <branch>, checkout --detach <sha>; refuses a dirty checkout;
//   4. cache/openai-codex/codex/<V>: `git archive <sha> plugins/codex`; refuses an existing directory that differs;
//   5. installed_plugins.json: changes only the codex@openai-codex fields installPath, version, gitCommitSha and
//      lastUpdated. It re-reads the file just before the atomic rename and starts over when anyone changed it in
//      between (another plugin install); the window left is the rename itself.
// Undo sets back only codex entries that still hold exactly what apply wrote, and the marketplace only when it is
// still at <sha>; anything changed since is reported and left alone. The cache directory stays (a running
// companion may use it). What it never touches: plugin state (CLAUDE_PLUGIN_DATA, state locks, job index), other
// plugins, settings, logins, and any process it did not start itself.
//
// Detached HEAD is not a pin: a marketplace update by Claude Code (`/plugin marketplace update`, or autoUpdate on
// the marketplace) moves the checkout back to origin's default branch and can install that version. verify then
// shows marketplace != <sha> and/or another version (exit 1); it also prints the marketplace's autoUpdate setting.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MARKET = "openai-codex", PLUGIN = "codex", KEY = `${PLUGIN}@${MARKET}`;
const TAG_NAME = "FACTORY_PROC_TAG", MARKER_NAME = "CX1762_PROOF_MARKER";
const VERSION_RE = /^\d+\.\d+\.\d+-sjotie\.\d+(?:\.\d+)?$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const PROOF_DEADLINE_MS = 90_000;
// Tests only: {"execBeforeRename": [argv...], "stubLifetimeMs": n, "stopDelayMs": n}. Honoured only when HOME lies under the temporary
// directory (a test's fake home); in a real run they are ignored with a warning.
const HOOKS = (() => {
  const raw = process.env.CX1762_TEST_HOOKS;
  if (!raw) return {};
  const tmp = fs.realpathSync(os.tmpdir()), home = fs.realpathSync(os.homedir());
  if (!home.startsWith(tmp + path.sep)) { console.error("let op: CX1762_TEST_HOOKS genegeerd (HOME is geen testmap)"); return {}; }
  try { return JSON.parse(raw); } catch { console.error("let op: CX1762_TEST_HOOKS onleesbaar; genegeerd"); return {}; }
})();

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
const opts = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [path.resolve(args[i + 1])] : []));
class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };
const need = (name) => opt(name) ?? refuse(`--${name} ontbreekt`);
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function version() {
  const v = need("version");
  if (!VERSION_RE.test(v)) refuse(`--version ${JSON.stringify(v)} is geen 1.0.7-sjotie.N(.M)-versie`);
  return v;
}
function sha() {
  const s = need("sha");
  if (!SHA_RE.test(s)) refuse("--sha moet de volle 40-tekens sha zijn");
  return s;
}
function branch() {
  const b = need("branch");
  try { execFileSync("git", ["check-ref-format", "--branch", b], { stdio: "ignore" }); } catch { refuse(`--branch ${JSON.stringify(b)} is geen geldige branchnaam`); }
  return b;
}

/** Every Claude config home with its plugins directory (null when missing). */
export function discoverHomes(home = os.homedir()) {
  const homes = [];
  for (const n of fs.readdirSync(home).sort()) if (n.startsWith(".claude") && isDir(path.join(home, n))) homes.push(path.join(home, n));
  const acc = path.join(home, ".homebase/factory-acp/accounts/claude");
  if (isDir(acc)) for (const n of fs.readdirSync(acc).sort()) if (isDir(path.join(acc, n))) homes.push(path.join(acc, n));
  return homes.map((h) => ({ home: h, real: isDir(path.join(h, "plugins")) ? real(path.join(h, "plugins")) : null }));
}
/** Homes, the real plugins directories with their homes, and the homes without plugins that were not skipped. */
function survey() {
  const skip = new Set(opts("skip-home"));
  const homes = discoverHomes();
  const dirs = new Map();
  const missing = [];
  for (const h of homes) {
    if (!h.real) { if (!skip.has(path.resolve(h.home))) missing.push(h.home); else console.log(`overgeslagen op verzoek (geen plugins-map): ${h.home}`); continue; }
    if (!dirs.has(h.real)) dirs.set(h.real, []);
    dirs.get(h.real).push(h.home);
  }
  for (const m of missing) console.log(`ROOD: ${m} heeft geen plugins-map (noem hem met --skip-home als dat klopt)`);
  if (!dirs.size) console.log("ROOD: geen enkele plugins-map gevonden");
  return { homes, dirs, missing, skip, red: missing.length > 0 || dirs.size === 0 };
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const versionPath = (installPath, v) => path.join(path.dirname(installPath), v);
const restorePath = (dir, v) => path.join(dir, `codex-restore-1762-${v}.json`);
const entryKey = (e) => `${e.scope}|${e.projectPath ?? ""}`;

/** Paths apply writes in one plugins directory, checked for symlinks and escapes before anything is written. */
function layout(dir, v) {
  const market = path.join(dir, "marketplaces", MARKET);
  const cacheParent = path.join(dir, "cache", MARKET, PLUGIN);
  const installed = path.join(dir, "installed_plugins.json");
  const problems = [];
  for (const [p, kind] of [[market, "dir"], [cacheParent, "dir"], [installed, "file"]]) {
    const r = real(p);
    if (r === null) problems.push(`${p} ontbreekt`);
    else if (r !== p) problems.push(`${p} loopt via een symlink naar ${r}; geweigerd`);
    else if (kind === "file" && !fs.statSync(p).isFile()) problems.push(`${p} is geen bestand`);
  }
  const cache = path.join(cacheParent, v);
  if (path.dirname(cache) !== cacheParent) problems.push(`versie ${v} geeft een pad buiten ${cacheParent}`);
  let st = null;
  try { st = fs.lstatSync(cache); } catch { /* absent */ }
  if (st && !st.isDirectory()) problems.push(`${cache} bestaat maar is geen gewone map (symlink of bestand); geweigerd`);
  return { market, cacheParent, installed, cache, problems };
}
/** Codex entries whose installPath does not resolve into this directory's cache (then apply/undo refuse). */
function entryProblems(L, entries, v) {
  const out = [];
  for (const e of entries) {
    if (typeof e.installPath !== "string" || !path.isAbsolute(e.installPath)) { out.push(`installPath ${JSON.stringify(e.installPath)} is niet absoluut`); continue; }
    const parent = real(path.dirname(e.installPath));
    if (parent !== L.cacheParent) out.push(`installPath ${e.installPath} ligt niet in ${L.cacheParent} (realpath ${parent})`);
    else {
      const r = real(e.installPath);
      if (r !== null && r !== path.join(L.cacheParent, path.basename(e.installPath))) out.push(`installPath ${e.installPath} wijst (realpath) naar ${r}, buiten ${L.cacheParent}`);
    }
  }
  return out;
}
function treeEqual(a, b) {
  // diff -r, ignoring the .in_use marker Claude Code keeps in a cache directory.
  try { execFileSync("diff", ["-r", "-q", "-x", ".in_use", a, b], { stdio: "ignore", timeout: 60_000 }); return true; } catch { return false; }
}
function archiveTo(repo, s, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tar = execFileSync("git", ["archive", s, "plugins/codex"], { cwd: repo, maxBuffer: 256 << 20, timeout: 120_000 });
  execFileSync("tar", ["-x", "-C", dest, "--strip-components=2"], { input: tar, timeout: 120_000 });
}
function hasCommit(repo, s) { try { git(repo, "cat-file", "-e", `${s}^{commit}`); return true; } catch { return false; } }

/**
 * Read-modify-write of installed_plugins.json that only changes what `change` changes. The file is read again right
 * before the rename; when it differs from what `change` saw, start over (up to 5 times).
 */
function updateInstalled(file, change) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const before = fs.readFileSync(file, "utf8");
    const data = JSON.parse(before);
    const result = change(data);
    if (!result.changed) return result;
    const tmp = `${file}.tmp-1762-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: fs.statSync(file).mode });
    if (HOOKS.execBeforeRename) execFileSync(HOOKS.execBeforeRename[0], HOOKS.execBeforeRename.slice(1), { stdio: "ignore" });
    if (fs.readFileSync(file, "utf8") !== before) { fs.rmSync(tmp, { force: true }); console.log(`   ${path.basename(file)}: tussentijds gewijzigd door een ander; opnieuw (poging ${attempt})`); continue; }
    fs.renameSync(tmp, file);
    return result;
  }
  refuse(`${file} bleef veranderen tijdens het schrijven; niets geschreven`);
}
/** Write `data` to `file` only if it does not exist yet (link is atomic and exclusive). */
function writeExclusive(file, data) {
  const tmp = `${file}.tmp-1762-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try { fs.linkSync(tmp, file); return true; } catch (e) { if (e.code === "EEXIST") return false; throw e; } finally { fs.rmSync(tmp, { force: true }); }
}

function planOrApply(apply) {
  const v = version(), s = sha(), b = branch();
  const { dirs, red } = survey();
  if (red) refuse("niet elke config-home heeft een plugins-map (zie ROOD hierboven); niets geschreven");
  // Phase 1: validate every directory before writing anything anywhere.
  const work = [];
  for (const [dir, users] of dirs) {
    const L = layout(dir, v);
    const entries = L.problems.length ? [] : readJson(L.installed).plugins?.[KEY] ?? [];
    const problems = [...L.problems, ...entryProblems(L, entries, v)];
    if (!L.problems.length && !entries.length) problems.push(`${L.installed} heeft geen ${KEY}-regels`);
    const rp = restorePath(dir, v);
    if (fs.existsSync(rp)) { const r = readJson(rp); if (r.sha !== s || r.version !== v) problems.push(`${rp} hoort bij ${r.version}@${r.sha}, niet bij deze sha`); }
    if (!problems.length) {
      const moving = git(L.market, "rev-parse", "HEAD") !== s;
      if (moving && git(L.market, "status", "--porcelain")) problems.push(`${L.market} heeft lokale wijzigingen en moet naar een andere commit`);
      // Fetching only adds objects; HEAD, the work tree and the refs Claude Code reads stay as they are.
      if (apply && !hasCommit(L.market, s)) {
        try { git(L.market, "fetch", "--quiet", "origin", b); } catch (e) { problems.push(`fetch origin ${b} mislukt: ${String(e.stderr ?? e.message).trim().split("\n").pop()}`); }
        if (!hasCommit(L.market, s)) problems.push(`sha ${s} niet op te halen van origin ${b}`);
      }
      if (hasCommit(L.market, s) && fs.existsSync(L.cache)) {
        const ref = fs.mkdtempSync(path.join(os.tmpdir(), "cx1762-"));
        try { archiveTo(L.market, s, ref); if (!treeEqual(ref, L.cache)) problems.push(`${L.cache} bestaat al en verschilt van ${s.slice(0, 9)}`); } finally { fs.rmSync(ref, { recursive: true, force: true }); }
      }
    }
    if (problems.length) refuse(`${dir}:\n   ${problems.join("\n   ")}\nniets geschreven`);
    work.push({ dir, users, L });
  }
  let changes = 0;
  for (const { dir, users, L } of work) {
    console.log(`\n== ${dir}  (gebruikt door: ${users.join(", ")})`);
    // Restore point: once, exclusive, both halves together, before any change in this directory.
    const rp = restorePath(dir, v);
    const head = git(L.market, "rev-parse", "HEAD");
    if (fs.existsSync(rp)) console.log(`   herstelpunt: bestaat al (${path.basename(rp)}); ongewijzigd`);
    else {
      let headBranch = "";
      try { headBranch = git(L.market, "symbolic-ref", "-q", "--short", "HEAD"); } catch { /* detached */ }
      const record = { schema: "codex-restore-1762-v1", version: v, sha: s, created: new Date().toISOString(), marketplace: { head, branch: headBranch },
        entries: (readJson(L.installed).plugins?.[KEY] ?? []).map((e) => ({ key: entryKey(e), before: { installPath: e.installPath ?? null, version: e.version ?? null, gitCommitSha: e.gitCommitSha ?? null } })) };
      console.log(`   herstelpunt: nieuw (marketplace ${head.slice(0, 9)}${headBranch ? ` op ${headBranch}` : ""}, ${record.entries.length} codex-regels)`);
      changes++;
      if (apply && !writeExclusive(rp, record)) {
        const other = readJson(rp);
        if (other.sha !== s || other.version !== v) refuse(`${rp} is tegelijk gemaakt voor ${other.version}@${other.sha}; gestopt vóór de eerste wijziging hier`);
        console.log("   herstelpunt: tegelijk door een ander gemaakt voor dezelfde sha; dat blijft gelden");
      }
    }
    // Marketplace checkout.
    if (head === s) console.log(`   marketplace: al op ${s.slice(0, 9)}`);
    else {
      console.log(`   marketplace: ${head.slice(0, 9)} -> ${s.slice(0, 9)} (fetch origin ${b}, checkout --detach)`);
      changes++;
      if (apply) {
        git(L.market, "checkout", "--quiet", "--detach", s);
        if (git(L.market, "rev-parse", "HEAD") !== s) refuse("marketplace HEAD is na checkout niet de sha");
      }
    }
    // Cache directory for this version.
    const canCompare = hasCommit(L.market, s);
    if (fs.existsSync(L.cache)) {
      console.log(canCompare ? `   cache: ${v} bestaat al en klopt` : `   cache: ${v} bestaat al; vergelijking met ${s.slice(0, 9)} volgt bij apply (sha nog niet lokaal)`);
    } else {
      console.log(`   cache: ${v} nieuw uit ${s.slice(0, 9)}`);
      changes++;
      if (apply) {
        const tmp = `${L.cache}.tmp-1762-${process.pid}`;
        fs.rmSync(tmp, { recursive: true, force: true });
        archiveTo(L.market, s, tmp);
        fs.renameSync(tmp, L.cache);
      }
    }
    // installed_plugins.json: only the codex fields.
    const now = new Date().toISOString();
    const stale = (e) => e.version !== v || e.gitCommitSha !== s || e.installPath !== versionPath(e.installPath, v);
    const peek = (readJson(L.installed).plugins?.[KEY] ?? []).filter(stale);
    if (!peek.length) { console.log("   installed_plugins.json: alle codex-regels al op deze versie"); continue; }
    for (const e of peek) console.log(`   installed_plugins.json: ${e.scope}${e.projectPath ? ` (${e.projectPath})` : ""} ${e.version} -> ${v}`);
    changes++;
    if (apply) {
      updateInstalled(L.installed, (data) => {
        const list = data.plugins?.[KEY] ?? [];
        const problems = entryProblems(L, list, v);
        if (problems.length) refuse(`${L.installed}: ${problems.join("; ")}`);
        let changed = false;
        for (const e of list) if (stale(e)) { Object.assign(e, { installPath: versionPath(e.installPath, v), version: v, gitCommitSha: s, lastUpdated: now }); changed = true; }
        return { changed };
      });
    }
  }
  console.log(`\n${apply ? "toegepast" : "plan"}: ${changes} wijziging(en)${apply ? "" : " (niets geschreven)"}`);
}

function verify() {
  const v = version(), s = sha();
  const { homes, dirs, skip, red } = survey();
  let bad = red ? 1 : 0;
  const dirOk = new Map();
  for (const [dir] of dirs) {
    const L = layout(dir, v);
    const row = { plugins: dir };
    if (L.problems.length) { row.problems = L.problems; dirOk.set(dir, row); bad++; continue; }
    const entries = readJson(L.installed).plugins?.[KEY] ?? [];
    row.installed = entries.map((e) => `${e.scope}:${e.version}@${(e.gitCommitSha ?? "").slice(0, 9)}`).join(" ") || "(geen)";
    row.marketplace = git(L.market, "rev-parse", "HEAD").slice(0, 9);
    try { row.autoUpdate = readJson(path.join(dir, "known_marketplaces.json"))[MARKET]?.autoUpdate ?? "(niet gezet)"; } catch { row.autoUpdate = "(onleesbaar)"; }
    if (hasCommit(L.market, s)) {
      const ref = fs.mkdtempSync(path.join(os.tmpdir(), "cx1762v-"));
      try {
        archiveTo(L.market, s, ref);
        row.cacheGelijkAanArchief = entries.length > 0 && entries.every((e) => real(e.installPath) && treeEqual(ref, real(e.installPath)));
      } finally { fs.rmSync(ref, { recursive: true, force: true }); }
    } else row.cacheGelijkAanArchief = `sha ${s.slice(0, 9)} niet in de marketplace-checkout`;
    row.ok = entries.length > 0 && entries.every((e) => e.version === v && e.gitCommitSha === s) && row.cacheGelijkAanArchief === true && row.marketplace === s.slice(0, 9);
    if (!row.ok) bad++;
    dirOk.set(dir, row);
  }
  let counted = 0;
  for (const h of homes) {
    const skipped = !h.real && skip.has(path.resolve(h.home));
    if (!skipped) counted++;
    console.log(JSON.stringify({ account: h.home, ...(h.real ? dirOk.get(h.real) : { plugins: "(geen)", ok: skipped ? "overgeslagen" : false }) }));
  }
  console.log(bad ? `verify: ROOD (${bad})` : `verify: alle ${counted} accounts op ${v} (${s.slice(0, 9)}), cache gelijk aan het archief${skip.size ? `; ${skip.size} overgeslagen op verzoek` : ""}`);
  process.exitCode = bad ? 1 : 0;
}

/** The variables we look for in a running pid's environment: /proc on Linux, `ps -E` on macOS. Null when unreadable. */
function envOf(pid, names = [TAG_NAME, MARKER_NAME, "CLAUDE_CONFIG_DIR"]) {
  try {
    if (process.platform === "linux") {
      const all = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
      return Object.fromEntries(names.map((n) => [n, all[n]]));
    }
    const line = execFileSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
    return Object.fromEntries(names.map((n) => [n, line.match(new RegExp(`(?:^|\\s)${n}=(\\S*)`))?.[1]]));
  } catch { return null; }
}

/** A child we started, with its exit tracked; it is only ever signalled through its handle while it runs. */
function track(child) {
  const t = { child, exited: false, exitPromise: null };
  t.exitPromise = new Promise((resolve) => {
    child.once("exit", () => { t.exited = true; resolve(); });
    child.once("error", () => { t.exited = true; resolve(); });
  });
  return t;
}
/** Stops a child through its handle; returns "al beëindigd", "gestopt" or "loopt nog". */
async function stopTracked(t) {
  if (t.exited || t.child.exitCode !== null || t.child.signalCode !== null) return "al beëindigd";
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    // A handle that saw exit is never signalled; an exited child Node has not reaped yet keeps its pid reserved.
    if (t.exited || t.child.exitCode !== null || t.child.signalCode !== null) return "gestopt";
    t.child.kill(sig);
    let timer;
    await Promise.race([t.exitPromise, new Promise((r) => { timer = setTimeout(r, 3000); })]);
    clearTimeout(timer); // a pending timer would keep this process alive after the proof
  }
  return t.exited ? "gestopt" : "loopt nog";
}
/** Wait until the environment of a running child shows its marker; null when it exited or the deadline passed. */
async function readChildEnv(t, marker, deadline) {
  while (Date.now() < deadline && !t.exited) {
    const env = envOf(t.child.pid);
    if (env && env[MARKER_NAME] === marker) return env;
    await sleep(100);
  }
  return null;
}

async function proof() {
  const v = version();
  const { homes, red } = survey();
  let bad = red ? 1 : 0;
  const deadline = Date.now() + PROOF_DEADLINE_MS;
  const sessionTag = process.env[TAG_NAME];
  const tag = sessionTag && /^[0-9a-f]{32}$/.test(sessionTag) ? sessionTag : crypto.randomBytes(16).toString("hex");
  console.log(`proof met ${tag === sessionTag ? "de eigen sessietag" : sessionTag ? "een testtag (de sessietag heeft een onverwachte vorm)" : "een testtag (deze shell heeft geen sessietag)"}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx1762p-"));
  const stub = path.join(dir, "stub-broker.mjs");
  // Stands in for app-server-broker.mjs: starts no app-server, ends when proof ends or after its lifetime.
  fs.writeFileSync(stub, "const p = process.ppid, end = Date.now() + Number(process.env.CX1762_STUB_MS);\n" +
    "setInterval(() => { if (process.ppid !== p || Date.now() > end) process.exit(0); }, 100);\n");
  const stubMs = String(HOOKS.stubLifetimeMs ?? PROOF_DEADLINE_MS + 30_000);
  // Minimal environment: only what the check needs; this is also exactly what is read back.
  const childEnv = (home, marker) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir(), [TAG_NAME]: tag, [MARKER_NAME]: marker, CLAUDE_CONFIG_DIR: home, CX1762_STUB_MS: stubMs });
  const tracked = [];
  try {
    const marker = crypto.randomBytes(8).toString("hex");
    const ctl = track(spawn(process.execPath, [stub], { env: childEnv(os.homedir(), marker), detached: true, stdio: "ignore" }));
    tracked.push(ctl);
    const ce = await readChildEnv(ctl, marker, Math.min(deadline, Date.now() + 5000));
    const ctlOk = ce !== null && ce[TAG_NAME] === tag && ce.CLAUDE_CONFIG_DIR === os.homedir();
    console.log(JSON.stringify({ control: "gewone spawn met tag", pid: ctl.child.pid, markerGezien: ce !== null, tagGezien: ce?.[TAG_NAME] === tag }));
    if (!ctlOk) { console.log("proof ONGELDIG: de lezer ziet marker, tag of CLAUDE_CONFIG_DIR niet bij de controle"); bad++; }
    for (const h of homes) {
      if (!h.real) { console.log(JSON.stringify({ account: h.home, fout: "geen plugins-map" })); continue; } // already counted by survey()
      const installed = path.join(h.real, "installed_plugins.json");
      const entries = fs.existsSync(installed) ? (readJson(installed).plugins?.[KEY] ?? []).filter((e) => e.version === v) : [];
      if (!entries.length) { console.log(JSON.stringify({ account: h.home, fout: `geen ${v}-installatie` })); bad++; continue; }
      for (const installPath of [...new Set(entries.map((e) => e.installPath))]) {
        if (Date.now() > deadline) { console.log(JSON.stringify({ account: h.home, code: installPath, fout: "totale deadline voorbij; niet gemeten" })); bad++; continue; }
        const mod = await import(pathToFileURL(path.join(installPath, "scripts/lib/broker-lifecycle.mjs")).href + `?home=${encodeURIComponent(h.home)}`);
        const m = crypto.randomBytes(8).toString("hex");
        const t = track(mod.spawnBrokerProcess({
          scriptPath: stub, cwd: dir, endpoint: `unix:${path.join(dir, "b.sock")}`, pidFile: path.join(dir, `b-${tracked.length}.pid`), logFile: path.join(dir, "b.log"),
          env: childEnv(h.home, m)
        }));
        tracked.push(t);
        const env = await readChildEnv(t, m, Math.min(deadline, Date.now() + 5000));
        const row = { account: h.home, code: installPath, pid: t.child.pid, marker: env !== null, configDir: env?.CLAUDE_CONFIG_DIR === h.home, tag: env ? (env[TAG_NAME] ?? null) : "niet gemeten" };
        if (!env || !row.configDir || env[TAG_NAME] !== undefined) bad++;
        console.log(JSON.stringify(row));
      }
    }
  } finally {
    if (HOOKS.stopDelayMs) await sleep(HOOKS.stopDelayMs);
    const ends = {};
    for (const t of tracked) { const r = await stopTracked(t); ends[r] = (ends[r] ?? 0) + 1; }
    console.log(JSON.stringify({ opruimen: ends }));
    if (ends["loopt nog"]) bad++;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(bad ? `proof: ROOD (${bad})` : "proof: geen enkele via de geïnstalleerde code gestarte broker draagt de tag; de controle wel");
  process.exitCode = bad ? 1 : 0;
}

function brokers() {
  // Reads only: every running app-server-broker.mjs of this user, its plugin version (from the script path) and tag.
  const out = execFileSync("ps", ["-axww", "-o", "pid=,user=,command="], { encoding: "utf8", timeout: 10_000 });
  const me = os.userInfo().username;
  let n = 0;
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*app-server-broker\.mjs.*)$/);
    if (!m || m[2] !== me) continue;
    n++;
    const script = m[3].split(/\s+/).find((a) => a.endsWith("app-server-broker.mjs"));
    const env = envOf(Number(m[1]), [TAG_NAME]);
    console.log(JSON.stringify({ pid: Number(m[1]), version: script?.match(/codex\/([^/]+)\/scripts/)?.[1] ?? "?", script, realScript: script ? real(script) : null, tag: env ? (env[TAG_NAME] ? "JA" : "nee") : "onleesbaar" }));
  }
  console.log(`brokers: ${n} draaiend (alleen gelezen)`);
}

function undo() {
  const v = version();
  const { dirs } = survey();
  let left = 0;
  for (const [dir] of dirs) {
    const leftBefore = left;
    const rp = restorePath(dir, v);
    if (!fs.existsSync(rp)) { console.log(`${dir}: geen herstelpunt voor ${v}; niets gedaan`); continue; }
    const r = readJson(rp);
    const L = layout(dir, v);
    if (L.problems.length) { console.log(`${dir}: ${L.problems.join("; ")}; niets gedaan`); left++; continue; }
    const now = new Date().toISOString();
    const same = (a, b) => (a ?? null) === (b ?? null);
    // The callback may run more than once (a concurrent write forces a retry): it only returns what it decided.
    const { lines, notDone } = updateInstalled(L.installed, (data) => {
      const list = data.plugins?.[KEY] ?? [];
      const lines = [];
      let changed = false, notDone = 0;
      for (const e of list) {
        const rec = r.entries.find((x) => x.key === entryKey(e));
        if (!rec) { lines.push(`   ${entryKey(e)}: niet in het herstelpunt; niet aangeraakt`); continue; }
        const ours = e.version === r.version && e.gitCommitSha === r.sha && rec.before.installPath && e.installPath === versionPath(rec.before.installPath, r.version);
        const already = same(e.version, rec.before.version) && same(e.gitCommitSha, rec.before.gitCommitSha) && same(e.installPath, rec.before.installPath);
        if (already) continue;
        if (!ours) { lines.push(`   ${entryKey(e)}: veranderd sinds apply (nu ${e.version}@${String(e.gitCommitSha).slice(0, 9)}); niet aangeraakt`); notDone++; continue; }
        for (const [k, val] of Object.entries(rec.before)) { if (val === null) delete e[k]; else e[k] = val; }
        e.lastUpdated = now;
        changed = true;
        lines.push(`   ${entryKey(e)}: terug op ${rec.before.version}`);
      }
      return { changed, lines, notDone };
    });
    for (const l of lines) console.log(l);
    left += notDone;
    const head = git(L.market, "rev-parse", "HEAD");
    if (head === r.marketplace.head) console.log(`   marketplace: staat al op ${head.slice(0, 9)}`);
    else if (head !== r.sha) { console.log(`   marketplace: veranderd sinds apply (nu ${head.slice(0, 9)}); niet aangeraakt`); left++; }
    else if (git(L.market, "status", "--porcelain")) { console.log("   marketplace: lokale wijzigingen; niet aangeraakt"); left++; }
    else {
      let tip = "";
      try { tip = r.marketplace.branch ? git(L.market, "rev-parse", `refs/heads/${r.marketplace.branch}`) : ""; } catch { /* branch gone */ }
      if (r.marketplace.branch && tip === r.marketplace.head) git(L.market, "checkout", "--quiet", r.marketplace.branch);
      else git(L.market, "checkout", "--quiet", "--detach", r.marketplace.head);
      console.log(`   marketplace: terug op ${r.marketplace.head.slice(0, 9)}${r.marketplace.branch && tip === r.marketplace.head ? ` (${r.marketplace.branch})` : ""}`);
    }
    if (left === leftBefore) fs.renameSync(rp, rp.replace(/\.json$/, `.undone-${now.replace(/[:.]/g, "")}.json`));
    console.log(`${dir}: cache/${MARKET}/${PLUGIN}/${v} blijft staan; weghalen pas als brokers hem niet meer toont`);
  }
  console.log(left ? `undo: ${left} onderdeel/onderdelen niet teruggezet (zie hierboven); herstelpunt blijft` : "undo: klaar");
  process.exitCode = left ? 1 : 0;
}

try {
  if (cmd === "plan") planOrApply(false);
  else if (cmd === "apply") planOrApply(true);
  else if (cmd === "verify") verify();
  else if (cmd === "proof") await proof();
  else if (cmd === "brokers") brokers();
  else if (cmd === "undo") undo();
  else refuse("gebruik: plan|apply|verify|proof|brokers|undo (zie de kop van dit script)");
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  console.error(`FOUT: ${e.message}`);
  process.exitCode = 1;
}
