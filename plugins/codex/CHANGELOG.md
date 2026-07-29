# Changelog

## 1.0.7-sjotie.12 (fork)

- rescue agent + runtime skill now strip delegation-mechanics meta-text
  ("use codex:rescue", "invoke the rescue skill", model wishes in prose) from
  the forwarded task text. Leaked meta made Codex report "codex:rescue was
  not callable, so reviewed manually" inside an otherwise healthy Sol run,
  triggering a false silent-substitution alarm (VodafoneZiggo, 2026-07-29)

## 1.0.7-sjotie.11 (fork)

- job files are now written atomically (temp + rename, matching state.json).
  A freshly spawned task worker polls the job file every 25ms while
  `assignJobWorkerPid` rewrites it; catching that half-written window killed
  the worker on JSON.parse before the job ever started, and dead-worker
  reconciliation reported "Process exited without reporting." (observed on a
  VodafoneZiggo review run, 2026-07-29 — the sjotie.9 double-fork widened this
  pre-existing race window)
- `readStoredJob` treats a malformed job file as transient (retry) instead of
  crashing the reading process

## 1.0.7-sjotie.10 (fork)

- await-task: the `run_in_background` fallback is now explicitly main-session
  only. A subagent whose final message is its only transport must stay in a
  synchronous bounded-wait loop until the job is terminal — ending its turn
  with the job still running delivered silence to the caller (reported by the
  mcp-spec session, 2026-07-29)
- rescue agent + await-task: failed/aborted jobs must be reported with job id,
  `threadId`, and the `~/.codex/sessions/.../rollout-*-<threadId>.jsonl`
  transcript path, so callers can recover Codex's partial findings instead of
  concluding the work is lost

## 1.0.7-sjotie.9 (fork)

- `task --background` now double-forks its detached worker through a
  short-lived `task-worker-spawn` launcher, re-parenting the worker to PID 1.
  This stops Claude Code's Bash-timeout tree kill from taking the worker down
  when a `task --background --wait` call outlives the 600s tool timeout
  (previously the job failed with "received SIGTERM before reporting a
  terminal result" while Codex itself was still healthy)
- rescue agent and runtime skills now document the re-attach contract: an
  aborted wait is not a task failure — resume with bounded
  `wait <job-id> --timeout 480` calls until the job is terminal

## 1.0.7-sjotie.8 (fork)

- long-running rescue work now stays in a plugin-owned detached worker instead
  of tying a foreground Codex process to Claude Code's background-subagent
  lifecycle
- tracked jobs synchronously persist a concrete terminal failure when the
  companion process exits early or receives SIGHUP, SIGINT, or SIGTERM; the
  existing dead-worker reconciliation remains the fallback for uncatchable exits
- detached tasks are registered before their worker starts, and malformed worker
  requests are terminalized through the same tracked-job contract
- added regression coverage for normal process exits, SIGTERM, pre-run worker
  failure, plugin-owned background routing, account-default model selection,
  and visible unsupported model fallback

## 1.0.7-sjotie.7 (fork)

- rescue forwarding now leaves model and effort unset unless the user explicitly
  selects them, so resumed threads keep their existing supported model
- explicit model overrides are checked against the active ChatGPT account's
  app-server model catalog; unavailable overrides fall back to the account
  default instead of failing `thread/start`, `thread/resume`, or `turn/start`
- added first-run-versus-resume regression coverage for the unsupported
  `gpt-5.6-codex` override that previously produced an immediate HTTP 400

## 1.0.7-sjotie.6 (fork)

- added the internal `codex:await-task` skill as the canonical waiting contract
  for any main session or subagent accompanying a Codex background task
- rescue/runtime/result guidance now loads that skill instead of duplicating
  job-state, truthful-monitoring, and result-forwarding instructions
- documented the state-path derivation and a pre-armed Claude background wait
  loop while keeping the companion CLI as the only status-state implementation
- made each wait poll reuse the status runtime's worker-liveness reconciliation,
  so a queued or running job with a dead PID fails within one poll interval

## 1.0.7-sjotie.5 (fork)

- added a job-JSON-backed `wait` command with explicit terminal statuses,
  registration grace, timeouts, stored result output, and meaningful exit codes
- background rescue tasks now use `task --background --wait`, so the forwarding
  subagent keeps a real blocking mechanism alive instead of promising later polls
- status/result/resume rendering now uses explicit terminal-state semantics;
  absence from a running-jobs list is never treated as completion

## 1.0.7-sjotie.4 (fork)

- model tiers revised: gpt-5.6-sol medium is now the default (its thoroughness
  is the point), sol high for large implementation work, luna medium stays for
  dirt-cheap quick exploration. Terra dropped from the tiers.

## 1.0.7-sjotie.3 (fork)

- codex-rescue agent now selects the Codex model itself (explicit user choice
  always wins): gpt-5.6-luna medium for very quick cheap exploration,
  gpt-5.6-terra medium as default for exploration and simple work,
  gpt-5.6-sol high for substantial/complex work.

## 1.0.7-sjotie.2 (fork)

- upstream PR #471 commit a6e501a: `task --write` now runs Codex with
  `danger-full-access` (full filesystem + network) instead of
  `workspace-write`, so write tasks can reach localhost services and
  browser tooling. Deliberate opt-in by Sjoerd; read-only default unchanged.

## 1.0.7-sjotie.1 (fork)

Fork of openai/codex-plugin-cc v1.0.6 with reviewed community PRs merged, aimed
at running multiple concurrent Codex tasks across Claude Code sessions:

- upstream PR #475: `task --resume-thread <id>` for explicit thread resume
  (plus id validation adopted from PR #344)
- upstream PR #460: state.json file lock + atomic writes (busy-spin replaced
  with `Atomics.wait` sleep)
- upstream PR #497 (commits f168a47 + 7fc8eff): dead-worker reconciliation
  (running jobs with a dead pid become failed), cancellation persisted before
  kill, `task --cwd` validation
- upstream PR #491: broker preserved across session exits (refcount +
  busy-shutdown rejection + turn completion race = ghost-task fix, idle
  self-reap)
- upstream PR #453: broker terminates when its app-server child exits
  (reapplied on top of #491)
- upstream PR #501: accept MCP elicitation requests
- version-based stale-broker refresh after plugin/codex upgrades (minimal
  reimplementation of that part of PR #471; busy brokers defer the refresh)

Deliberately skipped: #344 (silent env-var sandbox escalation), #492 (collapses
per-worktree isolation), #490/#457 (subsumed by #491), rest of #471.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
