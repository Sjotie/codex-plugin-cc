// fenced-lock: one lock primitive for the Codex plugin state lock and the
// host reaper lock (Homebase #1916; design docs/design/1916-state-lock-admission.md
// in the homebase repo, v2.10). Source: factory-core shared/fenced-lock; the
// plugin keeps a byte-equal copy (fenced-lock.source.json).
//
// <fencePath> (e.g. state.lock) becomes a directory, the fence: old writers
// cannot take a directory as their lock and cannot remove it. Next to it,
// <fencePath>.db is the only authority: the owner is the process holding an
// SQLite BEGIN EXCLUSIVE (a kernel fcntl lock) on it. No step of this module
// ever moves, replaces or removes that file, and nothing here opens it with fs
// (closing any fd on it would drop the fcntl lock, rule P5).
//
// A fence only admits new writers once it is sealed (I6): right after the
// fence appears, the module checks for O2 residues (a pending lock file with
// two names) and then scans for old plugin processes (S0). The seal is written
// once every process in S0 is gone or now holds the protocol marker (v2.10). The module never puts anything back on
// the fence path and never deletes a file an old writer can observe.
//
// Plain ESM without dependencies; node:sqlite (Node >= 22.13) or bun:sqlite.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROTOCOL_MARKER = "fenced-lock.protocol-1";
// macOS gets the verdict "initial" only after the landing proof M2 (design §9)
// is green on a build. Until then every macOS scan is "unknown".
export const MACOS_SCAN_PROVEN = false;

const INIT_PID_NS = "pid:[4026531836]";
const PROC_SUPER_MAGIC = 0x9fa0;
const PF_KTHREAD = 0x00200000;
const RECORD_NAME = "fence.json";
const OWNER_NAME = "owner.json";
const README_TEXT = "Do not remove: this is the fence of a fenced lock (#1916). The owner of this lock has a status command that explains it.\n";
const GONE_CODES = new Set(["ENOENT", "ESRCH"]);
const RENAME_LOST_CODES = new Set(["ENOTDIR", "ENOTEMPTY", "EEXIST", "EISDIR"]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class StateLockUnavailable extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "StateLockUnavailable";
    this.code = "ESTATELOCKUNAVAILABLE";
    this.reason = reason ?? null;
  }
}

export class StateLockLost extends Error {
  constructor(message) {
    super(`ESTATELOCKLOST: ${message}`);
    this.name = "StateLockLost";
    this.code = "ESTATELOCKLOST";
  }
}

export class StateLockTimeout extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "StateLockTimeout";
    this.code = "ESTATELOCKTIMEOUT";
    this.reason = reason ?? null;
  }
}

export class FencedLockError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "FencedLockError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Load-time state: the protocol marker fd (held for the life of the process,
// P2-1) and the SQLite binding.
// ---------------------------------------------------------------------------

let markerFd = null;
let markerError = null;
try {
  markerFd = fs.openSync(fileURLToPath(new URL(`./${PROTOCOL_MARKER}`, import.meta.url)), "r");
} catch (error) {
  markerError = error?.code ?? String(error);
}

export function protocolMarker() {
  return { held: markerFd !== null, error: markerError };
}

const sqlite = await loadSqlite();

async function loadSqlite() {
  if (process.platform === "win32") {
    return { error: "Windows: the state lock is not supported yet (#1916, D5)", reason: "WINDOWS" };
  }
  try {
    if (typeof globalThis.Bun !== "undefined") {
      const { Database } = await import("bun:sqlite");
      return { kind: "bun", open: (file) => new Database(file) };
    }
    // Node 22 warns that SQLite is experimental: filter exactly that warning (P9).
    const emitWarning = process.emitWarning;
    process.emitWarning = function (warning, ...rest) {
      const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
      const text = typeof warning === "string" ? warning : warning?.message;
      if (type === "ExperimentalWarning" && /sqlite/i.test(String(text))) return;
      return emitWarning.call(this, warning, ...rest);
    };
    try {
      const { DatabaseSync } = await import("node:sqlite");
      return { kind: "node", open: (file) => new DatabaseSync(file) };
    } finally {
      process.emitWarning = emitWarning;
    }
  } catch (error) {
    return {
      error: `the state lock needs Node >= 22.13 for node:sqlite (running ${process.version})`,
      reason: error?.code ?? "NO_SQLITE"
    };
  }
}

export function sqliteRuntime() {
  return sqlite.error ? { available: false, error: sqlite.error, reason: sqlite.reason } : { available: true, kind: sqlite.kind };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();
const hex = (bytes = 8) => randomBytes(bytes).toString("hex");
const stamp = () => nowIso().replace(/[:.]/g, "-");

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function fileId(st) {
  return `${st.dev}:${st.ino}`;
}

function statId(file) {
  try {
    return fileId(fs.statSync(file, { bigint: true }));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function kindOf(st) {
  if (st === null) return "none";
  if (st.isDirectory()) return "directory";
  if (st.isFile()) return "file";
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFIFO()) return "fifo";
  if (st.isSocket()) return "socket";
  return "other";
}

function writeAtomic(file, text) {
  const temp = `${file}.tmp-${hex(6)}`;
  fs.writeFileSync(temp, text);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readFd(fd) {
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  let position = 0;
  for (;;) {
    const n = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (n === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, n)));
    position += n;
  }
  return Buffer.concat(chunks);
}

function signalProbe(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return error.code === "ESRCH" ? "esrch" : error.code === "EPERM" ? "alive" : "unknown";
  }
}

// ---------------------------------------------------------------------------
// SQLite: BUSY per runtime (U1)
// ---------------------------------------------------------------------------

export function isBusy(error) {
  if (!error) return false;
  if (error.code === "ERR_SQLITE_ERROR" && (Number(error.errcode) & 0xff) === 5) return true;
  if (typeof error.code === "string" && error.code.startsWith("SQLITE_BUSY")) return true;
  return sqlite.kind === "bun" && (Number(error.errno) & 0xff) === 5;
}

function closeQuietly(db) {
  try {
    db.close();
  } catch {
    // closing releases the lock; nothing else to do
  }
}

// ---------------------------------------------------------------------------
// statfs refusal (§4.7, U2)
// ---------------------------------------------------------------------------

const LINUX_REFUSED_FS = new Map([
  [0x6969, "NFS"],
  [0x517b, "SMB"],
  [0xff534d42, "CIFS"],
  [0xfe534d42, "SMB2"],
  [0x65735546, "FUSE"],
  [0x00c36400, "CEPH"],
  [0x01021997, "9P"]
]);

export function fsVerdict(platform, statfsType) {
  if (platform !== "linux") return { verdict: "ok" };
  const name = LINUX_REFUSED_FS.get(Number(statfsType) >>> 0);
  return name ? { verdict: "refuse", name } : { verdict: "ok" };
}

// ---------------------------------------------------------------------------
// Protocol namespace (§4.1, P2-3 of the v2.2 review)
// ---------------------------------------------------------------------------

