#!/usr/bin/env python3
"""Native receipt proof of one Claude Code version on macOS (#1916, design D).

This is the per-version proof that `provider-receipts.json` asks for: run it
against the exact Claude Code version under test, with that version's entry
already in the checkout's manifest; only a fully green run may back the entry.

Drives owned interactive Claude sessions in a pseudo-terminal, with the
product plugin byte-copied from this checkout and its fixed hooks unchanged:

  startup -> Bash probe -> start a background worker -> manual /compact ->
  Bash probe -> auto compact (small auto-compact window, filler output) ->
  worker publishes -> Bash probe -> /clear -> Bash probe -> /exit
  resume of the cleared session -> Bash probe -> /exit
  three fresh startups whose SessionStart hook exits one, is killed after its
  stdout, or writes a partial stdout -> Bash probe must refuse -> /exit

and measures, for every SessionStart, the latency from the hook's exit event
to the moment its receipt line R (this attempt's token) is in the transcript.
It also checks that no capability or attempt id reaches model input: in every
transcript these ids appear only in the raw stdout of the fixed hook's record.

Run on the Mac, from the plugin checkout, with an existing Claude login. For a
new Claude Code version, one command does the whole proof (about ten minutes,
one short session); as a Factory job, keep the fixture out of the job's TMPDIR,
which is removed when the job ends:

    factory-job run --name receipt-X.Y.Z --kind net -- \\
      env TMPDIR="$FACTORY_SCRATCH_DIR/1916" \\
      uv run python tests/fenced-lock/macos-d-pty-probe.py --expect-version X.Y.Z --prepare-candidate

--prepare-candidate (the version must not be listed yet; plugins/codex and this
harness must be committed) adds the candidate entry with the measured binary
hash, so the product admits the version for the run. Only a fully green run
keeps it: it then writes the measured sanitized record shapes to
tests/fixtures/provider-receipts/claude-code-X.Y.Z.json, the sanitized summary
to docs/releases/claude-code-X.Y.Z-receipt-evidence.json, and completes the
entry with evidenceCommit (HEAD, which holds the exact product and harness
bytes) and both hashes. Commit those three files and send them to review. The
candidate lives only in the run's own copy of the plugin, so a red, failed or
killed run leaves the checkout untouched. Without the flag the entry must
already be listed, with this binary's hash.

Options: --expect-version X.Y.Z (required; must equal `claude --version`),
--prepare-candidate, --auto-window TOKENS (default 20000), --max-fills N
(default 60), --auto-minutes M (default 25), --claude PATH. It keeps its fixture directory as evidence, writes
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
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs" SessionStart'


def sha(text, n=16):
    return hashlib.sha256(text.encode()).hexdigest()[:n] if text else None


def file_sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


MANIFEST_REL = "plugins/codex/scripts/lib/provider-receipts.json"
ADAPTER = "session-start-hook-success-v1"


def candidate_paths(version):
    return {"evidenceSummary": f"docs/releases/claude-code-{version}-receipt-evidence.json",
            "fixtures": f"tests/fixtures/provider-receipts/claude-code-{version}.json"}


def record_shapes(raw, version):
    """The adapter-read fields of the measured records, values as placeholders."""
    success, context = raw["hookSuccess"], raw["additionalContext"]
    a, c = success["attachment"], context["attachment"]
    assert a["hookName"] == "SessionStart:startup" and a["command"] == COMMAND, "unexpected success receipt shape"
    content = c.get("content")
    assert isinstance(content, list) and len(content) >= 2 and all(isinstance(x, str) for x in content) and isinstance(c.get("toolUseID"), str), \
        "unexpected context record shape (the probe's second hook must give a merged record)"
    base = lambda r: {"type": r["type"], "version": version, "sessionId": "<sessionId>", "cwd": "<cwd>", "isSidechain": r["isSidechain"]}
    # The merged record literally, key order as measured; every string value a
    # placeholder except the fixed identifiers, content neutral.
    # gitBranch is the probe's own fresh fixture repository, not a captured one.
    fixed = {"type", "hookName", "hookEvent", "renderedRole", "userType", "entrypoint", "version", "gitBranch"}
    def literal(value, key=None):
        if key == "version":
            return version
        if key == "toolUseID":
            return value if value == "SessionStart" else "<toolUseID>"
        if isinstance(value, dict):
            return {k: literal(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [literal(v) for v in value]
        if isinstance(value, str) and key not in fixed:
            return f"<{key or 'value'}>"
        return value
    return {
        "note": f"Sanitized shapes of the Claude Code {version} SessionStart transcript records that the receipt adapter {ADAPTER} reads (#1916), "
                "measured on darwin/arm64 by tests/fenced-lock/macos-d-pty-probe.py --prepare-candidate. Placeholders in <angle brackets> are "
                "filled by the test harness; no captured ids, paths or tokens.",
        "hookSuccess": {**base(success), "attachment": {"type": a["type"], "hookEvent": a["hookEvent"], "hookName": "SessionStart:<source>",
                                                         "exitCode": "<exitCode>", "command": a["command"], "stdout": "<stdout>"}},
        "additionalContext": {**base(context), "attachment": {"type": c["type"], "hookName": c["hookName"], "hookEvent": c["hookEvent"],
                                                               "content": ["<content>"], "toolUseID": "<toolUseID>"}},
        "mergedContext": {**literal(context), "attachment": {**literal(c), "content": ["Codex Companion session context refreshed.", "Another hook's context."]}},
    }


def publish_candidate(repo, manifest_bytes, candidate, head, shapes, evidence):
    """Completes the candidate entry and writes the fixtures, the evidence and
    the manifest (read at the start of the run, plus the candidate) to the
    checkout. Returns the written paths."""
    manifest = json.loads(manifest_bytes)
    manifest["entries"].append(candidate)
    digest = lambda text: hashlib.sha256(text.encode()).hexdigest()
    candidate.update({"evidenceCommit": head, "evidenceSummarySha256": digest(evidence), "fixturesSha256": digest(shapes)})
    hexes = {"evidenceCommit": 40, "binarySha256": 64, "evidenceSummarySha256": 64, "fixturesSha256": 64}
    for key, size in hexes.items():
        value = candidate[key]
        assert len(value) == size and all(ch in "0123456789abcdef" for ch in value) and value.strip("0"), f"candidate {key} is not a real {size}-hex value"
    writes = [(candidate["fixtures"], shapes), (candidate["evidenceSummary"], evidence), (MANIFEST_REL, json.dumps(manifest, indent=2) + "\n")]
    staged, placed = [], []
    try:
        for rel, text in writes:
            target = os.path.join(repo, rel)
            temp = f"{target}.candidate-{os.getpid()}"
            with open(temp, "x") as f:
                f.write(text)
            staged.append((temp, target, os.path.exists(target) and open(target).read()))
        for temp, target, before in staged:
            os.replace(temp, target)
            placed.append((target, before))
    except BaseException:
        # Back to the committed checkout: new files go, the manifest
        # gets its committed bytes back.
        for target, before in placed:
            if before is False:
                os.remove(target)
            else:
                with open(target, "w") as f:
                    f.write(before)
        for temp, _, _ in staged:
            if os.path.exists(temp):
                os.remove(temp)
        raise
    return [rel for rel, _ in writes]


def sanitized(summary):
    """The summary with the fixture root and the home directory as placeholders."""
    text = json.dumps(summary)
    for path, label in ((summary["root"], "<fixture>"), (os.path.realpath(os.path.expanduser("~")), "<home>"), (os.path.expanduser("~"), "<home>")):
        text = text.replace(path, label)
    return json.loads(text)


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
  // Completion faults, only on SessionStart and only when the controller names
  // one: after the hook wrote its token, exit one, SIGKILL itself, or deliver
  // only the first half of that stdout and exit zero.
  let fault = null;
  try { fault = event === "SessionStart" ? fs.readFileSync(`${root}/fault`, "utf8").trim() || null : null; } catch {}
  if (fault) log({ kind: "fault", at: Date.now(), fault });
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    let t = null; try { t = JSON.parse(String(chunk)).codexStateLockAdmission; } catch {}
    if (t) token = t;
    if (t && fault === "partial") { const text = String(chunk); return write(text.slice(0, Math.floor(text.length / 2)), () => process.exit(0)); }
    if (t && fault === "exit-one") return write(chunk, () => process.exit(1));
    if (t && fault === "killed") return write(chunk, () => { log({ kind: "hook-killed", at: Date.now(), attemptId: t.attemptId ?? null }); process.kill(process.pid, "SIGKILL"); });
    return write(chunk, ...rest);
  };
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
fs.writeFileSync(`${root}/probe-${Date.now()}.json`, JSON.stringify({ at: Date.now(), acquired, wrote, error, envelopeVersion: envelope?.version ?? null, capabilitySha: sha(envelope?.capabilityId), sessionSha: sha(process.env.CLAUDE_CODE_SESSION_ID), transcriptPath: process.env.CODEX_COMPANION_TRANSCRIPT_PATH ?? null }));
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
        # First raw success receipt and context record, for --prepare-candidate.
        self.raw = {}

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
                    if r.get("type") == "attachment" and a.get("type") == "hook_additional_context" and a.get("hookEvent") == "SessionStart":
                        self.raw.setdefault("additionalContext", r)
                    if a.get("command") != COMMAND:
                        continue
                    try:
                        token, parsed = (json.loads(a.get("stdout") or "{}") or {}).get("codexStateLockAdmission") or {}, True
                    except ValueError:
                        token, parsed = {}, False
                    key = token.get("attemptId") or f"untokened-{len(self.seen)}"
                    if token and a.get("type") == "hook_success" and a.get("exitCode") == 0:
                        self.raw.setdefault("hookSuccess", r)
                    self.seen.setdefault(key, {"seenAt": now, "type": a.get("type"), "exitCode": a.get("exitCode"), "hookName": a.get("hookName"), "durationMs": a.get("durationMs"), "version": r.get("version"), "source": token.get("source"),
                                               "stdoutParsed": parsed, "stdoutHasToken": bool(token), "fieldTypes": {k: type(v).__name__ for k, v in a.items() if k in ("type", "hookEvent", "hookName", "exitCode", "command", "stdout")},
                                               "recordFields": {k: type(r.get(k)).__name__ for k in ("type", "version", "sessionId", "cwd", "isSidechain")}})
                except ValueError:
                    pass
            time.sleep(0.002)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--claude", default=shutil.which("claude") or "claude")
    ap.add_argument("--expect-version", required=True)
    ap.add_argument("--prepare-candidate", action="store_true")
    ap.add_argument("--auto-window", type=int, default=20000)
    ap.add_argument("--max-fills", type=int, default=60)
    ap.add_argument("--auto-minutes", type=float, default=25)
    args = ap.parse_args()
    expected = args.expect_version

    assert sys.platform == "darwin", "native macOS only"
    assert platform.machine() == "arm64", "the receipt manifest proves darwin/arm64 only"
    version = subprocess.run([args.claude, "--version"], capture_output=True, text=True).stdout.strip()
    assert version.split(" ")[0] == expected, f"Claude Code {expected} required, found {version!r}"
    claude_bin = os.path.realpath(shutil.which(args.claude) or args.claude)
    # The product admits only manifest versions, so the entry under test must
    # be in this checkout; its binary hash must be the measured binary.
    manifest_path = os.path.join(REPO, MANIFEST_REL)
    with open(manifest_path, "rb") as f:
        manifest_bytes = f.read()
    manifest = json.loads(manifest_bytes)
    listed = lambda m: [e for e in m["entries"] if (e["version"], e["platform"], e["arch"]) == (expected, "darwin", "arm64")]
    candidate = None
    if args.prepare_candidate:
        assert not listed(manifest), f"{expected} is already listed; --prepare-candidate is for a version without an entry"
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "plugins/codex", os.path.relpath(__file__, REPO)], cwd=REPO, capture_output=True, text=True, check=True).stdout
        assert not dirty.strip(), "commit plugins/codex and this harness first: evidenceCommit must hold the exact bytes of the run"
        # Placeholders until the run is green; validated like any entry.
        candidate = {"provider": "claude-code", "version": expected, "platform": "darwin", "arch": "arm64", "receiptAdapter": ADAPTER,
                     "binarySha256": file_sha(claude_bin), "evidenceCommit": "0" * 40, "evidenceSummary": candidate_paths(expected)["evidenceSummary"],
                     "evidenceSummarySha256": "0" * 64, "fixtures": candidate_paths(expected)["fixtures"], "fixturesSha256": "0" * 64}
        # Only the run's own copy of the plugin gets the candidate (below);
        # the checkout is written only after a fully green run.
        manifest["entries"].append(candidate)
    entry = listed(manifest)
    assert len(entry) == 1, f"provider-receipts.json needs exactly one darwin/arm64 entry for {expected}"
    assert entry[0]["binarySha256"] == file_sha(claude_bin), "manifest binarySha256 is not the measured Claude binary"

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
    if candidate is not None:
        copy = os.path.join(plugin, MANIFEST_REL[len("plugins/codex/"):])
        with open(copy, "w") as f:
            f.write(json.dumps(manifest, indent=2) + "\n")
        source_hashes[MANIFEST_REL] = file_sha(copy)
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
    for name, line, what in (("d-probe", f"{shlex.quote(node)} {shlex.quote(probe)}", "the D admission probe"), ("d-worker", f"{shlex.quote(node)} {shlex.quote(worker)}", "the D background worker"), ("d-fill", f"cat {shlex.quote(filler)}", "the filler output")):
        open(os.path.join(commands, f"{name}.md"), "w").write(f"---\ndescription: {what}\nallowed-tools: Bash(node:*), Bash(cat:*)\n---\nRun exactly this Bash command once, then say only OK. Do not run other commands.\n\n```bash\n{line}\n```\n")
    settings = os.path.join(root, "settings.json")
    # Bash sandbox off: Claude gives plugin hooks CLAUDE_PLUGIN_DATA under
    # ~/.claude/plugins/data/<plugin>, outside the sandbox's write area, so a
    # sandboxed Bash state write fails with EPERM on mkdir. That predates D
    # (state-directory resolution and the hook's export are unchanged since
    # 258047f; the old harness hid it by redirecting CLAUDE_PLUGIN_DATA in its
    # preload) and is a separate #1916 todo. This probe measures D, not that.
    # A second SessionStart hook that gives context, as every real profile
    # has: Claude merges all hook context into one record (#1916), which the
    # receipt check must see through. It is not the product's hook.
    other_hook = node_file("other-context-hook.mjs", 'process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: "Another hook\'s context."}}) + "\\n");\n')
    json.dump({"sandbox": {"enabled": False}, "enabledPlugins": {}, "permissions": {"allow": ["Bash(node:*)", "Bash(cat:*)"]},
               "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": f"{shlex.quote(node)} {shlex.quote(other_hook)}"}]}]}}, open(settings, "w"))

    # CLAUDE_CODE_CHILD_SESSION (set when this runs inside another Claude
    # session) makes the interactive Claude write no transcript at all
    # (bisected on the Mac over 51 variables), so no receipt could exist.
    env = {k: v for k, v in os.environ.items() if not (k.startswith("CODEX_COMPANION_") or k in ("CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "NODE_OPTIONS"))}
    env.update({"TERM": "xterm-256color", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "D_PROBE_ROOT": root, "CLAUDE_PLUGIN_DATA": os.path.join(root, "data"),
                "NODE_OPTIONS": f"--import=file://{bootstrap}", "CLAUDE_CODE_AUTO_COMPACT_WINDOW": str(args.auto_window)})
    argv = [args.claude, "--plugin-dir", plugin, "--setting-sources", "", "--settings", settings, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "Bash"]

    summary = {"root": root, "claudeVersion": version, "claudeBinarySha256": file_sha(claude_bin), "arch": platform.machine(), "repoHead": subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip(),
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

    def relaunch(extra, name):
        """Stop nothing: the previous owned Claude has exited. Start the next."""
        nonlocal term, trusted
        assert term.exited(), "previous Claude still running"
        trusted = False
        term = Pty(argv + extra, root, env, os.path.join(root, f"pty-{name}.log"))

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

    # One watch per transcript: /clear and every relaunch start a new one.
    watches = {}

    def watch_for(path):
        if path not in watches:
            watches[path] = TranscriptWatch(path)
            watches[path].start()
            summary.setdefault("transcriptPathShas", []).append(sha(path))
        return watches[path]

    def receipt_latency(start_exit, latency=True):
        path = start_exit.get("transcriptPath")
        if not path:
            raise RuntimeError("SessionStart exported no transcript path")
        watch = watch_for(path)
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
        p = dict(probes()[-1])
        transcript = p.pop("transcriptPath", None)
        p["transcriptPathSha"] = sha(transcript)
        if transcript:
            watch_for(transcript)
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

        # /clear: End of the old session, then SessionStart(clear) with a new
        # session and a new capability. Like startup, the new transcript (and
        # so its receipt line) exists only with the first turn.
        t_clear = time.time() * 1000
        term.send("/clear\r")
        clear_exit = wait(lambda: session_start("clear", t_clear), "clear SessionStart", 120)
        p4 = run_probe("after clear")
        clear = receipt_latency(clear_exit, latency=False)
        summary["phases"].append({"phase": "clear", "sessionStart": clear})
        clear_end = [e for e in events("hook-exit", "SessionEnd") if t_clear < e["at"] <= p4["at"]]

        def leave(label):
            term.send("/exit\r")
            wait(lambda: term.exited(), f"{label} exit", 60)

        leave("after clear")

        # Resume of the cleared session in a new owned Claude process.
        t_resume = time.time() * 1000
        relaunch(["--resume", clear_exit["sessionId"]], "resume")
        resume_exit = wait(lambda: session_start("resume", t_resume), "resume SessionStart", 120)
        p5 = run_probe("after resume")
        resume = receipt_latency(resume_exit, latency=False)
        summary["phases"].append({"phase": "resume", "sessionStart": resume})
        leave("after resume")

        # Completion faults, each in its own fresh startup: the fixed hook has
        # written its token to stdout, then exits one, is killed, or delivered
        # only half of it. Claude may still label these hook_success; the
        # product must refuse on the recorded receipt itself.
        # Stop/End before this point belong to the proven sessions; those in
        # fault sessions run without a proven receipt and are observed only.
        t_faults = time.time() * 1000
        faults, fault_paths = {}, set()
        for fault in ("exit-one", "killed", "partial"):
            open(os.path.join(root, "fault"), "w").write(fault)
            t_fault = time.time() * 1000
            relaunch([], fault)
            done_kind = "hook-killed" if fault == "killed" else "hook-exit"
            wait(lambda: any(e["at"] > t_fault for e in events(done_kind, "SessionStart")), f"{fault} SessionStart", 120)
            os.unlink(os.path.join(root, "fault"))
            pf = run_probe(f"fault {fault}")
            transcript = next((p.get("transcriptPath") for p in reversed(probes()) if p["at"] == pf["at"]), None)
            rows = []
            if transcript:
                fault_paths.add(transcript)
                watch = watch_for(transcript)
                wait(lambda: watch.seen, f"{fault} receipt line", 30)
                rows = [{k: v for k, v in row.items() if k in ("type", "exitCode", "hookName", "version", "stdoutParsed", "stdoutHasToken")} for row in watch.seen.values()]
            faults[fault] = {"probe": pf, "recordedReceipts": rows}
            summary["phases"].append({"phase": f"fault {fault}", "probe": pf, "recordedReceipts": rows})
            persist()
            leave(f"fault {fault}")
        summary["faults"] = faults

        # Proof never in model input: every transcript line that names one of
        # our capability or attempt ids is the fixed hook's raw receipt record.
        ids = {e[k] for e in events() for k in ("attemptId", "capabilityId") if e.get(k)}
        leaks = 0
        for path in watches:
            for r in read_jsonl(path):
                text = json.dumps(r)
                if any(i in text for i in ids) and (r.get("attachment") or {}).get("command") != COMMAND:
                    leaks += 1
        summary["proofLeaks"] = leaks

        def merged_context_seen():
            # Each proven session's transcript has a context record that merges
            # our line with the other hook's line, the case the receipt check
            # must see through. On resume Claude keeps only context that is not
            # already in the transcript (the other hook's fixed line drops out),
            # so not every record has both; the lengths are kept as observation.
            per_transcript = []
            for path in watches:
                if path in fault_paths:
                    continue
                contents = [a.get("content") or [] for r in read_jsonl(path) for a in [r.get("attachment") or {}]
                            if r.get("type") == "attachment" and a.get("type") == "hook_additional_context" and a.get("hookEvent") == "SessionStart"]
                both = [c for c in contents if any(str(x).startswith("Codex Companion session context refreshed") for x in c) and "Another hook's context." in c]
                per_transcript.append({"transcriptSha": sha(path), "contextLengths": [len(c) for c in contents], "mergedOursAndOther": len(both)})
            summary["contextRecordLengths"] = per_transcript
            return bool(per_transcript) and all(t["mergedOursAndOther"] > 0 for t in per_transcript)

        stops = [e for e in events("hook-exit", "Stop") if e["at"] < t_faults]
        ends = [e for e in events("hook-exit", "SessionEnd") if e["at"] < t_faults]
        summary["faultSessionHooks"] = [{"event": e["event"], "code": e.get("code")} for e in events("hook-exit") if e["at"] >= t_faults and e["event"] != "SessionStart"]
        caps = {p1.get("capabilitySha"), p2.get("capabilitySha"), p3.get("capabilitySha")}
        positive = [s for s in (startup, manual, auto, clear, resume) if s]
        rows = [row for w in watches.values() for row in w.seen.values()]
        positive_rows = [row for path, w in watches.items() if path not in fault_paths for row in w.seen.values() if row.get("stdoutHasToken")]
        want_fields = {"type": "str", "hookEvent": "str", "hookName": "str", "exitCode": "int", "command": "str", "stdout": "str"}
        want_record = {"type": "str", "version": "str", "sessionId": "str", "cwd": "str", "isSidechain": "bool"}
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
            "sessionEndSucceeded": bool(ends) and all(e.get("code") == 0 for e in ends),
            "clearEndedOldSession": bool(clear_end) and all(e.get("code") == 0 for e in clear_end),
            "bashAfterClearAdmitted": p4["acquired"] and p4["wrote"],
            "clearNewCapability": clear["receiptExitCode"] == 0 and p4.get("capabilitySha") not in caps,
            "bashAfterResumeAdmitted": p5["acquired"] and p5["wrote"],
            "resumeNewCapability": resume["receiptExitCode"] == 0 and p5.get("capabilitySha") not in caps | {p4.get("capabilitySha")},
            "exitOneRefused": not faults["exit-one"]["probe"]["wrote"],
            "killedRefused": not faults["killed"]["probe"]["wrote"],
            "partialRefused": not faults["partial"]["probe"]["wrote"],
            "faultReceiptsRecorded": all(f["recordedReceipts"] for f in faults.values()),
            "receiptVersionProven": bool(rows) and all(row.get("version") == expected for row in rows),
            "receiptFieldsPresent": all(s["receiptType"] == "hook_success" for s in positive) and
                bool(positive_rows) and all(row["fieldTypes"] == want_fields and row["recordFields"] == want_record for row in positive_rows),
            "noProofInModelInput": leaks == 0,
            "contextMergedWithOtherHook": merged_context_seen(),
        }
        summary["latencyMs"] = {label: s["latencyHookExitToReceiptMs"] for label, s in (("manual compact", manual), ("auto compact", auto)) if s}
        summary["passed"] = all(summary["checks"].values())
    except Exception as error:  # noqa: BLE001 - every failure lands in the summary
        summary["passed"] = False
        summary["failure"] = str(error)
    finally:
        for w in watches.values():
            w.running = False
        term.stop()
        summary["ownClaudeStopped"] = term.exited()
        persist()
        if candidate is not None and summary.get("passed"):
            # Green: the checkout gets the measured shapes, the sanitized
            # evidence and the completed entry, all built before any write.
            # A red or aborted run never touched the checkout.
            try:
                startup_watch = watches.get(start.get("transcriptPath"))
                shapes = json.dumps(record_shapes(startup_watch.raw if startup_watch else {}, expected), indent=2) + "\n"
                evidence = json.dumps({"ticket": 1916, "kind": "native-provider-receipt-proof", "provider": "claude-code", "version": expected, "platform": "darwin", "arch": "arm64",
                            "receiptAdapter": ADAPTER, "evidenceCommit": summary["repoHead"],
                            "note": "Written by macos-d-pty-probe.py --prepare-candidate. Product and harness are the bytes of evidenceCommit plus the candidate "
                                    "manifest entry in the run's plugin copy, which differs from the committed one only in evidenceCommit, evidenceSummarySha256 "
                                    "and fixturesSha256 (placeholders during the run). Paths are <fixture> and <home>; ids are hashes only.",
                            "candidateManifestSha256": summary["sourceHashes"].get(MANIFEST_REL), "summary": sanitized(summary)}, indent=1) + "\n"
                summary["candidateWritten"] = publish_candidate(REPO, manifest_bytes, candidate, summary["repoHead"], shapes, evidence)
            except Exception as error:  # noqa: BLE001 - green run, candidate not written
                summary["passed"] = False
                summary["failure"] = f"candidate not written: {error}"
            persist()
        print(json.dumps({"summary": os.path.join(root, "summary.json"), "passed": summary.get("passed"), "latencyMs": summary.get("latencyMs"), "failure": summary.get("failure"), "failedChecks": [k for k, v in summary.get("checks", {}).items() if not v],
                          "candidateWritten": summary.get("candidateWritten")}))
    sys.exit(0 if summary.get("passed") else 1)


if __name__ == "__main__":
    main()
