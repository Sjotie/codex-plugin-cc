#!/usr/bin/env node
// #1762: install a codex-plugin-cc release (Sjotie fork) into every Claude config home on this machine.
// The same script serves the Mac (1.0.7-sjotie.22.1) and omarchy (1.0.7-sjotie.24). A one-off tool: it does
// one thing per directory and refuses anything it did not expect, instead of reconciling it.
//
//   node 1762-install.mjs plan    --version V --sha SHA --branch B   reads only; shows what apply would change
//   node 1762-install.mjs apply   --version V --sha SHA --branch B   installs V
//   node 1762-install.mjs verify  --version V --sha SHA              per account: entries, cache == git archive, marketplace
//   node 1762-install.mjs proof   --version V                         per account and codex entry: spawn via the installed code
//   node 1762-install.mjs brokers                                     reads only: running brokers, version, tag
//   node 1762-install.mjs undo    --version V                         undoes exactly what apply V changed, or fails
//   --skip-home <path> (repeatable): a config home known to have no plugins; listed, not counted as red.
//
// Homes: every directory ~/.claude* and every ~/.homebase/factory-acp/accounts/claude/<account>. A home without a
// plugins directory is red unless named with --skip-home; no plugins directory at all is red.
//
// apply and undo hold one lock per real plugins directory (homes that symlink to one directory count once) for the
// whole run: the file codex-1762-install.lock (O_EXCL|O_NOFOLLOW, holding pid, host, time and a run nonce). A lock
// that exists refuses the run; a run releases only a lock that still holds its own record (unlink). After a crash,
// remove it by hand once that installer and its git children no longer run. Inside the locks, apply first checks every directory and only
// then writes:
//   - no restore point yet: everything must look as expected (marketplace checkout clean if it has to move, sha
//     fetchable from origin <branch>, an existing cache directory equal to `git archive <sha> plugins/codex`, every
//     codex installPath inside this directory's cache, no symlinks on the paths it writes).
//   - a restore point exists (an earlier apply V): nothing is written. If everything is exactly on V, apply says so
//     and exits 0; otherwise it refuses and lists what differs. Run undo first.
// Writes, per directory: the restore point codex-restore-1762-<V>.json (marketplace HEAD and branch, every
// codex@openai-codex entry as it was, and the lastUpdated apply will write); the marketplace checkout, detached at
// <sha>; cache/openai-codex/codex/<V>; and in installed_plugins.json only the fields installPath, version,
// gitCommitSha and lastUpdated of the codex entries the restore point knows. installed_plugins.json is read again
// right before the atomic rename and the write starts over when someone changed it (Claude Code is not under our
// lock). Every new file is created exclusively under a random name, never through a symlink.
// undo sets back the codex entries that hold exactly what apply wrote and the marketplace if it is still at <sha>.
// Anything else (changed, unknown or missing entries, a moved checkout) is reported; undo then exits 1 and keeps
// the restore point. It never touches other plugins, plugin state (CLAUDE_PLUGIN_DATA, state locks, job index),
// settings, logins, the cache directory (a running companion may use it), or a process it did not start.
//
// Detached HEAD is not a pin: a marketplace update by Claude Code (`/plugin marketplace update`, or autoUpdate on
// the marketplace) moves the checkout back to origin's default branch and can install that version. verify then
// shows marketplace != <sha> and/or another version (exit 1); it also prints the marketplace's autoUpdate setting.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKET = "openai-codex", PLUGIN = "codex", KEY = `${PLUGIN}@${MARKET}`;
const TAG_NAME = "FACTORY_PROC_TAG", MARKER_NAME = "CX1762_PROOF_MARKER";
const VERSION_RE = /^\d+\.\d+\.\d+-sjotie\.\d+(?:\.\d+)?$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const LOCK_NAME = "codex-1762-install.lock";
const PROOF_DEADLINE_MS = 90_000;
const FIELDS = ["installPath", "version", "gitCommitSha", "lastUpdated"];

let args = [];
let deps = {}; // injected by tests/harness.mjs only: beforeRename(), stubLifetimeMs, stopDelayMs
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const opts = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [path.resolve(args[i + 1])] : []));
class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };
const need = (name) => opt(name) ?? refuse(`--${name} ontbreekt`);
/**
 * Every external command goes through here: a 64 MB output limit instead of Node's 1 MB default (`ps -ax` on a busy
 * Mac is larger than 1 MB). Output over the limit, a timeout, a command that cannot start and a command stopped by a
 * signal become a refusal (FOUT, exit 1) that names the command and its directory. Only a normal non-zero exit is
 * thrown as is, because some callers read it as an answer (diff 1 = differs, git cat-file -e = no such commit).
 */
