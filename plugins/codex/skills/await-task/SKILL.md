---
name: await-task
description: Enforces reliable terminal-state waiting and result forwarding for Codex background tasks. Use whenever any Claude main session, agent, or subagent starts, accompanies, babysits, monitors, or forwards a background Codex task.
user-invocable: false
---

# Await Codex Task

This is the canonical waiting contract for every Claude session or subagent that accompanies a Codex task. Load and follow `codex:await-task` before starting or babysitting background Codex work.

## Canonical job state

The runtime stores each job at:

`<plugin-data>/state/<workspace-slug>-<workspace-hash>/jobs/<task-id>.json`

- In an installed plugin session, `<plugin-data>` is `CLAUDE_PLUGIN_DATA`, normally `~/.claude/plugins/data/codex-openai-codex`.
- `<workspace-root>` is the repository root resolved from the task `--cwd`; outside Git it is that directory itself.
- `<workspace-slug>` is the workspace basename with characters outside `A-Z`, `a-z`, `0-9`, `.`, `_`, and `-` replaced by `-`, with leading and trailing dashes removed; an empty value becomes `workspace`.
- `<workspace-hash>` is the first 16 hexadecimal characters of the SHA-256 of the canonical real path of the workspace root.
- `<task-id>` already includes the `task-` prefix, so a job such as `task-abc123` is stored as `jobs/task-abc123.json`.

Do not guess this path when `CLAUDE_PLUGIN_DATA` or the canonical workspace root is unavailable. Pass the exact `--cwd` to the companion CLI and let it resolve the job file.

## Terminal-state contract

- Terminal: `completed`, `failed`, `error`, and settled `cancelled`.
- A cancellation is settled only after process termination is confirmed; the runtime waiter handles this distinction.
- Waiting: `queued`, `running`, and an absent job file during the short registration grace period.
- An absent job after the grace period is an explicit error, not an infinite wait.
- Absence from a `running` list is never completion evidence. Queued and newly starting jobs may also be absent from that list.

Use the runtime waiter for completion decisions. A raw `queued` or `running` job-JSON status is not sufficient because its worker may have exited without writing a terminal update; the waiter checks the registered PID during every poll and reconciles a dead worker to `failed`. Never infer completion from a summary list, elapsed time, or silence.

## Required workflow

Prefer one blocking companion invocation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait <task-id> [--timeout <seconds>]
```

When starting detached work and awaiting its result in the same call, use:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --wait --cwd <workspace-root> <task arguments>
```

The CLI polls the job JSON and prints the terminal status plus stored result. Preserve that stdout even when terminal failure or cancellation produces a non-zero exit status.

Claude Code aborts any single `Bash` call after its tool timeout (600s by default). When a blocking wait is cut off that way, the detached worker keeps running and the job state is untouched — this is an interrupted wait, never evidence of task failure. Re-attach with repeated `wait <task-id> --timeout 480` calls (exit code 124 means the job is still running; wait again) until a terminal state is reached. For work expected to exceed the Bash timeout, prefer starting with `task --background` (without `--wait`) followed by such bounded `wait` calls, so no invocation ever hits the timeout.

The `task` process itself must not be placed in Claude Code's `run_in_background` layer. That layer is tied to the forwarding subagent and can terminate when the subagent ends. Detach the worker through `task --background` and let only the waiter remain attached to Claude.

## Background fallback

If the accompanying agent cannot remain synchronously blocked, it must arm a Claude Code Bash task with `run_in_background: true` before ending its turn. Use the companion waiter in the loop so the CLI remains the only implementation of job-state semantics:

```bash
until output="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait "$task_id" --timeout 45 --json)"; do
  exit_code=$?
  case "$exit_code" in
    124) continue ;;
    1|130) printf '%s\n' "$output"; exit "$exit_code" ;;
    *) exit "$exit_code" ;;
  esac
done
printf '%s\n' "$output"
```

Start that command through `Bash(..., run_in_background: true)` and confirm the background Bash task was accepted before returning. A shell loop typed into prose, scheduled for later, or started after the agent returns does not count.

## Truthfulness rules

- Never claim to be monitoring, polling, babysitting, or forwarding later unless a blocking wait call or accepted background Bash task is currently running.
- Never promise that an idle agent will resume polling by itself.
- Do not report completion until the waiter returns a terminal job-JSON state.
- On timeout, unknown ID, unreadable state, or invocation failure, report that outcome explicitly instead of calling the task complete.
