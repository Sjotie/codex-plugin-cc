// `codex-companion state-lock …` (#1916): status, drain-check, adopt-legacy,
// seal, stop-old and unfence for the state lock. Every command prints JSON and
// has its own --help, so agents can run them; the timeout of a waiting writer
// names the exact next command.
import fs from "node:fs";
import path from "node:path";

import { parseArgs } from "./args.mjs";
import { artifactReport, openStateLock, openStateLockAt, resolveStateDir, resolveStateRoots } from "./state.mjs";

const HELP = {
  overview: `Usage: codex-companion state-lock <command> [options]

The Codex plugin state lock (#1916). Commands:
  status        state of the lock in one workspace (--cwd) or every state directory (--all)
  drain-check   which plugin processes run here, and whether each proves the new protocol
  adopt-legacy  move a dead old lock file aside and put up the fence (guided, after a drain-check)
  seal          seal a fence outside the init PID namespace, with a declaration
  stop-old      stop the old plugin processes a fence's seal waits for (exact pid and start time)
  unfence       take the fence away again (rollback to an older plugin version)

Every command prints JSON. Run state-lock <command> --help for its options.`,
  status: `Usage: codex-companion state-lock status [--cwd <dir> | --all]

Prints the lock state as JSON: fence or old lock file, the seal record, what an
unsealed fence waits for (O2 residue, old processes, domain), the owner, the
protocol names and the job artifacts (orphans, unreadable records). With --all,
one entry per state directory; exit code 1 while any directory waits.`,
  "drain-check": `Usage: codex-companion state-lock drain-check

Lists the plugin processes on this kernel (Linux) or machine (macOS) with pid,
start time, argv and verdict: new (holds the protocol marker), unproven, or
no-lock-path (an old broker). result is "drained" when nothing is unproven.
The process running this command is reported under "self" and not counted.
Exit code 0 when drained, 2 when not.`,
  "adopt-legacy": `Usage: codex-companion state-lock adopt-legacy --cwd <dir> --expect-dev <d> --expect-ino <i> --expect-sha <sha256>
                                      [--declare-cross-namespace "<who, which namespaces, how drained>"]

Moves a dead old state.lock file to state.lock.quarantine-* and puts up the
fence in the same holding. Take the expected values from state-lock status.
Refuses when the values differ, when the drain-check is not "drained", or
outside the init PID namespace without a declaration. Exit code 0 only when
the moved object was the expected one and the fence stands.`,
  seal: `Usage: codex-companion state-lock seal --cwd <dir> --declare-cross-namespace "<who, which namespaces, how drained>"

Only needed when the domain verdict is not "initial" (a sandbox with its own
PID namespace, or macOS before its landing proof). Records the declaration and
seals once no recorded old process still lives. Exit code 0 when sealed.

When the record was made in another procfs (status: waitingOn.kind "foreign",
e.g. by the host while this runs in a container), this namespace cannot see
the recorded processes. Then seal scans here instead, under the declaration,
which so also vouches that the processes of the replaced record are gone; the
replaced record is kept in the new one (replacedForeign). Prefer sealing from
the init PID namespace when there is one: any state change there, or
state-lock stop-old, scans again and judges every process. A sealed record is
never changed.`,
  "stop-old": `Usage: codex-companion state-lock stop-old (--cwd <dir> | --all) [--grace-ms 5000] [--include-unidentified]

Stops only the old plugin processes an unsealed fence waits for, each after a
fresh check of pid, start time and script: SIGCONT if stopped, SIGTERM, and
SIGKILL after the grace. A process that holds the protocol marker by then is
never signalled (now-proven). Processes recorded only because their argv was
unreadable, or whose name is not node or bun (an editor with a plugin script
open), are stopped only with --include-unidentified; a record without a start
time never. On Linux it only signals from the init PID namespace with a full
procfs, where the recorded pids are the pids kill() uses. Then seals. One
outcome per process; exit code 0 only when every process is gone and the
fence is sealed. Never touches files.`,
  unfence: `Usage: codex-companion state-lock unfence (--cwd <dir> | --all)

Renames the fence to state.lock.retired-* under the lock, so an older plugin
version can write again. Run it with the code of the new version. Exit code 0
only when no directory was busy or unknown.`
};