const OUT_MAX = 64 << 20;
function sh(cmd, argv, o = {}) {
  try { return execFileSync(cmd, argv, { maxBuffer: OUT_MAX, ...o }); } catch (e) {
    const what = `${cmd} ${argv.join(" ")}`.slice(0, 200) + (o.cwd ? ` (in ${o.cwd})` : "");
    if (e.code === "ENOBUFS") refuse(`${what}: uitvoer groter dan ${(o.maxBuffer ?? OUT_MAX) >> 20} MB; afgebroken, niets aangenomen`);
    if (e.code === "ETIMEDOUT") refuse(`${what}: duurde langer dan ${Math.round((o.timeout ?? 0) / 1000)} s; afgebroken`);
    if (typeof e.code === "string") refuse(`${what}: kon niet draaien (${e.code})`);
    if (e.signal) refuse(`${what}: gestopt door ${e.signal}`);
    throw e;
  }
}
const git = (cwd, ...a) => sh("git", a, { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const versionPath = (installPath, v) => path.join(path.dirname(installPath), v);
const restorePath = (dir, v) => path.join(dir, `codex-restore-1762-${v}.json`);
const entryKey = (e) => `${e.scope}|${e.projectPath ?? ""}`;
const pick = (e) => Object.fromEntries(FIELDS.map((k) => [k, e[k] ?? null]));
const same = (a, b) => (a ?? null) === (b ?? null);
const codexEntries = (installed) => readJson(installed).plugins?.[KEY] ?? [];

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
  try { sh("git", ["check-ref-format", "--branch", b], { stdio: "ignore" }); } catch (e) { if (e instanceof Refusal) throw e; refuse(`--branch ${JSON.stringify(b)} is geen geldige branchnaam`); }
  return b;
}

/** Every Claude config home with its real plugins directory (null when missing). */
function discoverHomes(home = os.homedir()) {
  const homes = [];
  for (const n of fs.readdirSync(home).sort()) if (n.startsWith(".claude") && isDir(path.join(home, n))) homes.push(path.join(home, n));
  const acc = path.join(home, ".homebase/factory-acp/accounts/claude");
  if (isDir(acc)) for (const n of fs.readdirSync(acc).sort()) if (isDir(path.join(acc, n))) homes.push(path.join(acc, n));
  return homes.map((h) => ({ home: h, real: isDir(path.join(h, "plugins")) ? real(path.join(h, "plugins")) : null }));
}
/** Homes, the real plugins directories with their homes, the skip set, and whether something is red. */
function survey() {
  const skip = new Set(opts("skip-home"));
  const homes = discoverHomes();
  const dirs = new Map();
  let missing = 0;
  for (const h of homes) {
    if (!h.real) {
      if (skip.has(path.resolve(h.home))) console.log(`overgeslagen op verzoek (geen plugins-map): ${h.home}`);
      else { console.log(`ROOD: ${h.home} heeft geen plugins-map (noem hem met --skip-home als dat klopt)`); missing++; }
      continue;
    }
    if (!dirs.has(h.real)) dirs.set(h.real, []);
    dirs.get(h.real).push(h.home);
  }
  if (!dirs.size) console.log("ROOD: geen enkele plugins-map gevonden");
  return { homes, dirs: new Map([...dirs].sort(([a], [b]) => a.localeCompare(b))), skip, red: missing > 0 || dirs.size === 0 };
}

/**
 * The lock is one file per plugins directory, codex-1762-install.lock, created with O_CREAT|O_EXCL|O_NOFOLLOW; the
 * owner record goes through that same descriptor. Format: `pid <n> op <host> sinds <ISO time> run <16 hex>`, at
 * most 400 bytes. The run nonce makes the record of this run unique.
 */
const LOCK_MAX = 400;
const safeHost = () => (os.hostname().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 253) || "onbekend");
const OWNER_RE = /^pid ([1-9]\d{0,9}) op ([A-Za-z0-9._-]{1,253}) sinds (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) run ([0-9a-f]{16})$/;
/** A valid owner record, or null: wrong format, an impossible time, or longer than LOCK_MAX bytes. */
function parseOwner(text) {
  const m = OWNER_RE.exec(text);
  if (!m) return null;
  const t = new Date(m[3]);
  return Number.isNaN(t.getTime()) || t.toISOString() !== m[3] ? null : text;
}
/**
 * Reads an existing lock without following a symlink. kind: "record" (with text), "leeg" (created, record not yet
 * written), "onleesbaar" (wrong format, impossible time, binary, or an open error such as EACCES), "geen bestand"
 * (a symlink, a directory or another non-file: nothing is read) or "weg". The read is bounded; the format alone
 * already limits a valid record to about 320 bytes, the extra byte only keeps a huge file from being read.
 */
