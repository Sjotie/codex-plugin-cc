#!/usr/bin/env python3
"""Native proof of design D (#1916) on macOS with the real Claude Code 2.1.301.

Drives one owned interactive Claude session in a pseudo-terminal, with the
product plugin byte-copied from this checkout and its fixed hooks unchanged:

  startup -> Bash probe -> start a background worker -> manual /compact ->
  Bash probe -> auto compact (small auto-compact window, filler output) ->
  worker publishes -> Bash probe -> /exit

and measures, for every SessionStart, the latency from the hook's exit event
to the moment its receipt line R (this attempt's token) is in the transcript.

Run on the Mac, from the plugin checkout, with an existing Claude login:

    uv run python tests/fenced-lock/macos-d-pty-probe.py

Options: --auto-window TOKENS (default 20000), --max-fills N (default 60),
--auto-minutes M (default 25), --claude PATH. It keeps its fixture directory as evidence, writes
<fixture>/summary.json and prints its path; remove the directory when done.
Exit status 0 only when every check passed. It stops only the Claude process
it started itself. Each step waits for the turn's Stop hook before the next
input, so inputs never queue behind a running turn.

Evidence holds names, hashes, timings and fixed refusal labels only: no raw
envelope, certificate or credential. Capability and attempt ids are
unpredictable but not secrets; the summary still shows only their hashes.
"""
import argparse
import hashlib
import json
import os
import platform
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EXPECTED_VERSION = "2.1.301"
COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs" SessionStart'


def sha(text, n=16):
    return hashlib.sha256(text.encode()).hexdigest()[:n] if text else None


