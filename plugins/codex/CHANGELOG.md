# Changelog

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