function readLock(lock) {
  let fd;
  try { fd = fs.openSync(lock, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)); } catch (e) {
    if (e.code === "ENOENT") return { kind: "weg" };
    if (["ELOOP", "EMLINK", "EISDIR", "ENOTDIR", "ENXIO"].includes(e.code)) return { kind: "geen bestand" };
    return { kind: "onleesbaar", why: e.code };
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { kind: "geen bestand" };
    const buf = Buffer.alloc(LOCK_MAX + 1);
    const n = fs.readSync(fd, buf, 0, LOCK_MAX + 1, 0);
    if (n === 0) return { kind: "leeg" };
    if (n > LOCK_MAX) return { kind: "onleesbaar" };
    const text = parseOwner(buf.subarray(0, n).toString("latin1").replace(/\n$/, ""));
    return text ? { kind: "record", text } : { kind: "onleesbaar" };
  } finally { fs.closeSync(fd); }
}
const describeLock = (seen) => ({
  record: seen.text, leeg: "eigenaar nog niet geschreven: net gestart, of vlak na het aanmaken gestopt", weg: "net weer weg; probeer opnieuw",
  onleesbaar: `eigenaar onleesbaar${seen.why ? `, ${seen.why}` : ""}`, "geen bestand": "geen gewoon bestand"
}[seen.kind]);

/** One lock per plugins directory for the whole run; all or none. Ctrl-C or SIGTERM releases the held locks. */
const heldLocks = []; // { path, record }
let signalsInstalled = false;
function lockAll(dirs) {
  if (!signalsInstalled) {
    signalsInstalled = true;
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { unlockAll(heldLocks); process.exit(sig === "SIGINT" ? 130 : 143); });
  }
  const held = [];
  const nonce = crypto.randomBytes(8).toString("hex");
  try {
    for (const dir of dirs) {
      const lock = path.join(dir, LOCK_NAME);
      const record = `pid ${process.pid} op ${safeHost()} sinds ${new Date().toISOString()} run ${nonce}`;
      if (!createExclusive(lock, record + "\n", 0o600)) {
        const seen = readLock(lock);
        if (seen.kind === "geen bestand") refuse(`${lock} bestaat maar is geen gewoon bestand (symlink of map). Deze installer maakt sinds 59911aef alleen een bestand; ` +
          "een map kan van een oudere versie zijn (t/m d4835b7; kijk of die nog draait). Anders: onderzoek wie het neerzette en haal het niet blind weg");
        refuse(`${lock} bestaat (${describeLock(seen)}): een andere installer draait, of een eerdere stopte onverwacht. ` +
          "Haal het bestand pas weg als die installer niet meer draait " +
          `én er geen git-proces van hem meer loopt (bijv. een checkout in marketplaces/${MARKET})`);
      }
      const h = { path: lock, record };
      held.push(h);
      heldLocks.push(h);
    }
  } catch (e) { unlockAll(held); throw e; }
  return held;
}
/**
 * Releases only a lock that still holds this run's own record (unlink, never recursive); anything else stays and is
 * reported. Never throws, so it neither skips the other locks nor hides the error that ended the run. Left open:
 * read and unlink are two steps; a lock removed by hand and recreated by a new run in between would be removed.
 */
function unlockAll(held) {
  for (const h of [...held].reverse()) {
    try {
      const seen = readLock(h.path);
      if (seen.kind === "record" && seen.text === h.record) fs.unlinkSync(h.path);
      else if (seen.kind === "weg") console.error(`let op: ${h.path} verdween tijdens deze run; de uitsluiting gold dus niet de hele run`);
      else console.error(`let op: ${h.path} hoort niet meer bij deze run (${describeLock(seen)}); laten staan`);
    } catch (e) { console.error(`let op: ${h.path} kon niet worden vrijgegeven (${e.code ?? e.message}); haal hem weg na controle`); }
    const i = heldLocks.indexOf(h);
    if (i >= 0) heldLocks.splice(i, 1);
  }
}

/** Creates `file` with `text` only if nothing (also no symlink) is at that path; returns false when something is. */
function createExclusive(file, text, mode) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode); } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } catch (e) { fs.closeSync(fd); fd = null; fs.rmSync(file, { force: true }); throw e; } finally { if (fd !== null) fs.closeSync(fd); }
  return true;
}
const tmpName = (file) => (deps.tmpName ? deps.tmpName(file) : `${file}.tmp-1762-${crypto.randomBytes(8).toString("hex")}`);
function newTmp(file, text, mode) {
  const tmp = tmpName(file);
  if (!createExclusive(tmp, text, mode)) refuse(`${tmp} bestond al; niets geschreven`);
  return tmp;
}