def file_sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def read_jsonl(path):
    out = []
    try:
        with open(path, encoding="utf8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    except FileNotFoundError:
        pass
    return out


# Loaded into every node process (hooks, Bash probes, worker) via NODE_OPTIONS.
# It changes no product byte: it records hook start/exit and the hook's own
# stdout token, then passes stdout through unchanged.
BOOTSTRAP = r"""
import fs from "node:fs";
const root = process.env.D_PROBE_ROOT;
const argv = process.argv.slice(1).join(" ");
const m = /session-lifecycle-hook\.mjs (SessionStart|SessionEnd)$/.exec(argv) ?? (/stop-review-gate-hook\.mjs/.test(argv) ? [null, "Stop"] : null);
if (root && m) {
  const event = m[1];
  const log = (row) => fs.appendFileSync(`${root}/events.jsonl`, JSON.stringify({ ...row, event, pid: process.pid, sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null }) + "\n");
  log({ kind: "hook-start", at: Date.now() });
  let token = null;
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { try { const t = JSON.parse(String(chunk)).codexStateLockAdmission; if (t) token = t; } catch {} return write(chunk, ...rest); };
  // The hook exports Claude's transcript_path to CLAUDE_ENV_FILE; read it back
  // instead of guessing Claude's project-directory naming.
  const transcriptPath = () => { try { const m = [...fs.readFileSync(process.env.CLAUDE_ENV_FILE, "utf8").matchAll(/^export CODEX_COMPANION_TRANSCRIPT_PATH='(.*)'$/gm)].at(-1); return m ? m[1] : null; } catch { return null; } };
  process.on("exit", (code) => { const t = event === "SessionStart" ? transcriptPath() : null;
    log({ kind: "hook-exit", at: Date.now(), code, attemptId: token?.attemptId ?? null, capabilityId: token?.capabilityId ?? null, source: token?.source ?? null, transcriptPath: t, transcriptExistsAtExit: t ? fs.existsSync(t) : null }); });
}
"""

# One Bash call: try the state lock with the inherited envelope and commit a
# state write. Prints a fixed word; details go to a file, hashes only.
PROBE = r"""
import fs from "node:fs";
import crypto from "node:crypto";
const [root, stateUrl] = [__ROOT__, __STATE__];
const sha = (s) => s ? crypto.createHash("sha256").update(s).digest("hex").slice(0, 16) : null;
let envelope = null; try { envelope = JSON.parse(process.env.CODEX_COMPANION_LOCK_ADMISSION ?? "null"); } catch {}
const state = await import(stateUrl);
let acquired = false, wrote = false, error = null;
try { const lock = state.openStateLock(root); const h = lock.acquire({ deadlineMs: 3000 }); acquired = true; lock.release(h); state.setConfig(root, "dProbeAt", Date.now()); wrote = true; }
catch (e) { error = { code: e.code ?? null, reason: String(e.reason ?? e.message).slice(0, 160) }; }
fs.writeFileSync(`${root}/probe-${Date.now()}.json`, JSON.stringify({ at: Date.now(), acquired, wrote, error, envelopeVersion: envelope?.version ?? null, capabilitySha: sha(envelope?.capabilityId), sessionSha: sha(process.env.CLAUDE_CODE_SESSION_ID) }));
console.log(acquired && wrote ? "PROBE OK" : "PROBE REFUSED");
"""

# A worker started from Bash before compact, detached, with the envelope of
# that moment. It publishes its result through the product runTrackedJob once
# the controller releases it.
WORKER = r"""
import fs from "node:fs";
import { spawn } from "node:child_process";
const [root, stateUrl, trackedUrl] = [__ROOT__, __STATE__, __TRACKED__];
if (process.argv[2] !== "run") {
  spawn(process.execPath, [process.argv[1], "run"], { detached: true, stdio: "ignore" }).unref();
  console.log("WORKER STARTED");
} else {
  const state = await import(stateUrl), tracked = await import(trackedUrl);
  const job = { id: `d-worker-${Date.now()}`, status: "queued", phase: "queued", jobClass: "task", title: "D worker over compact", workspaceRoot: root, sessionId: process.env.CODEX_COMPANION_SESSION_ID ?? null, pid: process.pid };
  const result = { startedAt: Date.now(), jobId: job.id, published: false, error: null };
  try {
    state.upsertJob(root, job); state.writeJobFile(root, job.id, job);
    job.logFile = state.resolveJobLogFile(root, job.id); fs.writeFileSync(job.logFile, "");
    fs.writeFileSync(`${root}/worker-ready.json`, JSON.stringify({ at: Date.now(), jobId: job.id }));
    await tracked.runTrackedJob(job, async () => { while (!fs.existsSync(`${root}/worker-release`)) await new Promise((r) => setTimeout(r, 25)); result.releasedAt = Date.now();
      return { exitStatus: 0, threadId: "d-thread", turnId: "d-turn", payload: { ok: true }, rendered: "D worker result kept over compact", summary: "done" }; });
    result.published = true;
  } catch (e) { result.error = { code: e.code ?? null, reason: String(e.reason ?? e.message).slice(0, 160) }; }
  result.finishedAt = Date.now();
  try { const stored = JSON.parse(fs.readFileSync(state.resolveJobFile(root, job.id), "utf8")); result.storedStatus = stored.status; result.storedRendered = stored.rendered === "D worker result kept over compact"; } catch {}
  try { result.logHasResult = fs.readFileSync(job.logFile, "utf8").includes("D worker result kept over compact"); } catch {}
  fs.writeFileSync(`${root}/worker-result.json`, JSON.stringify(result));
}
"""


class Pty:
    """The owned Claude process on a pseudo-terminal, with a screen log."""

    def __init__(self, argv, cwd, env, log_path):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        self.log = open(log_path, "wb")
        self.buffer = b""
        self.alive = True
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _pump(self):
        while self.alive:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.1)
                if ready:
                    data = os.read(self.fd, 65536)
                    if not data:
                        break
                    self.log.write(data)
                    self.log.flush()
                    self.buffer = (self.buffer + data)[-200_000:]
            except OSError:
                break
        self.alive = False

    def send(self, text):
        os.write(self.fd, text.encode())

    def screen(self):
        return re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]", b"", self.buffer).decode("utf8", "replace")

    def exited(self):
        try:
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
            return pid == self.pid
        except ChildProcessError:
            return True

    def stop(self):
        # Only this pid, which we forked ourselves.
        for sig, wait in ((signal.SIGTERM, 5), (signal.SIGKILL, 2)):
            if self.exited():
                break
            try:
                os.kill(self.pid, sig)
            except ProcessLookupError:
                break
            end = time.time() + wait
            while time.time() < end and not self.exited():
                time.sleep(0.1)
        self.alive = False