export function isProtocolName(fencePath, name) {
  const base = path.basename(fencePath);
  return name === base || name.startsWith(`${base}.`);
}

// ---------------------------------------------------------------------------
// Domain verdict (§4.2, U6)
// ---------------------------------------------------------------------------

const SCOPE = {
  initial: {
    linux: "no plugin process without proof of the new protocol runs on this kernel right now",
    darwin: "no plugin process without proof of the new protocol runs on this machine right now"
  },
  limited: "among the processes this command can see"
};

export function domainVerdict(env = {}) {
  const platform = env.platform ?? process.platform;
  const procRoot = env.procRoot ?? "/proc";
  if (platform === "linux") {
    let link;
    try {
      link = fs.readlinkSync(path.join(procRoot, "self", "ns", "pid"));
    } catch (error) {
      return { verdict: "unknown", reason: `/proc/self/ns/pid unreadable (${error.code})`, scope: SCOPE.limited };
    }
    if (link !== INIT_PID_NS) {
      return /^pid:\[\d+\]$/.test(link)
        ? { verdict: "nested", reason: `PID-namespace ${link}`, scope: SCOPE.limited }
        : { verdict: "unknown", reason: `unexpected ns link ${link}`, scope: SCOPE.limited };
    }
    try {
      const type = (env.statfs ?? fs.statfsSync)(procRoot).type >>> 0;
      if (type !== PROC_SUPER_MAGIC) {
        return { verdict: "unknown", reason: `${procRoot} is not procfs (type 0x${type.toString(16)})`, scope: SCOPE.limited };
      }
    } catch (error) {
      return { verdict: "unknown", reason: `statfs ${procRoot} failed (${error.code})`, scope: SCOPE.limited };
    }
    let options;
    try {
      options = procMountOptions(fs.readFileSync(path.join(procRoot, "self", "mountinfo"), "utf8"), procRoot);
    } catch (error) {
      return { verdict: "unknown", reason: `mountinfo unreadable (${error.code})`, scope: SCOPE.limited };
    }
    if (options === null) return { verdict: "unknown", reason: "no procfs mount found on /proc", scope: SCOPE.limited };
    const hidepid = options.find((o) => o.startsWith("hidepid="));
    if (hidepid && !["hidepid=0", "hidepid=off"].includes(hidepid)) {
      return { verdict: "unknown", reason: `/proc mounted with ${hidepid}`, scope: SCOPE.limited };
    }
    if (options.includes("subset=pid")) return { verdict: "unknown", reason: "/proc mounted with subset=pid", scope: SCOPE.limited };
    return { verdict: "initial", reason: "init PID namespace, full procfs", scope: SCOPE.initial.linux };
  }
  if (platform === "darwin") {
    if (!(env.macosScanProven ?? MACOS_SCAN_PROVEN)) {
      return { verdict: "unknown", reason: "macOS: landing proof M2 not yet green for this build", scope: SCOPE.limited };
    }
    const canary = env.canary ?? macosCanary();
    if (!canary.ok) return { verdict: "unknown", reason: `macOS: canary failed (${canary.reason})`, scope: SCOPE.limited };
    return { verdict: "initial", reason: "macOS with M2 and canary", scope: SCOPE.initial.darwin };
  }
  return { verdict: "unknown", reason: `platform ${platform}`, scope: SCOPE.limited };
}

// Mount options (per-mount plus superblock) of the procfs mounted at /proc.
export function procMountOptions(mountinfo, mountPoint = "/proc") {
  for (const line of mountinfo.split("\n")) {
    const [left, right] = line.split(" - ");
    if (!right) continue;
    const fields = left.split(" ");
    if (fields[4] !== mountPoint) continue;
    const [fstype, , superOptions = ""] = right.split(" ");
    if (fstype !== "proc") continue;
    return [...(fields[5] ?? "").split(","), ...superOptions.split(",")];
  }
  return null;
}

function macosCanary() {
  try {
    const out = execFileSync("ps", ["-p", `1,${process.ppid}`, "-o", "pid="], { encoding: "utf8" });
    const pids = new Set(out.split("\n").map((s) => Number(s.trim())).filter(Boolean));
    if (!pids.has(1)) return { ok: false, reason: "pid 1 not visible" };
    if (!pids.has(process.ppid)) return { ok: false, reason: "own parent process not visible" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `ps failed (${error.code ?? error.status})` };
  }
}

// ---------------------------------------------------------------------------
// Process scan (§5): candidates, self, marker test
// ---------------------------------------------------------------------------

const JS_RUNTIME = /^(node|bun)/i;

export function parseProcStat(text) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  const fields = text.slice(close + 2).split(" ");
  // fields[0] is field 3 of proc_pid_stat(5)
  return {
    comm: text.slice(open + 1, close),
    state: fields[0],
    ppid: Number(fields[1]),
    flags: Number(fields[6]),
    start: fields[19]
  };
}

function linuxReader(procRoot) {
  const p = (...parts) => path.join(procRoot, ...parts);
  return {
    stat: (pid) => parseProcStat(fs.readFileSync(p(String(pid), "stat"), "utf8")),
    cmdline: (pid) => {
      const raw = fs.readFileSync(p(String(pid), "cmdline"));
      if (raw.length === 0) return [];
      const parts = raw.toString("utf8").split("\0");
      if (parts[parts.length - 1] === "") parts.pop();
      return parts;
    },
    uid: (pid) => {
      try {
        return fs.statSync(p(String(pid))).uid;
      } catch {
        return null;
      }
    },
    fds: (pid) => {
      const dir = p(String(pid), "fd");
      const links = [];
      for (const name of fs.readdirSync(dir)) {
        try {
          links.push(fs.readlinkSync(path.join(dir, name)));
        } catch {
          // the fd closed while reading
        }
      }
      return links;
    },
    pids: () =>
      fs
        .readdirSync(procRoot)
        .filter((name) => /^\d+$/.test(name))
        .map(Number),
    self: () => {
      const pid = Number(fs.readlinkSync(p("self")));
      return { pid, start: parseProcStat(fs.readFileSync(p("self", "stat"), "utf8")).start };
    }
  };
}

// The /proc reader of the scan, for tests that wrap one of its calls.
export function linuxProcReader(procRoot = "/proc") {
  return linuxReader(procRoot);
}

function hasMarker(links) {
  return links.some((link) => link.replace(/ \(deleted\)$/, "").endsWith(`/${PROTOCOL_MARKER}`));
}