/** Paths apply writes in one plugins directory, checked for symlinks and escapes. */
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
/** Codex entries whose installPath does not lie in this directory's cache. */
function entryProblems(L, entries) {
  const out = [];
  for (const e of entries) {
    if (typeof e.installPath !== "string" || !path.isAbsolute(e.installPath)) { out.push(`installPath ${JSON.stringify(e.installPath)} is niet absoluut`); continue; }
    const parent = real(path.dirname(e.installPath));
    if (parent !== L.cacheParent) { out.push(`installPath ${e.installPath} ligt niet in ${L.cacheParent} (realpath ${parent})`); continue; }
    const r = real(e.installPath);
    if (r !== null && r !== path.join(L.cacheParent, path.basename(e.installPath))) out.push(`installPath ${e.installPath} wijst (realpath) naar ${r}, buiten ${L.cacheParent}`);
  }
  return out;
}
function treeEqual(a, b) {
  // diff -r, ignoring the .in_use marker Claude Code keeps in a cache directory.
  try { sh("diff", ["-r", "-q", "-x", ".in_use", a, b], { stdio: "ignore", timeout: 120_000 }); return true; } catch (e) {
    if (e instanceof Refusal) throw e;
    if (e.status === 1) return false; // the trees differ
    refuse(`diff -r ${a} ${b}: exit ${e.status}; vergelijking niet gelukt`);
  }
}
function archiveTo(repo, s, dest) {
  const tar = sh("git", ["archive", s, "plugins/codex"], { cwd: repo, maxBuffer: 256 << 20, timeout: 120_000 });
  sh("tar", ["-x", "-C", dest, "--strip-components=2"], { input: tar, timeout: 120_000 });
}
function cacheEqual(market, s, cache) {
  const ref = fs.mkdtempSync(path.join(os.tmpdir(), "cx1762-"));
  try { archiveTo(market, s, ref); return treeEqual(ref, cache); } finally { fs.rmSync(ref, { recursive: true, force: true }); }
}
function hasCommit(repo, s) { try { git(repo, "cat-file", "-e", `${s}^{commit}`); return true; } catch (e) { if (e instanceof Refusal) throw e; return false; } }

/** A restore point written by this version of the script; any other refuses (older scripts recorded less). */
function readRecord(rp) {
  if (fs.lstatSync(rp).isSymbolicLink()) refuse(`${rp} is een symlink; geweigerd`);
  const r = readJson(rp);
  if (r.schema !== "codex-restore-1762-v2" || typeof r.appliedAt !== "string" || !Array.isArray(r.entries)) refuse(`${rp} komt niet van deze installerversie (schema ${r.schema ?? "?"}); zet hem met de hand terug of weg`);
  return r;
}

/** What differs from "everything exactly on V" in one directory (empty list = done). */
function deviations(L, record, v, s) {
  const out = [];
  const head = git(L.market, "rev-parse", "HEAD");
  if (head !== s) out.push(`marketplace staat op ${head.slice(0, 9)}, niet op ${s.slice(0, 9)}`);
  if (!fs.existsSync(L.cache)) out.push(`cache ${v} ontbreekt`);
  else if (!hasCommit(L.market, s) || !cacheEqual(L.market, s, L.cache)) out.push(`cache ${v} is niet gelijk aan ${s.slice(0, 9)}`);
  const entries = codexEntries(L.installed);
  for (const e of entries) {
    const rec = record.entries.find((x) => x.key === entryKey(e));
    if (!rec) out.push(`${entryKey(e)}: niet in het herstelpunt (${e.version})`);
    else if (!(e.version === v && e.gitCommitSha === s && rec.before.installPath && e.installPath === versionPath(rec.before.installPath, v))) out.push(`${entryKey(e)}: staat op ${e.version}`);
    else if (!same(e.lastUpdated, record.appliedAt)) out.push(`${entryKey(e)}: op ${v}, maar lastUpdated ${e.lastUpdated} is niet die van apply (opnieuw geïnstalleerd?)`);
  }
  for (const rec of record.entries) if (!entries.some((e) => entryKey(e) === rec.key)) out.push(`${rec.key}: verdwenen sinds apply`);
  return out;
}

/**
 * Read-modify-write of installed_plugins.json that only changes what `change` changes. The file is read again right
 * before the rename; when it differs from what `change` saw, start over (up to 5 times). `change` must only decide.
 */
function updateInstalled(file, change) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const before = fs.readFileSync(file, "utf8");
    const data = JSON.parse(before);
    const result = change(data);
    if (!result.changed) return result;
    const tmp = newTmp(file, JSON.stringify(data, null, 2) + "\n", fs.statSync(file).mode & 0o777);
    try {
      deps.beforeRename?.();
      if (fs.readFileSync(file, "utf8") !== before) { console.log(`   ${path.basename(file)}: tussentijds gewijzigd door een ander; opnieuw (poging ${attempt})`); continue; }
      fs.renameSync(tmp, file);
      return result;
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  refuse(`${file} bleef veranderen tijdens het schrijven; niets geschreven`);
}