class TranscriptWatch(threading.Thread):
    """Polls the session transcript and notes when each receipt line appears."""

    def __init__(self, path):
        super().__init__(daemon=True)
        self.path, self.seen, self.offset, self.running = path, {}, 0, True

    def run(self):
        partial = b""
        while self.running:
            try:
                with open(self.path, "rb") as f:
                    f.seek(self.offset)
                    chunk = f.read()
                    self.offset += len(chunk)
            except FileNotFoundError:
                chunk = b""
            now = time.time() * 1000
            partial += chunk
            *lines, partial = partial.split(b"\n")
            for line in lines:
                try:
                    r = json.loads(line)
                    a = r.get("attachment") or {}
                    if a.get("command") != COMMAND:
                        continue
                    token = (json.loads(a.get("stdout") or "{}") or {}).get("codexStateLockAdmission") or {}
                    key = token.get("attemptId") or f"untokened-{len(self.seen)}"
                    self.seen.setdefault(key, {"seenAt": now, "type": a.get("type"), "exitCode": a.get("exitCode"), "hookName": a.get("hookName"), "durationMs": a.get("durationMs"), "version": r.get("version"), "source": token.get("source")})
                except ValueError:
                    pass
            time.sleep(0.002)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--claude", default=shutil.which("claude") or "claude")
    ap.add_argument("--auto-window", type=int, default=20000)
    ap.add_argument("--max-fills", type=int, default=60)
    ap.add_argument("--auto-minutes", type=float, default=25)
    args = ap.parse_args()

    assert sys.platform == "darwin", "native macOS only"
    assert platform.machine() == "arm64", "the receipt manifest proves darwin/arm64 only"
    version = subprocess.run([args.claude, "--version"], capture_output=True, text=True).stdout.strip()
    assert version.startswith(EXPECTED_VERSION), f"Claude Code {EXPECTED_VERSION} required, found {version!r}"
    claude_bin = os.path.realpath(shutil.which(args.claude) or args.claude)

    root = os.path.realpath(tempfile.mkdtemp(prefix="d-pty-probe-"))
    plugin = os.path.join(root, "plugin")
    subprocess.run(["git", "init", "--quiet", root], check=True)
    files = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "plugins/codex"], cwd=REPO, capture_output=True, text=True, check=True).stdout.split()
    source_hashes = {}
    for rel in files:
        assert not os.path.basename(rel).startswith(".env"), "environment files cannot enter the fixture"
        target = os.path.join(plugin, rel[len("plugins/codex/"):])
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(os.path.join(REPO, rel), target)
        source_hashes[rel] = file_sha(target)
    hooks = json.load(open(os.path.join(plugin, "hooks/hooks.json")))
    assert hooks["hooks"]["SessionStart"][0]["hooks"][0]["command"] == COMMAND, "fixed SessionStart command changed"

    def node_file(name, body):
        path = os.path.join(root, name)
        body = body.replace("__ROOT__", json.dumps(root)).replace("__STATE__", json.dumps("file://" + os.path.join(plugin, "scripts/lib/state.mjs"))).replace("__TRACKED__", json.dumps("file://" + os.path.join(plugin, "scripts/lib/tracked-jobs.mjs")))
        open(path, "w").write(body)
        return path

    bootstrap = node_file("bootstrap.mjs", BOOTSTRAP)
    probe = node_file("d-probe.mjs", PROBE)
    worker = node_file("d-worker.mjs", WORKER)
    filler = os.path.join(root, "filler.txt")
    with open(filler, "w") as f:
        for i in range(700):
            f.write(f"filler line {i:04d} for the auto compact window of the D probe; it carries no instruction.\n")
    node = shutil.which("node")
    commands = os.path.join(plugin, "commands")
    for name, line, what in (("d-probe", f"{node} {probe}", "the D admission probe"), ("d-worker", f"{node} {worker}", "the D background worker"), ("d-fill", f"cat {filler}", "the filler output")):
        open(os.path.join(commands, f"{name}.md"), "w").write(f"---\ndescription: {what}\nallowed-tools: Bash(node:*), Bash(cat:*)\n---\nRun exactly this Bash command once, then say only OK. Do not run other commands.\n\n```bash\n{line}\n```\n")
    settings = os.path.join(root, "settings.json")
    # Bash sandbox off: Claude gives plugin hooks CLAUDE_PLUGIN_DATA under
    # ~/.claude/plugins/data/<plugin>, outside the sandbox's write area, so a
    # sandboxed Bash state write fails with EPERM on mkdir. That predates D
    # (state-directory resolution and the hook's export are unchanged since
    # 258047f; the old harness hid it by redirecting CLAUDE_PLUGIN_DATA in its
    # preload) and is a separate #1916 todo. This probe measures D, not that.
    json.dump({"sandbox": {"enabled": False}, "enabledPlugins": {}, "permissions": {"allow": ["Bash(node:*)", "Bash(cat:*)"]}}, open(settings, "w"))

    # CLAUDE_CODE_CHILD_SESSION (set when this runs inside another Claude
    # session) makes the interactive Claude write no transcript at all
    # (bisected on the Mac over 51 variables), so no receipt could exist.
    env = {k: v for k, v in os.environ.items() if not (k.startswith("CODEX_COMPANION_") or k in ("CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "NODE_OPTIONS"))}
    env.update({"TERM": "xterm-256color", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "D_PROBE_ROOT": root, "CLAUDE_PLUGIN_DATA": os.path.join(root, "data"),
                "NODE_OPTIONS": f"--import=file://{bootstrap}", "CLAUDE_CODE_AUTO_COMPACT_WINDOW": str(args.auto_window)})
    argv = [args.claude, "--plugin-dir", plugin, "--setting-sources", "", "--settings", settings, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "Bash"]

    summary = {"root": root, "claudeVersion": version, "claudeBinarySha256": file_sha(claude_bin), "arch": platform.machine(), "repoHead": subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip(),
               "sourceHashes": source_hashes, "harnessSha256": file_sha(__file__), "autoWindow": args.auto_window, "phases": [], "checks": {}}
    events_path = os.path.join(root, "events.jsonl")

    def events(kind=None, event=None):
        return [e for e in read_jsonl(events_path) if (kind is None or e.get("kind") == kind) and (event is None or e.get("event") == event)]

    def probes():
        return sorted((json.load(open(os.path.join(root, n))) for n in os.listdir(root) if n.startswith("probe-") and n.endswith(".json")), key=lambda p: p["at"])

    def persist():
        json.dump(summary, open(os.path.join(root, "summary.json"), "w"), indent=2)

    term = Pty(argv, root, env, os.path.join(root, "pty.log"))
    trusted = False

    def wait(predicate, label, timeout=120):
        nonlocal trusted
        end = time.time() + timeout
        while time.time() < end:
            value = predicate()
            if value:
                return value
            screen = term.screen()
            if not trusted and re.search(r"I\s*trust\s*this\s*folder", screen, re.I):
                # The cursor starts on "No, exit": move down to "Yes, I trust this folder".
                time.sleep(1)
                term.send("\x1b[B")
                time.sleep(1)
                spaced = re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]", b" ", term.buffer[-600:]).decode("utf8", "replace")
                if "❯ Yes" not in re.sub(r"\s+", " ", spaced):
                    raise RuntimeError("trust dialog: cursor is not on Yes; refusing to confirm")
                term.send("\r")
                trusted = True
            if re.search(r"usage limit|rate limit|please log in|login required|reauthenticate", screen, re.I):
                raise RuntimeError(f"{label}: provider login/quota boundary")
            if term.exited():
                raise RuntimeError(f"{label}: Claude exited")
            time.sleep(0.05)
        raise RuntimeError(f"{label}: timed out")

    def session_start(source, after):
        return next((e for e in events("hook-exit", "SessionStart") if e["at"] > after and e.get("source") == source), None)

    watch = None

    def receipt_latency(start_exit, latency=True):
        nonlocal watch
        if watch is None:
            path = start_exit.get("transcriptPath")
            if not path:
                raise RuntimeError("SessionStart exported no transcript path")
            watch = TranscriptWatch(path)
            watch.start()
            summary["transcriptPathSha"] = sha(path)
        try:
            seen = wait(lambda: watch.seen.get(start_exit["attemptId"]), f"receipt line of {start_exit['source']}", 30)
        except RuntimeError:
            summary["receiptMissing"] = {"source": start_exit["source"], "transcriptExistsAtExit": start_exit.get("transcriptExistsAtExit"),
                                         "transcriptExistsNow": os.path.exists(watch.path), "receiptLinesSeen": len(watch.seen)}
            raise
        # Startup: Claude creates the transcript only with the first user turn,
        # so the time to its receipt line is the time to that turn, no latency.
        timing = {"latencyHookExitToReceiptMs": round(seen["seenAt"] - start_exit["at"], 1)} if latency else {"receiptRecordedWithFirstTurn": True}
        return {"source": start_exit["source"], "transcriptExistsAtExit": start_exit.get("transcriptExistsAtExit"), "attemptSha": sha(start_exit["attemptId"]), "capabilitySha": sha(start_exit["capabilityId"]), "hookExitCode": start_exit["code"],
                **timing, "receiptType": seen["type"], "receiptExitCode": seen["exitCode"], "receiptDurationMs": seen["durationMs"], "receiptVersion": seen["version"]}

    def turn(command, label, timeout=180):
        """Send one slash command and wait for that turn's Stop hook."""
        sent = time.time() * 1000
        term.send(command + "\r")
        wait(lambda: any(e["at"] > sent for e in events("hook-exit", "Stop")), f"{label} turn", timeout)
        return sent

    def run_probe(label):
        before = len(probes())
        turn("/d-probe", f"{label} probe")
        wait(lambda: len(probes()) > before, f"{label} probe file")
        p = probes()[-1]
        summary["phases"].append({"phase": label, "probe": p})
        persist()
        return p

    try:
        t0 = time.time() * 1000
        start = wait(lambda: session_start("startup", t0), "startup SessionStart")
        # The first user turn creates the transcript; only then can the
        # startup receipt line exist. So probe first, then look for R.
        p1 = run_probe("after startup")
        startup = receipt_latency(start, latency=False)
        summary["phases"].append({"phase": "startup", "sessionStart": startup})

        # Claude's automatic permission check can refuse a command once;
        # resend a refused worker start a single time.
        for attempt in range(2):
            turn("/d-worker", "start worker")
            try:
                wait(lambda: os.path.exists(os.path.join(root, "worker-ready.json")), "worker ready", 30)
                break
            except RuntimeError:
                if attempt == 1:
                    raise
                summary["workerStartRetried"] = True

        t_manual = time.time() * 1000
        term.send("/compact\r")
        manual = receipt_latency(wait(lambda: session_start("compact", t_manual), "manual compact SessionStart", 300))
        summary["phases"].append({"phase": "manual compact", "sessionStart": manual})
        p2 = run_probe("after manual compact")

        # Auto compact: grow the context with filler output until Claude
        # compacts by itself. Release the worker as soon as that compact's
        # hook starts, so its final publication overlaps the attempt.
        # Keep filling until a compact SessionStart appears that we did not
        # ask for, bounded by --max-fills and --auto-minutes.
        t_auto = time.time() * 1000
        auto_deadline = time.time() + args.auto_minutes * 60
        released = False
        auto = None
        fills = 0
        for fill in range(args.max_fills):
            if time.time() > auto_deadline:
                break
            fills = fill + 1
            sent = time.time() * 1000
            term.send("/d-fill\r")
            end = min(time.time() + 300, auto_deadline)
            while time.time() < end:
                if not released and any(e["at"] > t_auto for e in events("hook-start", "SessionStart")):
                    open(os.path.join(root, "worker-release"), "w").close()
                    released = True
                auto_exit = session_start("compact", t_auto)
                if auto_exit:
                    auto = receipt_latency(auto_exit)
                    break
                if any(e["at"] > sent for e in events("hook-exit", "Stop")):
                    break
                if term.exited():
                    raise RuntimeError("auto compact: Claude exited")
                time.sleep(0.1)
            if auto:
                summary["phases"].append({"phase": "auto compact", "fills": fill + 1, "sessionStart": auto})
                break
        summary["autoCompactAttempt"] = {"fills": fills, "observed": auto is not None, "window": args.auto_window}
        if not released:
            open(os.path.join(root, "worker-release"), "w").close()
        worker_result = wait(lambda: os.path.exists(os.path.join(root, "worker-result.json")) and json.load(open(os.path.join(root, "worker-result.json"))), "worker result", 300)
        summary["worker"] = worker_result
        p3 = run_probe("after auto compact")

        term.send("/exit\r")
        wait(lambda: term.exited() or events("hook-exit", "SessionEnd"), "SessionEnd", 60)

        stops = events("hook-exit", "Stop")
        caps = {p1.get("capabilitySha"), p2.get("capabilitySha"), p3.get("capabilitySha")}
        summary["checks"] = {
            "startupProbeAdmitted": p1["acquired"] and p1["wrote"],
            "manualCompactKeepsC": manual["capabilitySha"] == startup["capabilitySha"] and manual["receiptExitCode"] == 0,
            "bashAfterManualCompactAdmitted": p2["acquired"] and p2["wrote"],
            "autoCompactObserved": auto is not None,
            "autoCompactKeepsC": bool(auto) and auto["capabilitySha"] == startup["capabilitySha"] and auto["receiptExitCode"] == 0,
            "bashAfterAutoCompactAdmitted": p3["acquired"] and p3["wrote"],
            "bashKeptOneEnvelope": len(caps) == 1 and None not in caps,
            "workerPublishedOverCompact": worker_result.get("published") is True and worker_result.get("storedStatus") == "completed" and worker_result.get("storedRendered") is True,
            "workerLogKeptResult": worker_result.get("logHasResult") is True,
            "stopHooksSucceeded": bool(stops) and all(e.get("code") == 0 for e in stops),
            "sessionEndSucceeded": all(e.get("code") == 0 for e in events("hook-exit", "SessionEnd")),
            "receiptVersionProven": all(s.get("receiptVersion") == EXPECTED_VERSION for s in (startup, manual, auto) if s),
        }
        summary["latencyMs"] = {label: s["latencyHookExitToReceiptMs"] for label, s in (("manual compact", manual), ("auto compact", auto)) if s}
        summary["passed"] = all(summary["checks"].values())
    except Exception as error:  # noqa: BLE001 - every failure lands in the summary
        summary["passed"] = False
        summary["failure"] = str(error)
    finally:
        if watch:
            watch.running = False
        term.stop()
        summary["ownClaudeStopped"] = term.exited()
        persist()
        print(json.dumps({"summary": os.path.join(root, "summary.json"), "passed": summary.get("passed"), "latencyMs": summary.get("latencyMs"), "failure": summary.get("failure")}))
    sys.exit(0 if summary.get("passed") else 1)


if __name__ == "__main__":
    main()
