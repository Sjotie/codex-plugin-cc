// Unit and small-process tests of the fenced lock (#1916, design §11: U1–U3,
// U6, U7, N30b–d5, N31d/g, N32d–l). Pure functions get table tests; the scan
// runs against real child processes, made visible through a scan scope that
// only this test process applies (tests/fenced-lock/scan-scope.mjs).
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  PROTOCOL_MARKER,
  StateLockTimeout,
  domainVerdict,
  drainCheck,
  fsVerdict,
  linuxProcReader,
  openFencedLock,
  parseProcStat,
  procMountOptions
} from "../plugins/codex/scripts/lib/fenced-lock.mjs";
import { matchPluginArgv } from "../plugins/codex/scripts/lib/state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, "..", "plugins", "codex", "scripts", "lib");
const DRIVER = path.join(HERE, "fenced-lock", "drain-driver.mjs");
const BUSY_PROBE = path.join(HERE, "fenced-lock", "busy-probe.mjs");
const SCAN_SCOPE = path.join(HERE, "fenced-lock", "scan-scope.mjs");
const LINUX = process.platform === "linux";

// One scan scope for this process: each test writes the pids it exposes.
const scopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fenced-lock-unit-"));
const scopeFile = path.join(scopeRoot, "scan-scope");
fs.writeFileSync(scopeFile, "");
process.env.FENCED_LOCK_SCAN_SCOPE = scopeFile;
await import("./fenced-lock/scan-scope.mjs");
test.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }));

const PLUGIN_OPTS = { argvMatch: matchPluginArgv, noLockPathScripts: new Set(["app-server-broker.mjs"]) };
const INITIAL = () => ({ verdict: "initial", reason: "test", scope: "test" });

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fenced-lock-u-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function expose(...pids) {
  fs.writeFileSync(scopeFile, pids.map((p) => `${p}\n`).join(""));
}

function track(t, child) {
  const exit = new Promise((r) => child.once("exit", (code, sig) => r({ code, signal: sig })));
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await exit;
  });
  return { child, pid: child.pid, exit };
}

async function waitFile(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return fs.readFileSync(file, "utf8");
}

// An idle process with plugin argv that never loads the module (an old worker).
function oldProcess(t, argv0 = "/plugin/scripts/codex-companion.mjs", sub = "task-worker") {
  return track(t, spawn("sh", ["-c", "sleep 60; :", argv0, sub], { stdio: "ignore" }));
}

// A drain driver: a new-code process with plugin argv.
function driver(t, barriers, role, env = {}, argv = ["/plugin/scripts/codex-companion.mjs", "state-lock", "drain-check"]) {
  const child = spawn(process.execPath, [DRIVER, ...argv], {
    env: { ...process.env, FENCED_LOCK_SCAN_SCOPE: scopeFile, DRIVER_BARRIERS: barriers, DRIVER_ROLE: role, ...env },
    stdio: ["ignore", "ignore", "pipe"]
  });
  return track(t, child);
}

const result = (barriers, role) => JSON.parse(fs.readFileSync(path.join(barriers, `${role}.done`), "utf8"));

// ---------------------------------------------------------------------------
// The module is a byte-equal copy of factory-core shared/fenced-lock
// ---------------------------------------------------------------------------

test("fenced-lock.mjs and the marker match the hashes of their source (fenced-lock.source.json)", async () => {
  const { createHash } = await import("node:crypto");
  const source = JSON.parse(fs.readFileSync(path.join(LIB, "fenced-lock.source.json"), "utf8"));
  assert.match(source.sourceCommit, /^[0-9a-f]{40}$/);
  for (const [name, sum] of Object.entries(source.sha256)) {
    const actual = createHash("sha256").update(fs.readFileSync(path.join(LIB, name))).digest("hex");
    assert.equal(actual, sum, `${name} differs from ${source.sourceRepo}@${source.sourceCommit.slice(0, 9)}: change the source first`);
  }
  assert.deepEqual(Object.keys(source.sha256).sort(), ["fenced-lock.mjs", PROTOCOL_MARKER].sort());
});

// ---------------------------------------------------------------------------
// U1: isBusy per runtime, with a real BUSY from a second process
// ---------------------------------------------------------------------------

const RUNTIMES = [
  ["node 22", path.join(os.homedir(), ".local/share/mise/installs/node/22.23.3/bin/node")],
  ["node 26", process.execPath],
  ["bun", spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim()]
];