function planOrApply(apply) {
  const v = version(), s = sha(), b = branch();
  const { dirs, red } = survey();
  if (red) refuse("niet elke config-home heeft een plugins-map (zie ROOD hierboven); niets geschreven");
  const held = apply ? lockAll([...dirs.keys()]) : [];
  try {
    // Phase 1: check every directory; nothing is written before all pass.
    const work = [];
    for (const [dir, users] of dirs) {
      const L = layout(dir, v);
      const problems = [...L.problems];
      const entries = problems.length ? [] : codexEntries(L.installed);
      problems.push(...entryProblems(L, entries));
      if (!problems.length && !entries.length) problems.push(`${L.installed} heeft geen ${KEY}-regels`);
      const keys = entries.map(entryKey);
      for (const k of new Set(keys.filter((k, i) => keys.indexOf(k) !== i))) problems.push(`${L.installed}: twee codex-regels met dezelfde scope en projectPath (${k})`);
      const rp = restorePath(dir, v);
      let record = null;
      if (!problems.length && fs.existsSync(rp)) {
        record = readRecord(rp);
        if (record.sha !== s || record.version !== v) problems.push(`${rp} hoort bij ${record.version}@${record.sha}, niet bij deze sha`);
        else {
          const off = deviations(L, record, v, s);
          if (off.length) problems.push(`herstelpunt ${path.basename(rp)} bestaat (een eerdere apply), maar niet alles staat op ${v}:`, ...off.map((x) => `  ${x}`), "draai eerst undo");
        }
      }
      if (!problems.length && !record) {
        if (git(L.market, "rev-parse", "HEAD") !== s && git(L.market, "status", "--porcelain")) problems.push(`${L.market} heeft lokale wijzigingen en moet naar een andere commit`);
        // Fetching only adds objects; HEAD, the work tree and the refs Claude Code reads stay as they are.
        if (apply && !hasCommit(L.market, s)) {
          try { git(L.market, "fetch", "--quiet", "origin", b); } catch (e) { problems.push(`fetch origin ${b} mislukt: ${String(e.stderr ?? e.message).trim().split("\n").pop()}`); }
          if (!hasCommit(L.market, s)) problems.push(`sha ${s} niet op te halen van origin ${b}`);
        }
        if (hasCommit(L.market, s) && fs.existsSync(L.cache) && !cacheEqual(L.market, s, L.cache)) problems.push(`${L.cache} bestaat al en verschilt van ${s.slice(0, 9)}`);
      }
      if (problems.length) refuse(`${dir}:\n   ${problems.join("\n   ")}\nniets geschreven`);
      work.push({ dir, users, L, done: record !== null });
    }
    // Phase 2: write. A refusal after a restore point was written says so (undo sets back what apply changed).
    let changes = 0;
    let recordWritten = null;
    try {
    for (const { dir, users, L, done } of work) {
      console.log(`\n== ${dir}  (gebruikt door: ${users.join(", ")})`);
      if (done) { console.log(`   alles staat al op ${v} (herstelpunt van een eerdere apply); niets te doen`); continue; }
      const head = git(L.market, "rev-parse", "HEAD");
      let headBranch = "";
      try { headBranch = git(L.market, "symbolic-ref", "-q", "--short", "HEAD"); } catch (e) { if (e instanceof Refusal) throw e; /* detached */ }
      const appliedAt = new Date().toISOString();
      const entries = codexEntries(L.installed);
      const keysNow = entries.map(entryKey);
      if (new Set(keysNow).size !== keysNow.length || entryProblems(L, entries).length) refuse(`${L.installed} veranderde sinds de controle (dubbele of ongeldige codex-regels); gestopt vóór de eerste wijziging hier`);
      const record = { schema: "codex-restore-1762-v2", version: v, sha: s, appliedAt, marketplace: { head, branch: headBranch },
        entries: entries.map((e) => ({ key: entryKey(e), before: pick(e) })) };
      console.log(`   herstelpunt: nieuw (marketplace ${head.slice(0, 9)}${headBranch ? ` op ${headBranch}` : ""}, ${entries.length} codex-regels)`);
      console.log(head === s ? `   marketplace: al op ${s.slice(0, 9)}` : `   marketplace: ${head.slice(0, 9)} -> ${s.slice(0, 9)} (checkout --detach)`);
      console.log(fs.existsSync(L.cache) ? `   cache: ${v} bestaat al${hasCommit(L.market, s) ? " en klopt" : "; vergelijking volgt bij apply (sha nog niet lokaal)"}` : `   cache: ${v} nieuw uit ${s.slice(0, 9)}`);
      for (const e of entries) console.log(`   installed_plugins.json: ${e.scope}${e.projectPath ? ` (${e.projectPath})` : ""} ${e.version} -> ${v}`);
      changes++;
      if (!apply) continue;
      const rp = restorePath(dir, v);
      const tmp = newTmp(rp, JSON.stringify(record, null, 2) + "\n", 0o600);
      try { fs.linkSync(tmp, rp); } catch (e) { if (e.code === "EEXIST") refuse(`${rp} verscheen tijdens de run; gestopt vóór de eerste wijziging hier`); throw e; } finally { fs.rmSync(tmp, { force: true }); }
      recordWritten = rp;
      // Order: the cache first (an extra directory changes nothing), then installed_plugins.json, then the checkout.
      // A refusal before installed_plugins.json leaves only the restore point and the cache: undo then completes.
      if (!fs.existsSync(L.cache)) {
        const tmpDir = fs.mkdtempSync(path.join(L.cacheParent, `.${v}.tmp-1762-`));
        try {
          archiveTo(L.market, s, tmpDir);
          try { fs.renameSync(tmpDir, L.cache); } catch (e) { refuse(`${L.cache} kon niet worden geplaatst (${e.code}); verscheen hij tijdens de run? Gestopt vóór installed_plugins.json`); }
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
      }
      // The callback only decides and refuses before anything is written when an entry changed since the restore point.
      updateInstalled(L.installed, (data) => {
        const list = data.plugins?.[KEY] ?? [];
        const problems = entryProblems(L, list);
        for (const e of list) {
          const rec = record.entries.find((x) => x.key === entryKey(e));
          if (!rec) problems.push(`${entryKey(e)} verscheen tijdens apply`);
          else if (!FIELDS.every((k) => same(e[k], rec.before[k]))) problems.push(`${entryKey(e)} veranderde tijdens apply`);
        }
        if (list.length !== record.entries.length) problems.push("het aantal codex-regels veranderde tijdens apply");
        if (problems.length) refuse(`${L.installed}: ${problems.join("; ")}; niet geschreven. Herstelpunt en cache staan er. ` +
          "undo ruimt het herstelpunt alleen op als geen codex-regel tussentijds veranderde; anders laat undo die regel staan (exit 1) " +
          `en zolang ${path.basename(restorePath(dir, v))} bestaat weigert apply. Verzoen de regel met de hand; wil je de nieuwe waarde houden, ` +
          "verplaats dan na controle het herstelpunt zelf (de cachemap mag blijven)");
        for (const e of list) Object.assign(e, { installPath: versionPath(e.installPath, v), version: v, gitCommitSha: s, lastUpdated: appliedAt });
        return { changed: list.length > 0 };
      });
      if (head !== s) {
        git(L.market, "checkout", "--quiet", "--detach", s);
        if (git(L.market, "rev-parse", "HEAD") !== s) refuse("marketplace HEAD is na checkout niet de sha");
      }
    }
    } catch (e) {
      if (e instanceof Refusal && recordWritten && !e.message.includes("Herstelpunt")) e.message += `. Herstelpunt ${recordWritten} is al geschreven: undo zet terug wat apply hier al veranderde`;
      throw e;
    }
    console.log(`\n${apply ? "toegepast" : "plan"}: ${changes} wijziging(en)${apply ? "" : " (niets geschreven)"}`);
  } finally { unlockAll(held); }
}

function verify() {
  const v = version(), s = sha();
  const { homes, dirs, skip, red } = survey();
  let bad = red ? 1 : 0;
  const dirRow = new Map();
  for (const [dir] of dirs) {
    const L = layout(dir, v);
    const row = { plugins: dir };
    if (L.problems.length) { row.problems = L.problems; dirRow.set(dir, row); bad++; continue; }
    const entries = codexEntries(L.installed);
    row.installed = entries.map((e) => `${e.scope}:${e.version}@${(e.gitCommitSha ?? "").slice(0, 9)}`).join(" ") || "(geen)";
    row.marketplace = git(L.market, "rev-parse", "HEAD").slice(0, 9);
    try { row.autoUpdate = readJson(path.join(dir, "known_marketplaces.json"))[MARKET]?.autoUpdate ?? "(niet gezet)"; } catch { row.autoUpdate = "(onleesbaar)"; }
    if (!hasCommit(L.market, s)) row.cacheGelijkAanArchief = `sha ${s.slice(0, 9)} niet in de marketplace-checkout`;
    else {
      // One archive per directory, compared with every distinct installed path.
      const ref = fs.mkdtempSync(path.join(os.tmpdir(), "cx1762v-"));
      try {
        archiveTo(L.market, s, ref);
        const paths = [...new Set(entries.map((e) => real(e.installPath)))];
        row.cacheGelijkAanArchief = entries.length > 0 && paths.every((p) => p && treeEqual(ref, p));
      } finally { fs.rmSync(ref, { recursive: true, force: true }); }
    }
    row.ok = entries.length > 0 && entries.every((e) => e.version === v && e.gitCommitSha === s) && row.cacheGelijkAanArchief === true && row.marketplace === s.slice(0, 9);
    if (!row.ok) bad++;
    dirRow.set(dir, row);
  }
  let counted = 0;
  for (const h of homes) {
    const skipped = !h.real && skip.has(path.resolve(h.home));
    if (!skipped) counted++;
    console.log(JSON.stringify({ account: h.home, ...(h.real ? dirRow.get(h.real) : { plugins: "(geen)", ok: skipped ? "overgeslagen" : false }) }));
  }
  console.log(bad ? `verify: ROOD (${bad})` : `verify: alle ${counted} accounts op ${v} (${s.slice(0, 9)}), cache gelijk aan het archief${skip.size ? `; ${skip.size} overgeslagen op verzoek` : ""}`);
  process.exitCode = bad ? 1 : 0;
}

/**
 * The variables we look for in a running pid's environment: /proc on Linux, `ps -E` on macOS. Null when unreadable
 * (proof then counts it as not measured, which is red). Output over the limit is not unreadable but an error: it
 * stops the run (FOUT, exit 1), so a cut-off read never counts as "no tag".
 */
function envOf(pid, names = [TAG_NAME, MARKER_NAME, "CLAUDE_CONFIG_DIR"]) {
  try {
    if (process.platform === "linux") {
      const all = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
      return Object.fromEntries(names.map((n) => [n, all[n]]));
    }
    const line = sh("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
    if (!/(?:^|\s)PATH=/.test(line)) return null; // ps showed no environment for this pid: unreadable, not "no tag"
    return Object.fromEntries(names.map((n) => [n, line.match(new RegExp(`(?:^|\\s)${n}=(\\S*)`))?.[1]]));
  } catch (e) {
    if (e instanceof Refusal) throw e;
    return null;
  }
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
const running = (t) => !t.exited && t.child.exitCode === null && t.child.signalCode === null;
/** Stops a child through its handle (SIGTERM, then SIGKILL, 3 s each); returns how it ended. */
async function stopTracked(t) {
  if (!running(t)) return "al beëindigd";
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    // A handle that saw exit is never signalled; an exited child Node has not reaped yet keeps its pid reserved.
    if (!running(t)) return "gestopt";
    t.child.kill(sig);
    let timer;
    await Promise.race([t.exitPromise, new Promise((r) => { timer = setTimeout(r, 3000); })]);
    clearTimeout(timer); // a pending timer would keep this process alive after the proof
  }
  return running(t) ? "loopt nog" : "gestopt";
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
  // No new measurement starts after the deadline. One that is running can still overrun it: an env read on macOS
  // (execFileSync ps, timeout 10 s, blocks the event loop meanwhile), the import of an installed module and its
  // spawnBrokerProcess call (installed code, no timeout). The cleanup after that takes at most 6 s (all children in
  // parallel). A soft bound for an interactive check, not a guarantee.
  const deadline = Date.now() + PROOF_DEADLINE_MS;
  const sessionTag = process.env[TAG_NAME];
  const tag = sessionTag && /^[0-9a-f]{32}$/.test(sessionTag) ? sessionTag : crypto.randomBytes(16).toString("hex");
  console.log(`proof met ${tag === sessionTag ? "de eigen sessietag" : sessionTag ? "een testtag (de sessietag heeft een onverwachte vorm)" : "een testtag (deze shell heeft geen sessietag)"}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx1762p-"));
  const stub = path.join(dir, "stub-broker.mjs");
  // Stands in for app-server-broker.mjs: starts no app-server, ends when proof ends or after its lifetime.
  fs.writeFileSync(stub, "const p = process.ppid, end = Date.now() + Number(process.env.CX1762_STUB_MS);\n" +
    "setInterval(() => { if (process.ppid !== p || Date.now() > end) process.exit(0); }, 100);\n");
  const stubMs = String(deps.stubLifetimeMs ?? PROOF_DEADLINE_MS + 30_000);
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
      if (!h.real) { console.log(JSON.stringify({ account: h.home, fout: "geen plugins-map" })); continue; } // counted by survey()
      const installed = path.join(h.real, "installed_plugins.json");
      const entries = fs.existsSync(installed) ? codexEntries(installed) : [];
      if (!entries.length) { console.log(JSON.stringify({ account: h.home, fout: `geen ${KEY}-regels` })); bad++; continue; }
      // Every codex entry counts: one that is not on V is red, whatever the others show.
      for (const e of entries.filter((x) => x.version !== v)) { console.log(JSON.stringify({ account: h.home, regel: entryKey(e), fout: `staat op ${e.version}, niet op ${v}` })); bad++; }
      for (const installPath of [...new Set(entries.filter((x) => x.version === v).map((x) => x.installPath))]) {
        if (Date.now() > deadline) { console.log(JSON.stringify({ account: h.home, code: installPath, fout: "deadline voorbij; niet gemeten" })); bad++; continue; }
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
    if (deps.stopDelayMs) await sleep(deps.stopDelayMs);
    const ends = await Promise.all(tracked.map(async (t) => ({ pid: t.child.pid, einde: await stopTracked(t) })));
    for (const e of ends) { console.log(JSON.stringify({ opruimen: e })); if (e.einde === "loopt nog") bad++; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(bad ? `proof: ROOD (${bad})` : "proof: geen enkele via de geïnstalleerde code gestarte broker draagt de tag; de controle wel");
  process.exitCode = bad ? 1 : 0;
}

function brokers() {
  // Reads only: every running app-server-broker.mjs of this user, its plugin version (from the script path) and tag.
  const out = sh("ps", ["-axww", "-o", "pid=,user=,command="], { encoding: "utf8", timeout: 10_000 });
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
  const held = lockAll([...dirs.keys()]);
  let left = 0;
  try {
    for (const [dir] of dirs) {
      const rp = restorePath(dir, v);
      if (!fs.existsSync(rp)) { console.log(`${dir}: geen herstelpunt voor ${v}; niets gedaan`); continue; }
      const r = readRecord(rp);
      const L = layout(dir, v);
      if (L.problems.length) { console.log(`${dir}: ${L.problems.join("; ")}; niets gedaan`); left++; continue; }
      console.log(`== ${dir}`);
      // The callback only decides (it may run again after a concurrent write); output and counting follow once.
      const res = updateInstalled(L.installed, (data) => {
        const list = data.plugins?.[KEY] ?? [];
        const lines = [];
        let changed = false, skipped = 0;
        for (const e of list) {
          const rec = r.entries.find((x) => x.key === entryKey(e));
          if (!rec) { lines.push(`   ${entryKey(e)}: niet in het herstelpunt (${e.version}); niet aangeraakt`); skipped++; continue; }
          const ours = e.version === r.version && e.gitCommitSha === r.sha && same(e.lastUpdated, r.appliedAt) && rec.before.installPath && e.installPath === versionPath(rec.before.installPath, r.version);
          if (FIELDS.every((k) => same(e[k], rec.before[k]))) continue;
          if (!ours) { lines.push(`   ${entryKey(e)}: veranderd sinds apply (nu ${e.version}@${String(e.gitCommitSha).slice(0, 9)}); niet aangeraakt`); skipped++; continue; }
          for (const k of FIELDS) { if (rec.before[k] === null) delete e[k]; else e[k] = rec.before[k]; }
          changed = true;
          lines.push(`   ${entryKey(e)}: terug op ${rec.before.version}`);
        }
        for (const rec of r.entries) if (!list.some((e) => entryKey(e) === rec.key)) { lines.push(`   ${rec.key}: verdwenen sinds apply; niet teruggezet`); skipped++; }
        return { changed, lines, skipped };
      });
      for (const l of res.lines) console.log(l);
      let notDone = res.skipped;
      const head = git(L.market, "rev-parse", "HEAD");
      if (head === r.marketplace.head) console.log(`   marketplace: staat al op ${head.slice(0, 9)}`);
      else if (head !== r.sha) { console.log(`   marketplace: veranderd sinds apply (nu ${head.slice(0, 9)}); niet aangeraakt`); notDone++; }
      else if (git(L.market, "status", "--porcelain")) { console.log("   marketplace: lokale wijzigingen; niet aangeraakt"); notDone++; }
      else {
        let tip = "";
        try { tip = r.marketplace.branch ? git(L.market, "rev-parse", `refs/heads/${r.marketplace.branch}`) : ""; } catch (e) { if (e instanceof Refusal) throw e; /* branch gone */ }
        if (r.marketplace.branch && tip === r.marketplace.head) git(L.market, "checkout", "--quiet", r.marketplace.branch);
        else git(L.market, "checkout", "--quiet", "--detach", r.marketplace.head);
        console.log(`   marketplace: terug op ${r.marketplace.head.slice(0, 9)}${r.marketplace.branch && tip === r.marketplace.head ? ` (${r.marketplace.branch})` : ""}`);
      }
      if (notDone) console.log(`   herstelpunt blijft staan (${notDone} niet teruggezet)`);
      else fs.renameSync(rp, rp.replace(/\.json$/, `.undone-${new Date().toISOString().replace(/[:.]/g, "")}.json`));
      console.log(`   cache/${MARKET}/${PLUGIN}/${v} blijft staan; weghalen pas als brokers hem niet meer toont`);
      left += notDone;
    }
  } finally { unlockAll(held); }
  console.log(left ? `undo: ${left} onderdeel/onderdelen niet teruggezet (zie hierboven); herstelpunt blijft` : "undo: klaar");
  process.exitCode = left ? 1 : 0;
}

/** Entry point; tests/harness.mjs calls it with injected test dependencies, the CLI with none. */
export async function main(argv, injected = {}) {
  args = argv;
  deps = injected;
  const cmd = args[0];
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
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) await main(process.argv.slice(2));