function out(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function stateDirs() {
  const dirs = [];
  for (const root of resolveStateRoots()) {
    let names = [];
    try {
      names = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      if (entry.isDirectory()) dirs.push(path.join(root, entry.name));
    }
  }
  return dirs;
}

function targets(options) {
  if (options.all) return stateDirs().map((dir) => ({ dir, lock: openStateLockAt(dir) }));
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  return [{ dir: resolveStateDir(cwd), lock: openStateLock(cwd) }];
}

function statusEntry(dir, lock) {
  const status = lock.status();
  return { stateDir: dir, ...status, artifacts: artifactReport(dir) };
}

function waits(entry) {
  return entry.kind === "directory" ? !entry.sealed : entry.kind === "file";
}

export async function runStateLockCommand(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${HELP.overview}\n`);
    return 0;
  }
  if (!HELP[command]) {
    process.stderr.write(`Unknown state-lock command: ${command}\n${HELP.overview}\n`);
    return 1;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(`${HELP[command]}\n`);
    return 0;
  }
  const { options } = parseArgs(rest, {
    rejectUnknownOptions: "always",
    valueOptions: ["cwd", "expect-dev", "expect-ino", "expect-sha", "declare-cross-namespace", "grace-ms"],
    booleanOptions: ["all", "json", "include-unidentified"],
    aliasMap: { C: "cwd" }
  });

  switch (command) {
    case "status": {
      const entries = targets(options).map(({ dir, lock }) => statusEntry(dir, lock));
      if (options.all) {
        out({ stateDirs: entries, waiting: entries.filter(waits).map((e) => e.stateDir) });
        return entries.some(waits) ? 1 : 0;
      }
      out(entries[0]);
      return 0;
    }
    case "drain-check": {
      const [{ lock }] = targets({ cwd: options.cwd });
      const result = lock.drainCheck();
      out(result);
      return result.result === "drained" ? 0 : 2;
    }
    case "adopt-legacy": {
      for (const key of ["expect-dev", "expect-ino", "expect-sha"]) {
        if (!options[key]) throw new Error(`adopt-legacy needs --${key} (from state-lock status)`);
      }
      const [{ lock }] = targets({ cwd: options.cwd });
      const declaration = options["declare-cross-namespace"] ?? null;
      if (declaration) process.stderr.write(`state-lock adopt-legacy: declaration outside the init PID namespace: ${declaration}\n`);
      try {
        const result = lock.adoptLegacy({
          expectDev: options["expect-dev"],
          expectIno: options["expect-ino"],
          expectSha: options["expect-sha"],
          domainDeclaration: declaration
        });
        out(result);
        if (!result.ok) {
          process.stderr.write(`state-lock adopt-legacy: ${result.code}; see ${result.logPath}\n`);
        }
        return result.ok ? 0 : 1;
      } catch (error) {
        out({ ok: false, code: error.code, message: error.message, details: error.details ?? null });
        return 1;
      }
    }
    case "seal": {
      const declaration = options["declare-cross-namespace"];
      if (!declaration) throw new Error("seal needs --declare-cross-namespace \"<who, which namespaces, how drained>\"");
      process.stderr.write(`state-lock seal: declaration: ${declaration}\n`);
      const [{ lock }] = targets({ cwd: options.cwd });
      const result = lock.seal({ domainDeclaration: declaration });
      out(result);
      return result.result === "sealed" ? 0 : 1;
    }
    case "stop-old": {
      if (!options.cwd && !options.all) throw new Error("stop-old needs --cwd <dir> or --all");
      const graceMs = options["grace-ms"] == null ? 5_000 : Number(options["grace-ms"]);
      if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("--grace-ms must be a number >= 0");
      const results = targets(options).map(({ dir, lock }) => ({
        stateDir: dir,
        ...lock.stopOld({ graceMs, includeUnidentified: Boolean(options["include-unidentified"]) })
      }));
      const relevant = results.filter((r) => r.result !== "no-fence");
      out(options.all ? { stateDirs: results } : results[0]);
      return relevant.every((r) => r.ok) ? 0 : 1;
    }
    case "unfence": {
      if (!options.cwd && !options.all) throw new Error("unfence needs --cwd <dir> or --all");
      const results = targets(options).map(({ dir, lock }) => ({ stateDir: dir, ...lock.unfence() }));
      const counts = {};
      for (const r of results) counts[r.result] = (counts[r.result] ?? 0) + 1;
      out({ stateDirs: results, counts });
      return results.some((r) => r.result === "busy" || r.result === "unknown") ? 1 : 0;
    }
    default:
      return 1;
  }
}