for (const [name, bin] of RUNTIMES) {
  test(`U1 (${name}): isBusy is true for a real BUSY from another process, false for NOTADB and LOCKED`, async (t) => {
    if (!bin || !fs.existsSync(bin)) {
      t.skip(`${name} not installed here`);
      return;
    }
    const dir = tmpdir(t);
    const db = path.join(dir, "held.db");
    const notADb = path.join(dir, "not-a-db");
    fs.writeFileSync(notADb, "this is not a database ".repeat(200));
    const holder = track(
      t,
      spawn(process.execPath, [
        "--input-type=module",
        "-e",
        `const { DatabaseSync } = await import("node:sqlite");
         const db = new DatabaseSync(process.argv[1]); db.exec("BEGIN EXCLUSIVE");
         process.stdout.write("held\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
        db
      ], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, NODE_NO_WARNINGS: "1" } })
    );
    await new Promise((r) => holder.child.stdout.once("data", r));
    const run = spawnSync(bin, [BUSY_PROBE, db, notADb], { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    holder.child.stdin.end();
    assert.equal(run.status, 0, run.stderr);
    const r = JSON.parse(run.stdout);
    assert.equal(r.runtime.available, true, JSON.stringify(r));
    assert.ok(r.held.error, `a second process got in: ${JSON.stringify(r)}`);
    assert.equal(r.held.busy, true, `BUSY not recognized: ${JSON.stringify(r.held)}`);
    assert.ok(r.notADb.error, "a non-database opened cleanly");
    assert.equal(r.notADb.busy, false, `NOTADB read as BUSY: ${JSON.stringify(r.notADb)}`);
    assert.equal(r.locked, false, "LOCKED read as BUSY");
    assert.equal(r.busyTimeout, true, "extended BUSY code not recognized");
    assert.equal(r.nullError, false);
    assert.equal(r.fsError, false);
  });
}

// ---------------------------------------------------------------------------
// U2: fsVerdict
// ---------------------------------------------------------------------------

test("U2: fsVerdict refuses network and FUSE filesystems on Linux, also from a negative int32", () => {
  const table = [
    [0x6969, "NFS"],
    [0x517b, "SMB"],
    [0xff534d42, "CIFS"],
    [0xfe534d42, "SMB2"],
    [0x65735546, "FUSE"],
    [0x00c36400, "CEPH"],
    [0x01021997, "9P"]
  ];
  for (const [type, name] of table) {
    assert.deepEqual(fsVerdict("linux", type), { verdict: "refuse", name });
    assert.deepEqual(fsVerdict("linux", type | 0), { verdict: "refuse", name }, `${name} as int32 ${type | 0}`);
  }
  for (const ok of [0xef53, 0x9123683e, 0x58465342, 0x01021994, 0x2fc12fc1]) {
    assert.deepEqual(fsVerdict("linux", ok), { verdict: "ok" });
  }
  assert.deepEqual(fsVerdict("darwin", 0x6969), { verdict: "ok" });
});

// ---------------------------------------------------------------------------
// U3: drain-check
// ---------------------------------------------------------------------------

test("U3: matchPluginArgv recognizes both install prefixes and Windows paths, not grep or a lookalike", () => {
  const home = os.homedir();
  for (const argv of [
    ["node", `${home}/.claude/plugins/cache/openai-codex/codex/1.0.7-sjotie.22/scripts/codex-companion.mjs`, "task-worker"],
    ["node", `${home}/.homebase/factory-acp/accounts/claude/stiemensma/plugins/cache/openai-codex/codex/1.0.7-sjotie.22/scripts/codex-companion.mjs`, "task-worker"],
    ["node.exe", "C:\\Users\\x\\.claude\\plugins\\cache\\openai-codex\\codex\\1.0.7\\scripts\\codex-companion.mjs", "task-worker"]
  ]) {
    assert.deepEqual(matchPluginArgv(argv), { script: "codex-companion.mjs", sub: "task-worker" }, argv[1]);
  }
  assert.equal(matchPluginArgv(["node", "/x/scripts/app-server-broker.mjs", "serve"]).script, "app-server-broker.mjs");
  assert.equal(matchPluginArgv(["grep", "codex-companion"]), null);
  assert.equal(matchPluginArgv(["grep", "scripts/codex-companion.mjs"]), null, "no leading separator: not a script path");
  assert.equal(matchPluginArgv(["node", "/x/scripts/codex-companion.mjs.bak"]), null);
  assert.equal(matchPluginArgv(["node", "/x/scripts/codex-companion.mjs", "task", "--json", "x".repeat(500)]).sub, "task");
  assert.equal(matchPluginArgv(["node", "/x/scripts/codex-companion.mjs", "y".repeat(500)]).sub.length, 64);
});

test("U3: grep codex-companion is not counted; an old worker stays unproven when its root switches to the new version", { skip: !LINUX && "Linux /proc" }, async (t) => {
  const root = tmpdir(t);
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(path.join(scripts, "lib"), { recursive: true });
  fs.writeFileSync(path.join(scripts, "codex-companion.mjs"), "setTimeout(() => {}, 60_000);\n");
  const worker = track(t, spawn(process.execPath, [path.join(scripts, "codex-companion.mjs"), "task-worker"], { stdio: "ignore" }));
  const grep = track(t, spawn("grep", ["codex-companion"], { stdio: ["pipe", "ignore", "ignore"] }));
  expose(worker.pid, grep.pid);
  await new Promise((r) => setTimeout(r, 100));
  // The plugin root now holds the new version (marker file and module).
  fs.copyFileSync(path.join(LIB, PROTOCOL_MARKER), path.join(scripts, "lib", PROTOCOL_MARKER));
  fs.copyFileSync(path.join(LIB, "fenced-lock.mjs"), path.join(scripts, "lib", "fenced-lock.mjs"));
  const r = drainCheck({ ...PLUGIN_OPTS, domain: INITIAL });
  assert.equal(r.processes.some((p) => p.pid === grep.pid), false, "grep was counted");
  const w = r.processes.find((p) => p.pid === worker.pid);
  assert.equal(w?.verdict, "unproven", JSON.stringify(r.processes));
  assert.equal(r.result, "not-drained");
});

test("U3: a new process stays new after its root is replaced by an old checkout (marker link reads (deleted))", { skip: !LINUX && "Linux /proc" }, async (t) => {
  const root = tmpdir(t);
  const lib = path.join(root, "scripts", "lib");
  fs.mkdirSync(lib, { recursive: true });
  for (const name of ["fenced-lock.mjs", PROTOCOL_MARKER]) fs.copyFileSync(path.join(LIB, name), path.join(lib, name));
  const barriers = tmpdir(t);
  const d = driver(t, barriers, "new", { DRIVER_OP: "idle", DRIVER_FENCED_LOCK: path.join(lib, "fenced-lock.mjs") }, [path.join(root, "scripts", "codex-companion.mjs"), "task-worker"]);
  await waitFile(path.join(barriers, "new.ready"));
  // Replace the root by an old checkout: no marker, the old file is deleted.
  fs.rmSync(lib, { recursive: true });
  fs.mkdirSync(lib);
  fs.writeFileSync(path.join(lib, "state.mjs"), "// old\n");
  const links = fs.readdirSync(`/proc/${d.pid}/fd`).map((fd) => {
    try {
      return fs.readlinkSync(`/proc/${d.pid}/fd/${fd}`);
    } catch {
      return "";
    }
  });
  assert.ok(links.some((l) => l.endsWith(`${PROTOCOL_MARKER} (deleted)`)), `no deleted marker link: ${links.join(", ")}`);
  expose(d.pid);
  const r = drainCheck({ ...PLUGIN_OPTS, domain: INITIAL });
  assert.equal(r.processes.find((p) => p.pid === d.pid)?.verdict, "new", JSON.stringify(r.processes));
  assert.equal(r.result, "drained");
  fs.writeFileSync(path.join(barriers, "new.release"), "");
  await d.exit;
});

test("U3: an unreadable /proc/<pid>/fd makes a matching process unproven", { skip: !LINUX && "Linux /proc" }, async (t) => {
  const barriers = tmpdir(t);
  const d = driver(t, barriers, "new", { DRIVER_OP: "idle" });
  await waitFile(path.join(barriers, "new.ready"));
  expose(d.pid);
  const real = linuxProcReader();
  const reader = {
    ...real,
    fds: () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
  };
  const r = drainCheck({ ...PLUGIN_OPTS, domain: INITIAL, linuxReader: reader });
  const entry = r.processes.find((p) => p.pid === d.pid);
  assert.equal(entry?.verdict, "unproven", JSON.stringify(r.processes));
  assert.match(entry.reason, /fds unreadable/);
  // The same process with readable fds is new.
  assert.equal(drainCheck({ ...PLUGIN_OPTS, domain: INITIAL }).processes.find((p) => p.pid === d.pid)?.verdict, "new");
  fs.writeFileSync(path.join(barriers, "new.release"), "");
  await d.exit;
});

// ---------------------------------------------------------------------------
// U6: domainVerdict
// ---------------------------------------------------------------------------

const PROC_SUPER_MAGIC = 0x9fa0;

// A fake procRoot: ns link, mountinfo with the given options, statfs stub.
function fakeProc(t, { ns = "pid:[4026531836]", mountOptions = "rw,nosuid,nodev,noexec,relatime", superOptions = "rw", fstype = "proc" } = {}) {
  const root = tmpdir(t);
  fs.mkdirSync(path.join(root, "self", "ns"), { recursive: true });
  fs.symlinkSync(ns, path.join(root, "self", "ns", "pid"));
  fs.writeFileSync(
    path.join(root, "self", "mountinfo"),
    `22 1 0:21 / /sys rw,nosuid - sysfs sysfs rw\n23 1 0:22 / ${root} ${mountOptions} shared:12 - ${fstype} proc ${superOptions}\n`
  );
  return root;
}

test("U6: domainVerdict on this machine (init PID namespace, full procfs) is initial", { skip: !LINUX && "Linux" }, (t) => {
  if (fs.readlinkSync("/proc/self/ns/pid") !== "pid:[4026531836]") {
    t.skip("this test process does not run in the init PID namespace");
    return;
  }
  assert.equal(domainVerdict().verdict, "initial");
});

test("U6: domainVerdict from fixtures: hidepid, subset=pid, no procfs, unreadable ns, darwin", (t) => {
  const statfs = (type) => () => ({ type });
  assert.equal(domainVerdict({ platform: "linux", procRoot: fakeProc(t), statfs: statfs(PROC_SUPER_MAGIC) }).verdict, "initial");
  for (const [opts, verdict] of [
    [{ superOptions: "rw,hidepid=2" }, "unknown"],
    [{ superOptions: "rw,hidepid=invisible" }, "unknown"],
    [{ superOptions: "rw,hidepid=0" }, "initial"],
    [{ superOptions: "rw,subset=pid" }, "unknown"],
    [{ ns: "pid:[4026532100]" }, "nested"],
    [{ ns: "mnt:[1]" }, "unknown"],
    [{ fstype: "tmpfs" }, "unknown"]
  ]) {
    assert.equal(domainVerdict({ platform: "linux", procRoot: fakeProc(t, opts), statfs: statfs(PROC_SUPER_MAGIC) }).verdict, verdict, JSON.stringify(opts));
  }
  // /proc replaced by a tmpfs: statfs says so.
  const tmpfs = domainVerdict({ platform: "linux", procRoot: fakeProc(t), statfs: statfs(0x01021994) });
  assert.equal(tmpfs.verdict, "unknown");
  assert.match(tmpfs.reason, /not procfs/);
  assert.equal(domainVerdict({ platform: "linux", procRoot: tmpdir(t) }).verdict, "unknown", "no ns link");
  // darwin: only with the M2 flag of the build and a canary that sees pid 1 and the parent.
  assert.equal(domainVerdict({ platform: "darwin" }).verdict, "unknown", "the build flag is off");
  assert.equal(domainVerdict({ platform: "darwin", macosScanProven: true, canary: { ok: true } }).verdict, "initial");
  assert.equal(domainVerdict({ platform: "darwin", macosScanProven: true, canary: { ok: false, reason: "pid 1 niet zichtbaar" } }).verdict, "unknown");
  assert.equal(domainVerdict({ platform: "darwin", macosScanProven: true, canary: { ok: false, reason: "eigen ouderproces niet zichtbaar" } }).verdict, "unknown");
  assert.equal(domainVerdict({ platform: "freebsd" }).verdict, "unknown");
  assert.deepEqual(procMountOptions("23 1 0:22 / /proc rw,relatime - proc proc rw,hidepid=2\n"), ["rw", "relatime", "rw", "hidepid=2"]);
  assert.equal(procMountOptions("23 1 0:22 / /proc rw - tmpfs none rw\n"), null);
});

function unshareWorks(flags) {
  return LINUX && spawnSync("unshare", [...flags, "true"]).status === 0;
}

const VERDICT_SCRIPT = `
  const { domainVerdict } = await import(process.argv[1]);
  process.stdout.write(JSON.stringify(domainVerdict()));
`;

for (const [label, flags] of [
  ["inherited procfs", ["-r", "-p", "-f"]],
  ["own procfs", ["-r", "-p", "-f", "--mount-proc"]]
]) {
  test(`U6: domainVerdict in a nested PID namespace with ${label} is nested`, (t) => {
    if (!unshareWorks(flags)) {
      t.skip(`unshare ${flags.join(" ")} not available`);
      return;
    }
    const run = spawnSync("unshare", [...flags, process.execPath, "--input-type=module", "-e", VERDICT_SCRIPT, path.join(LIB, "fenced-lock.mjs")], {
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" }
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).verdict, "nested", run.stdout);
  });
}

test("U6: domainVerdict with /proc replaced by a tmpfs in its own mount namespace is unknown", (t) => {
  const flags = ["-r", "-m"];
  if (!unshareWorks(flags)) {
    t.skip("unshare -r -m not available");
    return;
  }
  const run = spawnSync(
    "unshare",
    [...flags, "sh", "-c", 'mount -t tmpfs none /proc && exec "$0" --input-type=module -e "$1" "$2"', process.execPath, VERDICT_SCRIPT, path.join(LIB, "fenced-lock.mjs")],
    { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).verdict, "unknown", run.stdout);
});

// ---------------------------------------------------------------------------
// U7: the drain does not count the scanner
// ---------------------------------------------------------------------------

test("U7a–c: the scanner never counts itself; another new process counts until it stops", { skip: !LINUX && "Linux /proc" }, async (t) => {
  const barriers = tmpdir(t);
  expose();
  const a = driver(t, barriers, "a");
  await a.exit;
  const ra = result(barriers, "a");
  assert.equal(ra.newCount, 0, JSON.stringify(ra));
  assert.equal(ra.self.matched, true);
  assert.equal(ra.processes.some((p) => p.pid === a.pid), false, "the scanner is listed");

  const other = driver(t, barriers, "other", { DRIVER_OP: "idle" });
  await waitFile(path.join(barriers, "other.ready"));
  expose(other.pid);
  const b = driver(t, barriers, "b");
  await b.exit;
  assert.equal(result(barriers, "b").newCount, 1, JSON.stringify(result(barriers, "b")));

  fs.writeFileSync(path.join(barriers, "other.release"), "");
  await other.exit;
  const c = driver(t, barriers, "c");
  await c.exit;
  assert.equal(result(barriers, "c").newCount, 0);
});

test("U7d: two drain-checks at the same time each count the other", { skip: !LINUX && "Linux /proc" }, async (t) => {
  const barriers = tmpdir(t);
  const first = driver(t, barriers, "first", { DRIVER_PAUSE: "1" });
  await waitFile(path.join(barriers, "first.paused"));
  const second = driver(t, barriers, "second", { DRIVER_PAUSE: "1", DRIVER_HOLD: "1" });
  await waitFile(path.join(barriers, "second.paused"));
  expose(first.pid, second.pid);
  fs.writeFileSync(path.join(barriers, "second.resume"), "");
  await waitFile(path.join(barriers, "second.done"));
  fs.writeFileSync(path.join(barriers, "first.resume"), "");
  await first.exit;
  fs.writeFileSync(path.join(barriers, "second.release"), "");
  await second.exit;
  const r1 = result(barriers, "first");
  const r2 = result(barriers, "second");
  assert.equal(r1.newCount, 1, JSON.stringify(r1));
  assert.equal(r2.newCount, 1, JSON.stringify(r2));
  assert.equal(r1.processes[0].pid, second.pid);
  assert.equal(r2.processes[0].pid, first.pid);
});

test("U7e: in a nested PID namespace with inherited procfs, self is found under the procfs pid, not process.pid", (t) => {
  const flags = ["-r", "-p", "-f"];
  if (!unshareWorks(flags)) {
    t.skip("unshare -r -p -f not available");
    return;
  }
  // No scan scope here: the nested process sees this machine's processes.
  const script = `
    const { drainCheck } = await import(process.argv[1]);
    const { matchPluginArgv } = await import(process.argv[2]);
    const r = drainCheck({ argvMatch: matchPluginArgv });
    process.stdout.write(JSON.stringify({ pid: process.pid, self: r.self, listed: r.processes.some((p) => p.pid === r.self.pid) }));
  `;
  const env = { ...process.env, NODE_NO_WARNINGS: "1" };
  delete env.FENCED_LOCK_SCAN_SCOPE;
  const run = spawnSync(
    "unshare",
    [...flags, process.execPath, "--input-type=module", "-e", script, path.join(LIB, "fenced-lock.mjs"), path.join(LIB, "state.mjs"), "/plugin/scripts/codex-companion.mjs", "state-lock", "drain-check"],
    { encoding: "utf8", env }
  );
  assert.equal(run.status, 0, run.stderr);
  const r = JSON.parse(run.stdout);
  assert.equal(r.pid, 1, "process.pid inside the namespace");
  assert.notEqual(r.self.pid, 1, "self must be the pid of the inherited procfs");
  assert.equal(r.self.matched, true, JSON.stringify(r));
  assert.equal(r.listed, false, "the scanner is listed");
});

// ---------------------------------------------------------------------------
// N30b–d5: completeness of the scan
// ---------------------------------------------------------------------------

test("N30b/c: a process started during the scan is not in it; one that stops during the scan is not either", { skip: !LINUX && "Linux /proc" }, async (t) => {
  const stays = oldProcess(t);
  const stops = oldProcess(t);
  let late = null;
  expose(stays.pid, stops.pid);
  const real = linuxProcReader();
  const reader = {
    ...real,
    pids: () => {
      const list = real.pids();
      // Between the enumeration and the per-pid check: one starts, one stops.
      late = spawn("sh", ["-c", "sleep 60; :", "/plugin/scripts/codex-companion.mjs", "task-worker"], { stdio: "ignore" });
      fs.appendFileSync(scopeFile, `${late.pid}\n`);
      process.kill(stops.pid, "SIGKILL");
      const deadline = Date.now() + 5_000;
      for (;;) {
        let state = "gone";
        try {
          state = parseProcStat(fs.readFileSync(`/proc/${stops.pid}/stat`, "utf8")).state;
        } catch {}
        if (state === "Z" || state === "gone" || Date.now() > deadline) break;
      }
      return list;
    }
  };
  const r = drainCheck({ ...PLUGIN_OPTS, domain: INITIAL, linuxReader: reader });
  track(t, late);
  const pids = r.processes.map((p) => p.pid);
  assert.ok(pids.includes(stays.pid), "the process alive across the scan is missing");
  assert.equal(pids.includes(stops.pid), false, "the stopped process is in the scan");
  assert.equal(pids.includes(late.pid), false, "the late process is in the scan");
});

// A fake /proc reader: one entry per pid.
function fakeReader(entries, self = { pid: 1, start: "1" }) {
  const get = (pid) => entries.find((e) => e.pid === pid);
  const fail = (what) => {
    throw Object.assign(new Error(what), { code: what });
  };
  return {
    pids: () => entries.map((e) => e.pid),
    self: () => self,
    stat: (pid) => {
      const e = get(pid);
      if (e.stat === "EACCES") fail("EACCES");
      return { comm: e.comm ?? null, state: e.state ?? "S", ppid: 1, flags: e.flags ?? 0, start: e.start ?? "100" };
    },
    cmdline: (pid) => {
      const e = get(pid);
      if (e.argv === "EACCES") fail("EACCES");
      return e.argv;
    },
    uid: () => 1000,
    fds: (pid) => {
      const e = get(pid);
      if (e.fds === "EACCES") fail("EACCES");
      return e.fds ?? [];
    }
  };
}

test("N30d1–d5: unreadable fds, unreadable or empty argv, comm and kernel threads", () => {
  const plugin = ["node", "/p/scripts/codex-companion.mjs", "task-worker"];
  const entries = [
    { pid: 11, argv: plugin, fds: "EACCES", comm: "node" }, // d1
    { pid: 12, argv: "EACCES", comm: "node" }, // d2
    { pid: 13, argv: "EACCES", comm: "sshd" }, // d3
    { pid: 14, stat: "EACCES" }, // d4: argv and comm unreadable
    { pid: 15, argv: [], comm: "node" }, // d5
    { pid: 16, argv: [], comm: "kworker/0:1", flags: 0x00200000 }, // d5: kernel thread
    { pid: 20, argv: [], comm: "node", flags: 0x00200000 }, // d5: a kernel thread is skipped on its flag alone
    { pid: 17, argv: "EACCES", comm: "bun" },
    { pid: 18, argv: plugin, fds: ["/x/lib/fenced-lock.protocol-1"], comm: "node" },
    { pid: 19, argv: ["node", "/srv/app.js"], comm: "node" }
  ];
  const r = drainCheck({ ...PLUGIN_OPTS, domain: INITIAL, platform: "linux", linuxReader: fakeReader(entries) });
  const by = Object.fromEntries(r.processes.map((p) => [p.pid, p]));
  assert.equal(by[11]?.verdict, "unproven", "d1");
  assert.equal(by[12]?.verdict, "unproven", "d2");
  assert.equal(by[12].script, null);
  assert.equal(by[13], undefined, "d3: sshd is no candidate");
  assert.equal(by[14]?.verdict, "unproven", "d4");
  assert.equal(by[15]?.verdict, "unproven", "d5");
  assert.equal(by[16], undefined, "d5: kernel thread");
  assert.equal(by[20], undefined, "d5: kernel thread with a runtime-like comm");
  assert.equal(by[17]?.verdict, "unproven", "bun with unreadable argv");
  assert.equal(by[18]?.verdict, "new");
  assert.equal(by[19], undefined, "a node process of another program");
  assert.equal(r.result, "not-drained");
});

// ---------------------------------------------------------------------------
// N31d/g: residue kinds
// ---------------------------------------------------------------------------

async function residueDir(t) {
  const dir = tmpdir(t);
  const lock = openFencedLock(path.join(dir, "state.lock"), {
    residueMatch: (name) => /^state\.lock\.[0-9]+$/.test(name),
    domain: INITIAL,
    scanner: () => ({ self: { pid: process.pid, start: null, matched: true }, processes: [] }),
    deadlineMs: 300
  });
  return { dir, lock };
}

test("N31d: a symlink state.lock.<pid> to a file with two names counts as a residue (stat, not lstat)", async (t) => {
  const { dir, lock } = await residueDir(t);
  const target = path.join(dir, "elsewhere");
  fs.writeFileSync(target, "123");
  fs.linkSync(target, path.join(dir, "second-name"));
  fs.symlinkSync(target, path.join(dir, "state.lock.4242"));
  const found = lock.residues();
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].name, "state.lock.4242");
  assert.equal(found[0].nlink, 2);
  assert.throws(() => lock.acquire({ deadlineMs: 300 }), (e) => e instanceof StateLockTimeout && /O2 residue/.test(e.message));
  // One name only: no residue, the seal comes.
  fs.rmSync(path.join(dir, "second-name"));
  assert.equal(lock.residues().length, 0);
  lock.release(lock.acquire({ deadlineMs: 300 }));
});

test("N31g: a fifo and a socket named state.lock.<pid> count as residues", async (t) => {
  const { dir, lock } = await residueDir(t);
  const mk = spawnSync("mkfifo", [path.join(dir, "state.lock.11")]);
  assert.equal(mk.status, 0);
  const server = net.createServer();
  await new Promise((r) => server.listen(path.join(dir, "state.lock.12"), r));
  t.after(() => server.close());
  const found = lock.residues();
  assert.deepEqual(found.map((r) => [r.name, r.kind]).sort(), [
    ["state.lock.11", "fifo"],
    ["state.lock.12", "socket"]
  ]);
  assert.throws(() => lock.acquire({ deadlineMs: 300 }), (e) => e instanceof StateLockTimeout);
  // A directory or a single-name file under the pattern is not a residue.
  fs.rmSync(path.join(dir, "state.lock.11"));
  await new Promise((r) => server.close(r));
  fs.rmSync(path.join(dir, "state.lock.12"), { force: true });
  fs.mkdirSync(path.join(dir, "state.lock.13"));
  fs.writeFileSync(path.join(dir, "state.lock.14"), "1");
  assert.equal(lock.residues().length, 0);
});

// ---------------------------------------------------------------------------
// N32d–l: stop-old with a swappable identity reading and a signal spy
// ---------------------------------------------------------------------------

const TARGET = { pid: 4242, start: "100", script: "codex-companion.mjs", sub: "task-worker", comm: "node", uid: 1000, reason: "geen marker-fd" };
const PLUGIN_ARGV = ["node", "/p/scripts/codex-companion.mjs", "task-worker"];

function fencedDir(t, S0) {
  const dir = tmpdir(t);
  const F = path.join(dir, "state.lock");
  fs.mkdirSync(F);
  const record = {
    version: 1,
    publishedAt: new Date().toISOString(),
    verdict: "initial",
    verdictReason: "test",
    scope: "test",
    declaration: null,
    residues: [],
    S0,
    scannedAt: new Date().toISOString(),
    sealedAt: null
  };
  fs.writeFileSync(path.join(F, "fence.json"), JSON.stringify(record));
  return { F, recordPath: path.join(F, "fence.json") };
}

// identity: (pid, phase) -> reading; phase counts the signals sent so far.
function stopOldWith(t, S0, identity, { onKill = () => {}, killError = null, ...options } = {}) {
  const { F, recordPath } = fencedDir(t, S0);
  const signals = [];
  const lock = openFencedLock(F, {
    ...PLUGIN_OPTS,
    domain: INITIAL,
    scanner: () => ({ self: { pid: process.pid, start: null, matched: true }, processes: [] }),
    identityReader: (p) => identity(p, signals),
    markerReader: options.markerReader ?? (() => false),
    kill: (pid, sig) => {
      if (killError) throw Object.assign(new Error(killError), { code: killError });
      signals.push([pid, sig]);
      onKill(pid, sig, recordPath);
    },
    platform: "linux"
  });
  return { lock, signals, recordPath, sealed: () => Boolean(JSON.parse(fs.readFileSync(recordPath, "utf8")).sealedAt) };
}

const alive = (extra = {}) => ({ start: "100", state: "S", argv: PLUGIN_ARGV, comm: "node", ...extra });

test("N32d: a reused pid with another start time gets no signal", (t) => {
  const s = stopOldWith(t, [TARGET], () => alive({ start: "999" }));
  const r = s.lock.stopOld({ graceMs: 100 });
  assert.deepEqual(s.signals, []);
  assert.equal(r.result, "sealed", JSON.stringify(r));
  assert.equal(r.ok, true);
});

test("N32f: the target dies after SIGTERM and its pid is reused before SIGKILL: no SIGKILL, identity-changed, sealed", (t) => {
  const s = stopOldWith(t, [TARGET], (p, signals) => (signals.length === 0 ? alive() : alive({ start: "555" })));
  const r = s.lock.stopOld({ graceMs: 150 });
  assert.deepEqual(s.signals.map(([, sig]) => sig), ["SIGTERM"]);
  assert.equal(r.outcomes[0].outcome, "identity-changed", JSON.stringify(r));
  assert.equal(r.result, "sealed");
  assert.equal(s.sealed(), true);
});

test("N32f (no grace): the identity is read again right before SIGKILL, not taken from before SIGTERM", (t) => {
  // graceMs 0: one poll after SIGTERM still sees the target, the read right
  // before SIGKILL sees a reused pid. Only that last read can stop the SIGKILL.
  let afterTerm = 0;
  const s = stopOldWith(t, [TARGET], (p, signals) => {
    if (signals.length === 0) return alive();
    afterTerm += 1;
    return afterTerm === 1 ? alive() : alive({ start: "555" });
  });
  const r = s.lock.stopOld({ graceMs: 0 });
  assert.deepEqual(s.signals.map(([, sig]) => sig), ["SIGTERM"], "SIGKILL went to the process that reused the pid");
  assert.equal(r.outcomes[0].outcome, "identity-changed");
});

test("N32g: EPERM is not gone: outcome eperm, not ok, no seal", (t) => {
  const s = stopOldWith(t, [TARGET], () => alive(), { killError: "EPERM" });
  const r = s.lock.stopOld({ graceMs: 100 });
  assert.equal(r.outcomes[0].outcome, "eperm");
  assert.equal(r.ok, false);
  assert.equal(r.result, "waiting");
  assert.equal(s.sealed(), false);
});

test("N32g (real): kill of a process of another uid gives eperm", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("running as root: EPERM cannot occur");
    return;
  }
  // pid 1 belongs to root; its identity is faked as a plugin target.
  const one = { ...TARGET, pid: 1 };
  const { F } = fencedDir(t, [one]);
  const lock = openFencedLock(F, {
    ...PLUGIN_OPTS,
    domain: INITIAL,
    scanner: () => ({ self: { pid: process.pid, start: null, matched: true }, processes: [] }),
    identityReader: () => alive(),
    platform: "linux"
  });
  const r = lock.stopOld({ graceMs: 100 });
  assert.equal(r.outcomes[0].outcome, "eperm", JSON.stringify(r));
  assert.equal(r.ok, false);
});

test("N32h: an unidentified candidate gets no signal without the flag; with it, identity is pid, start time and comm", (t) => {
  const unidentified = { pid: 4343, start: "200", script: null, sub: null, comm: "node", uid: 1000, reason: "argv unreadable" };
  const read = (p, signals) => (signals.length === 0 ? { start: "200", state: "S", argv: null, comm: "node" } : { gone: true });
  const a = stopOldWith(t, [unidentified], read);
  const ra = a.lock.stopOld({ graceMs: 100 });
  assert.deepEqual(a.signals, []);
  assert.equal(ra.outcomes[0].outcome, "unidentified");
  assert.equal(ra.ok, false);
  const b = stopOldWith(t, [unidentified], read);
  const rb = b.lock.stopOld({ graceMs: 100, includeUnidentified: true });
  assert.deepEqual(b.signals, [[4343, "SIGTERM"]]);
  assert.equal(rb.outcomes[0].outcome, "terminated");
  assert.equal(rb.ok, true);
  // Another comm under the same pid and start: no signal.
  const c = stopOldWith(t, [unidentified], () => ({ start: "200", state: "S", argv: null, comm: "python3" }));
  const rc = c.lock.stopOld({ graceMs: 100, includeUnidentified: true });
  assert.deepEqual(c.signals, []);
  assert.equal(rc.outcomes[0].outcome, "identity-changed");
});

test("N32i: the record rewritten during the grace decides; a new member is not-targeted", (t) => {
  const member = { ...TARGET, pid: 5151, start: "300" };
  const s = stopOldWith(
    t,
    [TARGET],
    (p, signals) => (p.pid === TARGET.pid ? (signals.length === 0 ? alive() : { gone: true }) : alive({ start: "300" })),
    {
      onKill: (pid, sig, recordPath) => {
        const r = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        fs.writeFileSync(recordPath, JSON.stringify({ ...r, S0: [TARGET, member] }));
      }
    }
  );
  const r = s.lock.stopOld({ graceMs: 100 });
  assert.deepEqual(s.signals, [[TARGET.pid, "SIGTERM"]]);
  assert.deepEqual(r.outcomes.map((o) => [o.pid, o.outcome]), [
    [TARGET.pid, "terminated"],
    [member.pid, "not-targeted"]
  ]);
  assert.equal(r.result, "waiting");
  assert.equal(r.ok, false);
  assert.match(r.reason, /pid 5151/);
});

test("N32j: same pid and start time, another script: identity-changed, no signal", (t) => {
  const s = stopOldWith(t, [TARGET], () => alive({ argv: ["node", "/p/scripts/other.mjs", "task-worker"] }));
  const r = s.lock.stopOld({ graceMs: 100 });
  assert.deepEqual(s.signals, []);
  assert.equal(r.outcomes[0].outcome, "identity-changed");
  const sub = stopOldWith(t, [TARGET], () => alive({ argv: ["node", "/p/scripts/codex-companion.mjs", "status"] }));
  assert.equal(sub.lock.stopOld({ graceMs: 100 }).outcomes[0].outcome, "identity-changed", "another subcommand");
  assert.deepEqual(sub.signals, []);
});

test("N32k (v2.9): an exiting process (same pid and start, empty argv) gets no signal and ends as already-gone", (t) => {
  let reads = 0;
  const s = stopOldWith(t, [TARGET], () => {
    reads += 1;
    if (reads === 1) return alive(); // aliveIn under A
    return reads < 5 ? alive({ argv: [] }) : { gone: true };
  });
  const r = s.lock.stopOld({ graceMs: 100 });
  assert.deepEqual(s.signals, []);
  assert.equal(r.outcomes[0].outcome, "already-gone", JSON.stringify(r));
  assert.equal(r.ok, true);
  assert.equal(r.result, "sealed");
});

test("N32l (v2.9): an empty argv that stays: still-alive after the settle time, no signal, no seal", (t) => {
  const s = stopOldWith(t, [TARGET], () => alive({ argv: [] }));
  const started = performance.now();
  const r = s.lock.stopOld({ graceMs: 100 });
  const took = performance.now() - started;
  assert.deepEqual(s.signals, []);
  assert.equal(r.outcomes[0].outcome, "still-alive");
  assert.match(r.outcomes[0].detail, /identity cannot be confirmed/);
  assert.equal(r.ok, false);
  assert.equal(r.result, "waiting");
  assert.equal(s.sealed(), false);
  assert.ok(took >= 450 && took < 3_000, `settle took ${took} ms`);
});

// ---------------------------------------------------------------------------
// N32e: status --all over three state directories (the CLI)
// ---------------------------------------------------------------------------

test("N32e: status --all names sealed, waiting-on-process and waiting-on-residue directories; exit 1 while one waits", { skip: !LINUX && "Linux /proc" }, async (t) => {
  const data = tmpdir(t);
  const stateRoot = path.join(data, "state");
  const live = oldProcess(t);
  await new Promise((r) => setTimeout(r, 50));
  const start = parseProcStat(fs.readFileSync(`/proc/${live.pid}/stat`, "utf8")).start;
  const base = { version: 1, publishedAt: "2026-10-20T00:00:00Z", verdict: "initial", verdictReason: "t", scope: "t", declaration: null, scannedAt: "2026-10-20T00:00:00Z" };
  const dirs = {
    sealed: { ...base, residues: [], S0: [], sealedAt: "2026-10-20T00:00:01Z" },
    process: { ...base, residues: [], S0: [{ ...TARGET, pid: live.pid, start }], sealedAt: null },
    residue: { ...base, residues: [{ name: "state.lock.77", kind: "file", nlink: 2 }], S0: null, scannedAt: null, sealedAt: null }
  };
  for (const [name, record] of Object.entries(dirs)) {
    fs.mkdirSync(path.join(stateRoot, name, "state.lock"), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, name, "state.lock", "fence.json"), JSON.stringify(record));
  }
  const run = spawnSync(process.execPath, [path.resolve(LIB, "..", "codex-companion.mjs"), "state-lock", "status", "--all"], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: data, NODE_NO_WARNINGS: "1" }
  });
  assert.equal(run.status, 1, run.stderr);
  const out = JSON.parse(run.stdout);
  const by = Object.fromEntries(out.stateDirs.filter((d) => d.stateDir.startsWith(stateRoot)).map((d) => [path.basename(d.stateDir), d]));
  assert.equal(by.sealed.sealed, true);
  assert.equal(by.process.waitingOn.kind, "processes");
  assert.equal(by.process.waitingOn.processes[0].pid, live.pid);
  assert.equal(by.residue.waitingOn.kind, "residue");
  assert.ok(out.waiting.includes(path.join(stateRoot, "process")));
  assert.ok(out.waiting.includes(path.join(stateRoot, "residue")));
  assert.equal(out.waiting.includes(path.join(stateRoot, "sealed")), false);
});

// ---------------------------------------------------------------------------
// v2.10 (self-review): a recorded process that now proves the protocol, a
// script held open by an editor, and a record without a start time
// ---------------------------------------------------------------------------

test("R3: an S0 member that holds the protocol marker later no longer holds the seal, and stop-old leaves it alone", { skip: !LINUX && "Linux /proc" }, async (t) => {
  const barriers = tmpdir(t);
  // A new-version process recorded while it was still starting: no marker yet.
  const script = `
    const fs = require("node:fs");
    const wait = (f) => { while (!fs.existsSync(f)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); };
    const [, marker, dir] = process.argv; // with -e, argv[1] is the first argument
    fs.writeFileSync(dir + "/late.ready", "");
    wait(dir + "/late.load");
    globalThis.marker = fs.openSync(marker, "r");
    fs.writeFileSync(dir + "/late.loaded", "");
    wait(dir + "/late.release");
  `;
  const late = track(t, spawn(process.execPath, ["-e", script, path.join(LIB, PROTOCOL_MARKER), barriers, "/plugin/scripts/codex-companion.mjs", "task-worker"], { stdio: "ignore" }));
  await waitFile(path.join(barriers, "late.ready"));
  const start = parseProcStat(fs.readFileSync(`/proc/${late.pid}/stat`, "utf8")).start;
  const member = { pid: late.pid, start, script: "codex-companion.mjs", sub: "task-worker", comm: "node", uid: process.getuid(), reason: "geen marker-fd" };
  const { F } = fencedDir(t, [member]);
  const signals = [];
  const lock = openFencedLock(F, { ...PLUGIN_OPTS, domain: INITIAL, platform: "linux", kill: (pid, sig) => signals.push([pid, sig]) });
  assert.equal(lock.seal({ domainDeclaration: null }).result, "waiting");
  fs.writeFileSync(path.join(barriers, "late.load"), "");
  await waitFile(path.join(barriers, "late.loaded"));
  const r = lock.stopOld({ graceMs: 100 });
  assert.deepEqual(signals, [], "stop-old signalled a process that proves the new protocol");
  assert.equal(r.result, "sealed", JSON.stringify(r));
  assert.equal(late.child.exitCode, null, "the process still runs");
  fs.writeFileSync(path.join(barriers, "late.release"), "");
  await late.exit;
});

test("R4: a plugin script held open by an editor (comm not node or bun) gets no signal without --include-unidentified", (t) => {
  const editor = { ...TARGET, comm: "vim" };
  const s = stopOldWith(t, [editor], () => alive({ comm: "vim", argv: ["vim", "/p/scripts/codex-companion.mjs"] }));
  const r = s.lock.stopOld({ graceMs: 100 });
  assert.deepEqual(s.signals, []);
  assert.equal(r.outcomes[0].outcome, "unidentified");
  assert.match(r.outcomes[0].detail, /vim/);
  assert.equal(r.ok, false, "the seal still waits for it");
});

test("R5: a record without a start time is never signalled, also with --include-unidentified", (t) => {
  const noStart = { pid: 4545, start: null, script: null, sub: null, comm: null, uid: null, reason: "stat unreadable (EACCES)" };
  const s = stopOldWith(t, [noStart], () => ({ start: "1", state: "S", argv: ["anything"], comm: "anything" }));
  const r = s.lock.stopOld({ graceMs: 100, includeUnidentified: true });
  assert.deepEqual(s.signals, []);
  assert.equal(r.outcomes[0].outcome, "unidentified");
  assert.match(r.outcomes[0].detail, /start time/);
});

// ---------------------------------------------------------------------------
// v2.11 (cross-family review): the marker right before a signal, and the PID
// namespace stop-old signals from
// ---------------------------------------------------------------------------

test("R7: a target that opens the marker after the target selection gets no signal (now-proven) and the seal comes", (t) => {
  let markerReads = 0;
  const s = stopOldWith(t, [TARGET], () => alive(), {
    markerReader: () => {
      markerReads += 1;
      return markerReads > 1; // false while the targets are chosen under A, true at the first signal check
    }
  });
  const r = s.lock.stopOld({ graceMs: 100 });
  assert.deepEqual(s.signals, []);
  assert.equal(r.outcomes[0].outcome, "now-proven", JSON.stringify(r));
  assert.equal(r.result, "sealed");
  assert.equal(r.ok, true);
});

test("R8: stop-old never signals outside the init PID namespace, nor for a record scanned outside it (Linux)", (t) => {
  const nested = () => ({ verdict: "nested", reason: "PID namespace pid:[1]", scope: "test" });
  for (const [label, domain, recordVerdict] of [
    ["caller nested", nested, "initial"],
    ["record nested", INITIAL, "nested"]
  ]) {
    const { F, recordPath } = fencedDir(t, [TARGET]);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    fs.writeFileSync(recordPath, JSON.stringify({ ...record, verdict: recordVerdict }));
    const signals = [];
    const lock = openFencedLock(F, {
      ...PLUGIN_OPTS,
      domain,
      scanner: () => ({ self: { pid: process.pid, start: null, matched: true }, processes: [] }),
      identityReader: () => alive(),
      markerReader: () => false,
      kill: (pid, sig) => signals.push([pid, sig]),
      platform: "linux"
    });
    const r = lock.stopOld({ graceMs: 100 });
    assert.deepEqual(signals, [], label);
    assert.equal(r.result, "domain", `${label}: ${JSON.stringify(r)}`);
    assert.equal(r.ok, false);
  }
});

test("R7 (grace): a target that opens the marker during the grace after SIGTERM gets no SIGKILL; a second target that opens it while the first is stopped gets no signal at all", (t) => {
  const second = { ...TARGET, pid: 4343, start: "300" };
  let firstProven = false;
  let secondProven = false;
  const s = stopOldWith(
    t,
    [TARGET, second],
    (p) => (p.pid === TARGET.pid ? alive() : alive({ start: "300" })),
    {
      markerReader: (p) => (p.pid === TARGET.pid ? firstProven : secondProven),
      onKill: (pid, sig) => {
        if (pid === TARGET.pid && sig === "SIGTERM") {
          // during the grace of the first target both new processes finish loading
          firstProven = true;
          secondProven = true;
        }
      }
    }
  );
  const r = s.lock.stopOld({ graceMs: 300 });
  assert.deepEqual(s.signals, [[TARGET.pid, "SIGTERM"]], "only the first SIGTERM, before either proved anything");
  assert.deepEqual(r.outcomes.map((o) => [o.pid, o.outcome]), [
    [TARGET.pid, "now-proven"],
    [second.pid, "now-proven"]
  ]);
  assert.equal(r.result, "sealed");
});