function scanLinux(o) {
  const reader = o.linuxReader ?? linuxReader(o.procRoot);
  const self = { ...reader.self(), matched: false };
  const processes = [];
  for (const pid of reader.pids()) {
    let first;
    try {
      first = reader.stat(pid);
    } catch (error) {
      if (GONE_CODES.has(error.code)) continue;
      processes.push({ pid, start: null, uid: null, comm: null, script: null, sub: null, verdict: "unproven", reason: `stat unreadable (${error.code})` });
      continue;
    }
    if (first.state === "Z") continue;
    if (first.flags & PF_KTHREAD) continue;
    if (pid === self.pid && first.start === self.start) {
      self.matched = true;
      continue;
    }
    let argv = null;
    let argvReason = null;
    try {
      argv = reader.cmdline(pid);
      if (argv.length === 0) argvReason = "argv empty";
    } catch (error) {
      if (GONE_CODES.has(error.code)) continue;
      argvReason = `argv unreadable (${error.code})`;
    }
    let entry;
    if (argv && argv.length > 0) {
      const match = o.argvMatch(argv);
      if (!match) continue;
      entry = { pid, start: first.start, uid: reader.uid(pid), comm: first.comm, script: match.script, sub: match.sub };
      let links = null;
      try {
        links = reader.fds(pid);
      } catch (error) {
        if (GONE_CODES.has(error.code)) continue;
      }
      classify(entry, links === null ? null : hasMarker(links), o);
    } else {
      if (first.comm && !JS_RUNTIME.test(first.comm)) continue;
      entry = { pid, start: first.start, uid: reader.uid(pid), comm: first.comm, script: null, sub: null, verdict: "unproven", reason: argvReason };
    }
    try {
      if (reader.stat(pid).start !== first.start) continue;
    } catch (error) {
      if (GONE_CODES.has(error.code)) continue;
    }
    processes.push(entry);
  }
  return { self, processes };
}

function classify(entry, marker, o) {
  if (marker === true) {
    entry.verdict = "new";
    entry.reason = "holds the protocol marker";
  } else if (o.noLockPathScripts.has(entry.script)) {
    entry.verdict = "no-lock-path";
    entry.reason = "old broker: no path to the lock (build condition 4)";
  } else {
    entry.verdict = "unproven";
    entry.reason = marker === null ? "fds unreadable" : "no marker fd";
  }
}

// ps on macOS: one call per column group, so spaces in comm or args never shift columns.
export function parsePsBasic(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const [pid, ppid, uid, stat, ...lstart] = parts;
    rows.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), uid: Number(uid), stat, start: lstart.join(" ") });
  }
  return rows;
}

export function parsePsColumn(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s?(.*)$/.exec(line);
    if (m) rows.set(Number(m[1]), m[2]);
  }
  return rows;
}

function scanDarwin(o) {
  const ps = (cols) => execFileSync("ps", ["-axww", "-o", cols], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const basic = parsePsBasic(ps("pid=,ppid=,uid=,stat=,lstart="));
  const comms = parsePsColumn(ps("pid=,comm="));
  const args = parsePsColumn(ps("pid=,args="));
  const selfRow = basic.get(process.pid);
  const self = { pid: process.pid, start: selfRow?.start ?? null, matched: Boolean(selfRow) };
  const processes = [];
  for (const row of basic.values()) {
    if (row.pid === process.pid) continue;
    if (row.stat.startsWith("Z")) continue;
    const comm = path.basename(comms.get(row.pid) ?? "");
    const line = (args.get(row.pid) ?? "").trim();
    // ps shows "(comm)" when it may not read the arguments (M3 checks this).
    const unreadable = line === "" || /^\(.*\)$/.test(line);
    let entry;
    if (!unreadable) {
      const match = o.argvMatch(line.split(/\s+/));
      if (!match) continue;
      entry = { pid: row.pid, start: row.start, uid: row.uid, comm, script: match.script, sub: match.sub };
      classify(entry, darwinMarker(row.pid), o);
    } else {
      if (comm && !JS_RUNTIME.test(comm)) continue;
      entry = { pid: row.pid, start: row.start, uid: row.uid, comm, script: null, sub: null, verdict: "unproven", reason: "argv unreadable" };
    }
    processes.push(entry);
  }
  return { self, processes };
}

function darwinMarker(pid) {
  try {
    const out = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-Fn"], { encoding: "utf8" });
    return hasMarker(out.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1)));
  } catch {
    return null;
  }
}

function scanProcesses(o) {
  if (o.scanner) return o.scanner(o);
  if (o.platform === "linux") return scanLinux(o);
  if (o.platform === "darwin") return scanDarwin(o);
  return { self: { pid: process.pid, start: null, matched: false }, processes: [] };
}

export function drainCheck(options = {}) {
  const o = withDefaults(options);
  const domain = o.domain ? o.domain() : domainVerdict({ platform: o.platform, procRoot: o.procRoot });
  const { self, processes } = scanProcesses(o);
  const newCount = processes.filter((p) => p.verdict === "new").length;
  const unprovenCount = processes.filter((p) => p.verdict === "unproven").length;
  return {
    result: unprovenCount === 0 ? "drained" : "not-drained",
    verdict: domain.verdict,
    reason: domain.reason,
    scope: domain.scope,
    self,
    newCount,
    unprovenCount,
    processes
  };
}

// ---------------------------------------------------------------------------
// Liveness and identity of one recorded process
// ---------------------------------------------------------------------------

function readIdentity(o, p) {
  // -> { gone } | { start, state, argv, comm }
  if (o.identityReader) return o.identityReader(p);
  if (o.platform === "linux") {
    const reader = o.linuxReader ?? linuxReader(o.procRoot);
    let st;
    try {
      st = reader.stat(p.pid);
    } catch (error) {
      if (GONE_CODES.has(error.code)) return { gone: true };
      throw error;
    }
    let argv = null;
    try {
      argv = reader.cmdline(p.pid);
    } catch {
      argv = null;
    }
    return { start: st.start, state: st.state, argv, comm: st.comm };
  }
  if (o.platform === "darwin") {
    let out;
    try {
      out = execFileSync("ps", ["-p", String(p.pid), "-o", "stat=,lstart="], { encoding: "utf8" }).trim();
    } catch (error) {
      if (error.status === 1) return { gone: true };
      throw error;
    }
    if (!out) return { gone: true };
    const [state, ...lstart] = out.split(/\s+/);
    let argv = null;
    let comm = null;
    try {
      argv = execFileSync("ps", ["-p", String(p.pid), "-o", "args="], { encoding: "utf8" }).trim().split(/\s+/);
      comm = path.basename(execFileSync("ps", ["-p", String(p.pid), "-o", "comm="], { encoding: "utf8" }).trim());
    } catch {
      // keep what we have
    }
    return { start: lstart.join(" "), state, argv, comm };
  }
  throw new Error(`no identity reader for ${o.platform}`);
}

function aliveIn(o, p) {
  let id;
  try {
    id = readIdentity(o, p);
  } catch {
    return true; // any read error other than gone: alive (conservative)
  }
  if (id.gone) return false;
  if (p.start !== null && id.start !== p.start) return false;
  return !String(id.state).startsWith("Z");
}

// Does a recorded process hold the protocol marker now? true | false | null
// (unknown). A process recorded as unproven while it was still starting (its
// module not yet loaded) proves the new protocol once it holds the marker,
// by the same rule the scan applies (v2.10).
function markerNow(o, p) {
  if (o.markerReader) return o.markerReader(p);
  if (o.platform === "linux") {
    try {
      return hasMarker((o.linuxReader ?? linuxReader(o.procRoot)).fds(p.pid));
    } catch {
      return null;
    }
  }
  if (o.platform === "darwin") return darwinMarker(p.pid);
  return null;
}

// A member of S0 the seal still waits for: alive with its start time, and not
// holding the marker now.
function stillWaitingOn(o, p) {
  return aliveIn(o, p) && markerNow(o, p) !== true;
}

// "same" | "gone" | "changed" | "unverified" for a stop-old target, re-read
// right before a signal. "unverified": same pid and start time, but the argv
// is empty or unreadable (a process that is exiting has released its memory);
// never signalled, only polled until it is gone.
function identityNow(o, target) {
  const id = readIdentity(o, target);
  if (id.gone || String(id.state).startsWith("Z")) return { status: "gone" };
  if (target.start !== null && id.start !== target.start) return { status: "changed" };
  if (target.script) {
    const argv = id.argv ?? [];
    if (argv.length === 0) return { status: "unverified" };
    const at = argv.findIndex((arg) => arg.endsWith(`/scripts/${target.script}`) || arg.endsWith(`\\scripts\\${target.script}`));
    if (at === -1) return { status: "changed" };
    if (target.sub && !String(argv[at + 1] ?? "").startsWith(target.sub)) return { status: "changed" };
  } else if (target.comm && id.comm !== target.comm) {
    return { status: "changed" };
  }
  return { status: "same", stopped: /^[Tt]/.test(String(id.state)) };
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

const HELD = new Set(); // strong references to every held connection (rule N25)

function withDefaults(options) {
  return {
    judgeLegacy: defaultJudgeLegacy,
    ownerInfo: () => ({}),
    argvMatch: () => null,
    residueMatch: () => false,
    noLockPathScripts: new Set(),
    deadlineMs: 10_000,
    retryMs: 50,
    timeoutHint: "",
    platform: process.platform,
    procRoot: "/proc",
    ...options
  };
}

export function defaultJudgeLegacy(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return `old lock unreadable (${error.code})`;
  }
  try {
    const text = readFd(fd).toString("utf8").trim();
    const pid = Number.parseInt(text, 10);
    if (!text || !Number.isInteger(pid) || pid <= 0 || String(pid) !== text) return "old lock empty or unreadable";
    const probe = signalProbe(pid);
    if (probe === "alive") return `old owner alive (pid ${pid})`;
    if (probe === "esrch") return `old lock, pid ${pid} not visible here; no proof of death: state-lock adopt-legacy after drain-check`;
    return `old lock, pid ${pid} unknown`;
  } finally {
    fs.closeSync(fd);
  }
}

export function openFencedLock(fencePath, options = {}) {
  const o = withDefaults(options);
  const F = path.resolve(fencePath);
  const A = `${F}.db`;
  const dir = path.dirname(F);
  const base = path.basename(F);
  const recordPath = path.join(F, RECORD_NAME);
  const residueMatch = (name) => o.residueMatch(name);

  function ensureAvailable() {
    if (sqlite.error) throw new StateLockUnavailable(sqlite.error, sqlite.reason);
    let type = null;
    try {
      type = fs.statfsSync(dir).type;
    } catch (error) {
      if (error.code !== "ENOENT") process.stderr.write(`state-lock: statfs ${dir} failed (${error.code}); continuing\n`);
    }
    if (type !== null) {
      const v = fsVerdict(o.platform, type);
      if (v.verdict === "refuse") {
        throw new StateLockUnavailable(`state-lock refuses ${v.name} for ${dir}: no reliable locks on network or FUSE filesystems`, v.name);
      }
    }
  }

  function unavailable(error, what) {
    const detail = error?.errstr ?? error?.message ?? String(error);
    return new StateLockUnavailable(`state-lock: ${what} ${A} failed (${error?.code ?? "?"}: ${detail})`, error?.code);
  }

  // One attempt at the authority. null = BUSY, "retry" = A was replaced from outside.
  function lockAuthority() {
    const pre = statId(A);
    let db;
    try {
      db = sqlite.open(A);
    } catch (error) {
      throw unavailable(error, "opening");
    }
    try {
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      closeQuietly(db);
      if (isBusy(error)) return null;
      throw unavailable(error, "BEGIN EXCLUSIVE on");
    }
    const post = statId(A);
    if (pre !== null && pre !== post) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // closing drops it anyway
      }
      closeQuietly(db);
      return "retry";
    }
    const h = { db, a: post, fence: null, released: false };
    HELD.add(h);
    return h;
  }

  function unlock(h) {
    if (!h || h.released) return;
    h.released = true;
    try {
      h.db.exec("COMMIT");
    } catch (error) {
      process.stderr.write(`state-lock: COMMIT on release failed (${error?.code}); the kernel releases it at exit\n`);
    }
    closeQuietly(h.db);
    HELD.delete(h);
  }

  function busyReason() {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(F, OWNER_NAME), "utf8"));
      return `held by pid ${owner.pid} since ${owner.acquiredAt}`;
    } catch {
      return "held by another process";
    }
  }

  // Take only the authority (for maintenance commands), within a deadline.
  function authorityOnly(deadlineMs) {
    ensureAvailable();
    fs.mkdirSync(dir, { recursive: true });
    const deadline = performance.now() + deadlineMs;
    for (;;) {
      const h = lockAuthority();
      if (h && h !== "retry") return h;
      if (performance.now() >= deadline) return null;
      sleepSync(o.retryMs);
    }
  }

  // ---- the record --------------------------------------------------------

  function readRecord() {
    try {
      const r = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      const ok =
        r &&
        r.version === 1 &&
        typeof r.verdict === "string" &&
        Array.isArray(r.residues) &&
        (r.S0 === null || Array.isArray(r.S0)) &&
        (r.sealedAt === null || typeof r.sealedAt === "string");
      return ok ? r : null;
    } catch {
      return null;
    }
  }

  function writeRecord(record) {
    writeAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  }

  function residues() {
    const names = fs.readdirSync(dir); // a failing readdir throws: no check is not an empty check
    const found = [];
    for (const name of names) {
      if (!residueMatch(name)) continue;
      let st;
      try {
        st = fs.statSync(path.join(dir, name), { bigint: true }); // stat: O2 follows a symlink too
      } catch (error) {
        if (error.code === "ENOENT") continue;
        found.push({ name, error: error.code });
        continue;
      }
      if (st.isDirectory()) continue;
      if (st.isFile() && st.nlink < 2n) continue;
      found.push({ name, kind: kindOf(st), nlink: Number(st.nlink), dev: String(st.dev), ino: String(st.ino) });
    }
    return found;
  }

  // The domain and the procfs of this process do not change while it lives:
  // read them once per lock.
  let domainMemo = null;
  function currentDomain() {
    domainMemo ??= o.domain ? o.domain() : domainVerdict({ platform: o.platform, procRoot: o.procRoot });
    return domainMemo;
  }

  // The procfs a scan read (Linux): its device, the boot id, and whether it
  // shows the init PID namespace. S0 holds pids and start times as that
  // procfs shows them; only a reader that sees the same numbering can judge
  // them. Elsewhere a missing pid is not a dead process (v2.12).
  let procMemo;
  function procIdentity() {
    if (o.procIdentity) return o.procIdentity();
    if (o.platform !== "linux") return null;
    if (procMemo === undefined) {
      let dev = null;
      try {
        dev = String(fs.statSync(o.procRoot).dev);
      } catch {
        dev = null;
      }
      procMemo = { dev, bootId: bootId(), init: currentDomain().verdict === "initial" };
    }
    return procMemo;
  }

  // Same numbering: the same boot, and either both in the init PID namespace
  // (every full procfs there shows the same pids) or the same procfs mount.
  function sameProc(r) {
    if (o.platform !== "linux") return true; // macOS: one process table, no PID namespaces
    const here = procIdentity();
    const there = r?.scanProc;
    if (!here?.bootId || !there?.bootId || here.bootId !== there.bootId) return false;
    if (here.init && there.init) return true;
    return Boolean(here.dev && there.dev && here.dev === there.dev);
  }

  // replaced: the foreign record an operator's declaration replaces (seal).
  function writeSealRecord({ declaration, replaced = null } = {}) {
    const previous = readRecord();
    const publishedAt = previous?.publishedAt ?? nowIso();
    // A declaration speaks for the namespace it was made in: it carries over
    // only to a scan of the same procfs.
    const decl = declaration ?? (previous && sameProc(previous) ? previous.declaration : null) ?? null;
    const found = residues(); // first the residue check, then the scan (I5b, I6)
    const domain = currentDomain();
    const head = {
      version: 1,
      publishedAt,
      verdict: domain.verdict,
      verdictReason: domain.reason,
      scope: domain.scope,
      declaration: decl,
      scanProc: procIdentity(),
      ...(replaced ? { replacedForeign: replaced } : {})
    };
    if (found.length > 0) {
      writeRecord({ ...head, residues: found, S0: null, scannedAt: null, sealedAt: null });
      return;
    }
    const { processes } = scanProcesses(o);
    const S0 = processes
      .filter((p) => p.verdict === "unproven")
      .map((p) => ({ pid: p.pid, start: p.start, script: p.script, sub: p.sub, comm: p.comm, uid: p.uid, reason: p.reason }));
    writeRecord({ ...head, residues: [], S0, scannedAt: nowIso(), sealedAt: null });
  }

  // Read-only: what an unsealed record means for this process (shared by
  // sealState, which acts on it, and status, which reports it).
  //   sealed | residue | foreign (another procfs, not judgeable here) |
  //   rescan (this init-namespace process scans again) | domain (needs a
  //   declaration) | processes (old ones still alive) | sealable
  function judge(r) {
    if (r.sealedAt) return { state: "sealed" };
    if (r.residues.length > 0) return { state: "residue" };
    const here = currentDomain();
    const same = sameProc(r);
    if (!same && here.verdict !== "initial") return { state: "foreign" };
    if (!same || (here.verdict === "initial" && r.verdict !== "initial" && !r.declaration)) return { state: "rescan" };
    if (r.verdict !== "initial" && !r.declaration) return { state: "domain" };
    const rest = r.S0.filter((p) => stillWaitingOn(o, p));
    return rest.length > 0 ? { state: "processes", rest } : { state: "sealable" };
  }

  function foreignReason(r) {
    const here = currentDomain();
    return `the seal record was made in another procfs (${r.verdict}); this process (${here.verdict}: ${here.reason}) cannot see its old processes, and a pid it cannot see is not a dead one; seal it from the init PID namespace (any state change there, or state-lock stop-old), or here with state-lock seal --declare-cross-namespace once the processes of that record are gone`;
  }

  function residueReason(found) {
    const list = found.map((r) => `${path.join(dir, r.name)} (${r.kind ?? r.error}, nlink ${r.nlink ?? "?"})`).join(", ");
    return `O2 residue with two names: ${list}; remove it by hand (always safe), see state-lock status`;
  }

  function describe(list) {
    return list
      .map((p) => `pid ${p.pid} (${p.script ? `${p.script}${p.sub ? ` ${p.sub}` : ""}` : `${p.comm ?? "?"}, ${p.reason}`}, start ${p.start})`)
      .join(", ");
  }

  function sealState() {
    try {
      let r = readRecord();
      if (!r) {
        writeSealRecord();
        r = readRecord();
        if (!r) return { reason: "seal record unreadable after writing" };
      }
      for (let round = 0; round < 3; round++) {
        const j = judge(r);
        if (j.state === "sealed") return { sealed: true };
        if (j.state === "foreign") return { reason: foreignReason(r) };
        if (j.state === "domain") {
          return { reason: `domain ${r.verdict} (${r.verdictReason}): the seal needs state-lock seal --declare-cross-namespace` };
        }
        if (j.state === "processes") {
          return { reason: `fence not sealed yet; old plugin processes from before the fence: ${describe(j.rest)}; to stop them: state-lock stop-old` };
        }
        if (j.state === "sealable") {
          writeRecord({ ...r, sealedAt: nowIso() });
          return { sealed: true };
        }
        if (j.state === "residue") {
          const found = residues();
          if (found.length > 0) return { reason: residueReason(found) };
          // The residue is gone: a new check and a new scan, after T_r; but
          // never by a reader that cannot judge this record.
          if (!sameProc(r) && currentDomain().verdict !== "initial") return { reason: foreignReason(r) };
        }
        // residue gone, or rescan (v2.7/v2.12: the init namespace scans a record from elsewhere again)
        writeSealRecord();
        r = readRecord();
        if (!r) return { reason: "seal record unreadable after writing" };
      }
      return { reason: "the seal record kept changing" };
    } catch (error) {
      return { reason: `seal cannot be determined (${error.code ?? error.message})` };
    }
  }

  // ---- the fence ---------------------------------------------------------

  function prepare() {
    const P = path.join(dir, `${base}.prep-${hex(8)}`);
    fs.mkdirSync(P);
    try {
      fs.writeFileSync(path.join(P, "README"), o.fenceReadme ?? README_TEXT);
    } catch (error) {
      fs.rmSync(P, { recursive: true, force: true });
      throw error;
    }
    return P;
  }

  function publishFence() {
    const P = prepare();
    try {
      fs.renameSync(P, F);
    } catch (error) {
      fs.rmSync(P, { recursive: true, force: true });
      if (RENAME_LOST_CODES.has(error.code)) return false;
      throw error;
    }
    try {
      writeSealRecord();
    } catch {
      // a fence without a record gets its check and scan on the next acquire
    }
    return true;
  }

  function writeOwner(h) {
    try {
      writeAtomic(
        path.join(F, OWNER_NAME),
        `${JSON.stringify({ ...processFacts(), acquiredAt: nowIso(), ...o.ownerInfo() })}\n`
      );
    } catch (error) {
      process.stderr.write(`state-lock: writing owner.json failed (${error.code}); the lock stays valid\n`);
    }
    void h;
  }

  // One attempt: a held handle with a sealed fence, or a reason to wait.
  function attempt() {
    const h = lockAuthority();
    if (h === null) return { reason: busyReason() };
    if (h === "retry") return { reason: "the lock database was replaced from outside" };
    try {
      for (let round = 0; round < 3; round++) {
        let st;
        try {
          st = lstatOrNull(F);
        } catch (error) {
          unlock(h);
          return { reason: `lstat ${F} failed (${error.code})` };
        }
        if (st === null) {
          publishFence();
          continue;
        }
        if (st.isDirectory()) {
          h.fence = fileId(st);
          const z = sealState();
          if (z.sealed) {
            writeOwner(h);
            return { handle: h };
          }
          unlock(h);
          return { reason: z.reason };
        }
        const reason = st.isFile() ? o.judgeLegacy(F) : `unknown object on ${base} (${kindOf(st)})`;
        unlock(h);
        return { reason };
      }
      unlock(h);
      return { reason: `${base} kept changing` };
    } catch (error) {
      unlock(h);
      throw error;
    }
  }

  function acquire({ deadlineMs = o.deadlineMs } = {}) {
    ensureAvailable();
    fs.mkdirSync(dir, { recursive: true });
    const deadline = performance.now() + deadlineMs;
    let reason = "";
    for (;;) {
      const result = attempt();
      if (result.handle) return result.handle;
      reason = result.reason;
      if (performance.now() >= deadline) {
        throw new StateLockTimeout(`Timed out waiting for state lock: ${F} (${reason})${o.timeoutHint ? `; ${o.timeoutHint}` : ""}`, reason);
      }
      sleepSync(o.retryMs);
    }
  }

  function tryAcquire() {
    ensureAvailable();
    fs.mkdirSync(dir, { recursive: true });
    return attempt().handle ?? null;
  }

  function release(h) {
    unlock(h);
  }

  function assertOwned(h) {
    if (!h || h.released) throw new StateLockLost("the lock was already released");
    const a = statId(A);
    if (a !== h.a) throw new StateLockLost(`${A} was replaced or removed`);
    const st = lstatOrNull(F);
    if (!st || !st.isDirectory() || fileId(st) !== h.fence) throw new StateLockLost(`the fence ${F} was replaced or removed`);
  }

  // ---- maintenance commands ---------------------------------------------

  function legacyInfo() {
    let fd;
    try {
      fd = fs.openSync(F, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      return { error: error.code };
    }
    try {
      const st = fs.fstatSync(fd, { bigint: true });
      const content = readFd(fd);
      return {
        dev: String(st.dev),
        ino: String(st.ino),
        nlink: Number(st.nlink),
        sha256: sha256(content),
        size: content.length,
        content: content.length <= 64 ? content.toString("utf8") : null,
        judgement: o.judgeLegacy(F)
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  function protocolInventory() {
    const counts = { prep: 0, quarantine: 0, adoptLog: 0, retired: 0, temp: 0, other: 0 };
    const anomalies = [];
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => isProtocolName(F, name) && name !== base && name !== `${base}.db` && name !== `${base}.db-journal`);
    } catch {
      return { counts, anomalies };
    }
    for (const name of names) {
      const rest = name.slice(base.length + 1);
      if (rest.startsWith("prep-")) counts.prep++;
      else if (rest.startsWith("retired-")) counts.retired++;
      else if (/^quarantine-.*\.adopt\.json\.tmp-/.test(rest)) counts.temp++;
      else if (/^quarantine-.*\.adopt\.json$/.test(rest)) {
        counts.adoptLog++;
        try {
          JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        } catch {
          anomalies.push({ name, problem: "log unreadable" });
        }
      } else if (rest.startsWith("quarantine-")) {
        counts.quarantine++;
        if (!names.includes(`${name}.adopt.json`)) anomalies.push({ name, problem: "quarantine without its adopt log" });
      } else if (residueMatch(name)) {
        // counted under residues
      } else {
        counts.other++;
        anomalies.push({ name, problem: "unknown name under the prefix" });
      }
    }
    return { counts, anomalies };
  }

  function status() {
    const st = lstatOrNull(F);
    const out = {
      fencePath: F,
      authorityPath: A,
      authorityExists: statId(A) !== null,
      runtime: sqliteRuntime(),
      marker: protocolMarker(),
      kind: kindOf(st),
      record: null,
      sealed: false,
      waitingOn: null,
      owner: null,
      legacy: null,
      residues: [],
      protocolNames: protocolInventory()
    };
    try {
      out.residues = residues();
    } catch (error) {
      out.residues = error.code === "ENOENT" ? [] : [{ error: error.code }];
    }
    if (st?.isDirectory()) {
      out.record = readRecord();
      out.sealed = Boolean(out.record?.sealedAt);
      try {
        out.owner = JSON.parse(fs.readFileSync(path.join(F, OWNER_NAME), "utf8"));
      } catch {
        out.owner = null;
      }
      if (!out.sealed) {
        const r = out.record;
        const j = r ? judge(r) : { state: "no-record" };
        if (j.state === "no-record") out.waitingOn = { kind: "record", detail: "no readable seal record; the next acquire scans" };
        else if (j.state === "residue") out.waitingOn = { kind: "residue", residues: r.residues };
        else if (j.state === "foreign") out.waitingOn = { kind: "foreign", verdict: r.verdict, reason: foreignReason(r) };
        else if (j.state === "rescan") out.waitingOn = { kind: "rescan", detail: "the record was made in another procfs or domain; the next acquire (or stop-old) here scans again" };
        else if (j.state === "domain") out.waitingOn = { kind: "domain", verdict: r.verdict, reason: r.verdictReason };
        else if (j.state === "processes") out.waitingOn = { kind: "processes", processes: j.rest.map((p) => ({ ...p, argv: liveArgv(p) })) };
        else out.waitingOn = { kind: "nothing", detail: "the next acquire writes the seal" };
      }
    } else if (st?.isFile()) {
      out.legacy = legacyInfo();
    }
    return out;
  }

  function liveArgv(p) {
    try {
      return readIdentity(o, p).argv ?? null;
    } catch {
      return null;
    }
  }

  function adoptLegacy({ expectDev, expectIno, expectSha, domainDeclaration = null, deadlineMs = o.deadlineMs } = {}) {
    const h = authorityOnly(deadlineMs);
    if (!h) throw new FencedLockError("ADOPT_BUSY", busyReason());
    let fd0 = null;
    try {
      const domain = currentDomain();
      if (domain.verdict !== "initial" && !domainDeclaration) {
        throw new FencedLockError(domain.verdict === "nested" ? "ADOPT_DOMAIN_NESTED" : "ADOPT_DOMAIN_UNKNOWN", `${domain.reason}; ${domain.scope}`, { domain });
      }
      const st = lstatOrNull(F);
      if (st === null) throw new FencedLockError("ADOPT_NOT_LEGACY", "nothing on the path");
      if (st.isDirectory()) throw new FencedLockError("ADOPT_NOT_LEGACY", "a fence is already there");
      if (!st.isFile()) throw new FencedLockError("ADOPT_NOT_LEGACY", `not a regular file (${kindOf(st)})`);
      fd0 = fs.openSync(F, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const fst = fs.fstatSync(fd0, { bigint: true });
      const content = readFd(fd0);
      const x = { dev: String(fst.dev), ino: String(fst.ino), sha256: sha256(content), nlink: Number(fst.nlink) };
      if (fileId(fst) !== fileId(st)) throw new FencedLockError("ADOPT_MISMATCH", "fd and path do not point to the same file");
      if (x.dev !== String(expectDev) || x.ino !== String(expectIno) || x.sha256 !== String(expectSha)) {
        throw new FencedLockError("ADOPT_MISMATCH", `expected ${expectDev}/${expectIno}/${expectSha}, found ${x.dev}/${x.ino}/${x.sha256}`, { found: x });
      }
      const text = content.toString("utf8").trim();
      if (text !== "") {
        const pid = Number.parseInt(text, 10);
        if (!Number.isInteger(pid) || String(pid) !== text) throw new FencedLockError("ADOPT_REFUSED", "content is not a pid");
        if (signalProbe(pid) !== "esrch") throw new FencedLockError("ADOPT_REFUSED", `pid ${pid} does not give ESRCH`);
      }
      const otherNames =
        x.nlink >= 2
          ? fs.readdirSync(dir).filter((name) => {
              if (!residueMatch(name)) return false;
              try {
                return fileId(fs.statSync(path.join(dir, name), { bigint: true })) === fileId(fst);
              } catch {
                return false;
              }
            })
          : [];
      const drain = drainCheck({ ...o, domain: () => domain });
      if (drain.result !== "drained") {
        throw new FencedLockError("ADOPT_NOT_DRAINED", `drain-check: ${drain.unprovenCount} unproven plugin process(es)`, { drain });
      }
      const now = lstatOrNull(F);
      if (!now || fileId(now) !== fileId(fst)) throw new FencedLockError("ADOPT_CHANGED", "state.lock changed after the check; nothing moved");
      const P = prepare();
      const Q = path.join(dir, `${base}.quarantine-${stamp()}-${hex(8)}`);
      const logPath = `${Q}.adopt.json`;
      const log = {
        state: "renaming",
        quarantine: Q,
        expected: { dev: String(expectDev), ino: String(expectIno), sha256: String(expectSha) },
        nlink: x.nlink,
        residues: otherNames,
        domain,
        declaration: domainDeclaration,
        drain: { result: drain.result, newCount: drain.newCount, unprovenCount: drain.unprovenCount, self: drain.self },
        at: nowIso()
      };
      writeAtomic(logPath, `${JSON.stringify(log, null, 2)}\n`);
      fs.renameSync(F, Q);
      let fence = "published";
      try {
        fs.renameSync(P, F);
      } catch (error) {
        fs.rmSync(P, { recursive: true, force: true });
        if (!RENAME_LOST_CODES.has(error.code)) throw error;
        fence = "lost";
      }
      let sealResult = null;
      if (fence === "published") {
        try {
          writeSealRecord({ declaration: domainDeclaration });
        } catch {
          // the next acquire writes the record
        }
      }
      const q = lstatOrNull(Q);
      const match = q !== null && fileId(q) === fileId(fst);
      let y = null;
      if (!match && q) {
        try {
          const fdQ = fs.openSync(Q, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          try {
            const qs = fs.fstatSync(fdQ, { bigint: true });
            y = { dev: String(qs.dev), ino: String(qs.ino), sha256: sha256(readFd(fdQ)) };
          } finally {
            fs.closeSync(fdQ);
          }
        } catch (error) {
          y = { error: error.code };
        }
      }
      const moved = { ...log, state: "moved", match, y, fence, movedAt: nowIso() };
      writeAtomic(logPath, `${JSON.stringify(moved, null, 2)}\n`);
      if (fence === "published") {
        const fst2 = lstatOrNull(F);
        if (fst2?.isDirectory()) {
          h.fence = fileId(fst2);
          sealResult = sealState();
        }
      }
      return { ok: match && fence === "published", log: moved, logPath, fence, match, seal: sealResult, code: fence === "lost" ? "ADOPT_FENCE_LOST_TO_LEGACY" : match ? null : "ADOPT_MOVED_OTHER_OBJECT" };
    } finally {
      if (fd0 !== null) fs.closeSync(fd0);
      unlock(h);
    }
  }

  function seal({ domainDeclaration = null, deadlineMs = o.deadlineMs } = {}) {
    const h = authorityOnly(deadlineMs);
    if (!h) return { result: "busy", reason: busyReason() };
    try {
      const st = lstatOrNull(F);
      if (!st?.isDirectory()) return { result: "no-fence", kind: kindOf(st) };
      h.fence = fileId(st);
      const r = readRecord();
      if (domainDeclaration) {
        if (r && sameProc(r)) {
          writeRecord({ ...r, declaration: domainDeclaration });
        } else {
          // A record from another procfs (or none): this operator step scans
          // here, under the declaration, which then also vouches for the
          // processes of the replaced record that this namespace cannot see.
          // The replaced record stays in the new one (replacedForeign).
          writeSealRecord({
            declaration: domainDeclaration,
            replaced: r ? { verdict: r.verdict, verdictReason: r.verdictReason, scanProc: r.scanProc ?? null, S0: r.S0, residues: r.residues } : null
          });
        }
      }
      const z = sealState();
      return z.sealed ? { result: "sealed", record: readRecord() } : { result: "waiting", reason: z.reason, record: readRecord() };
    } finally {
      unlock(h);
    }
  }

  function stopOld({ graceMs = 5_000, includeUnidentified = false, deadlineMs = o.deadlineMs } = {}) {
    const kill = o.kill ?? ((pid, sig) => process.kill(pid, sig));
    // 1. Targets under A, then release A: signals and the grace run outside A.
    let targets;
    {
      const h = authorityOnly(deadlineMs);
      if (!h) return { ok: false, result: "busy", reason: busyReason(), targets: [] };
      try {
        const st = lstatOrNull(F);
        if (!st?.isDirectory()) return { ok: false, result: "no-fence", targets: [] };
        let r = readRecord();
        if (!r) return { ok: false, result: "no-record", targets: [] };
        if (r.sealedAt) return { ok: true, result: "sealed", targets: [] };
        if (r.residues.length > 0) return { ok: false, result: "residue", reason: residueReason(r.residues), targets: [] };
        if (r.S0 === null) return { ok: false, result: "no-scan", targets: [] };
        // Linux: the pids in S0 come from a procfs, kill() uses the pids of the
        // caller's PID namespace. They are the same numbers only in the init
        // namespace with its full procfs (v2.11). There, a record scanned
        // elsewhere is scanned again first (residue check, then scan; the v2.7
        // rule of sealState), so its pids are this namespace's. macOS has no
        // PID namespaces.
        if (o.platform === "linux") {
          const here = currentDomain();
          if (here.verdict !== "initial") {
            return {
              ok: false,
              result: "domain",
              reason: `stop-old only signals from the init PID namespace with a full procfs (here: ${here.verdict}, ${here.reason}); run it in the init namespace (on the host), or seal with state-lock seal --declare-cross-namespace`,
              targets: []
            };
          }
          if (r.verdict !== "initial" || !sameProc(r)) {
            writeSealRecord();
            r = readRecord();
            if (!r) return { ok: false, result: "no-record", targets: [] };
            if (r.residues.length > 0) return { ok: false, result: "residue", reason: residueReason(r.residues), targets: [] };
            if (r.verdict !== "initial" || r.S0 === null) return { ok: false, result: "domain", reason: `the new scan gave domain ${r.verdict}`, targets: [] };
          }
        }
        targets = r.S0.filter((p) => stillWaitingOn(o, p));
      } finally {
        unlock(h);
      }
    }
    // 2. Signals, each right after a fresh identity read.
    const outcomes = targets.map((t) => stopOne(t));
    // 3. sealState under A on the record as it is now.
    const h = authorityOnly(deadlineMs);
    if (!h) return { ok: false, result: "busy-after", outcomes };
    try {
      const st = lstatOrNull(F);
      if (!st?.isDirectory()) return { ok: false, result: "no-fence-after", outcomes };
      h.fence = fileId(st);
      const z = sealState();
      const r = readRecord();
      const notTargeted = (r?.S0 ?? [])
        .filter((p) => !targets.some((t) => t.pid === p.pid && t.start === p.start) && stillWaitingOn(o, p))
        .map((p) => ({ pid: p.pid, start: p.start, script: p.script, outcome: "not-targeted" }));
      const gone = new Set(["terminated", "killed", "already-gone", "identity-changed", "now-proven"]);
      const allGone = outcomes.every((x) => gone.has(x.outcome)) && notTargeted.length === 0;
      return { ok: allGone && Boolean(z.sealed), result: z.sealed ? "sealed" : "waiting", reason: z.reason ?? null, outcomes: [...outcomes, ...notTargeted] };
    } finally {
      unlock(h);
    }

    function stopOne(t) {
      const who = { pid: t.pid, start: t.start, script: t.script, sub: t.sub, comm: t.comm };
      // No start time recorded: nothing ties the pid to the recorded process.
      if (t.start === null) return { ...who, outcome: "unidentified", detail: "no start time recorded: never signalled" };
      if (!t.script && !includeUnidentified) return { ...who, outcome: "unidentified" };
      // A plugin script in argv but no JS runtime (an editor or pager with the
      // script open): never signalled without the flag.
      if (t.script && t.comm && !JS_RUNTIME.test(t.comm) && !includeUnidentified) {
        return { ...who, outcome: "unidentified", detail: `comm ${t.comm} is not a JS runtime` };
      }
      const sent = [];
      const result = (outcome, detail) => ({ ...who, outcome, ...(detail ? { detail } : {}), signalsSent: [...sent] });
      const identity = () => {
        try {
          return identityNow(o, t);
        } catch {
          return { status: "unreadable" };
        }
      };
      const send = (sig) => {
        try {
          kill(t.pid, sig);
          sent.push(sig);
          return null;
        } catch (error) {
          if (error.code === "EPERM") return "eperm";
          if (error.code === "ESRCH") return "gone";
          throw error;
        }
      };
      // Poll the identity until the target is gone or changed, or the time is up.
      const waitGone = (ms) => {
        const end = performance.now() + ms;
        for (;;) {
          const now = identity();
          if (now.status === "gone" || now.status === "changed" || performance.now() >= end) return now.status;
          sleepSync(50);
        }
      };
      // Right before every signal: the identity (an exiting process with an
      // empty argv is settled first), then the marker (v2.11: a target that
      // holds it by now proves the new protocol and gets no further signal).
      // Returns null to go on, or the outcome.
      const before = (goneOutcome) => {
        let c = identity();
        if (c.status === "unverified") {
          const settled = waitGone(500);
          c = settled === "same" ? identity() : { status: settled };
        }
        if (c.status === "gone") return result(goneOutcome);
        if (c.status === "changed") return result("identity-changed");
        if (c.status !== "same") return result("still-alive", "identity cannot be confirmed");
        if (markerNow(o, t) === true) {
          return result("now-proven", sent.length === 0 ? "holds the protocol marker now: never signalled" : `holds the protocol marker now: no further signal after ${sent.join(", ")}`);
        }
        stopped = c.stopped;
        return null;
      };
      let stopped = false;
      let done = before("already-gone");
      if (done) return done;
      if (stopped) {
        const e = send("SIGCONT");
        if (e === "eperm") return result("eperm");
        if (e === "gone") return result("already-gone");
        done = before("already-gone");
        if (done) return done;
      }
      const term = send("SIGTERM");
      if (term === "eperm") return result("eperm");
      if (term === "gone") return result("already-gone");
      const afterTerm = waitGone(graceMs);
      if (afterTerm === "gone") return result("terminated");
      if (afterTerm === "changed") return result("identity-changed");
      done = before("terminated"); // the identity and the marker read again right before SIGKILL
      if (done) return done;
      const k = send("SIGKILL");
      if (k === "eperm") return result("eperm");
      if (k === "gone") return result("terminated");
      const afterKill = waitGone(2_000);
      if (afterKill === "gone") return result("killed");
      if (afterKill === "changed") return result("identity-changed");
      return result("still-alive");
    }
  }

  function unfence({ deadlineMs = o.deadlineMs } = {}) {
    const prepResidue = protocolInventory().counts.prep;
    let st;
    try {
      st = lstatOrNull(F);
    } catch {
      return { result: "unknown", prepResidue };
    }
    if (st === null) return { result: "none", prepResidue };
    if (st.isFile()) return { result: "legacy", prepResidue };
    if (!st.isDirectory()) return { result: "unknown", kind: kindOf(st), prepResidue };
    const h = authorityOnly(deadlineMs);
    if (!h) return { result: "busy", reason: busyReason(), prepResidue };
    try {
      const again = lstatOrNull(F);
      if (!again?.isDirectory()) return { result: again === null ? "none" : again.isFile() ? "legacy" : "unknown", prepResidue };
      const retired = path.join(dir, `${base}.retired-${stamp()}-${hex(8)}`);
      fs.renameSync(F, retired);
      return { result: "unfenced", retired, prepResidue };
    } finally {
      unlock(h);
    }
  }

  return {
    fencePath: F,
    authorityPath: A,
    acquire,
    tryAcquire,
    release,
    assertOwned,
    status,
    adoptLegacy,
    seal,
    stopOld,
    unfence,
    drainCheck: () => drainCheck(o),
    residues
  };
}

let facts = null;
function processFacts() {
  facts ??= { pid: process.pid, host: os.hostname(), pidNs: pidNamespace(), bootId: bootId() };
  return facts;
}

function pidNamespace() {
  try {
    return fs.readlinkSync("/proc/self/ns/pid");
  } catch {
    return null;
  }
}

function bootId() {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}
