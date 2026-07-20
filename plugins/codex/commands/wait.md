---
description: Block until a Codex job reaches a terminal status and print its stored result
argument-hint: '<job-id> [--timeout <seconds>|--timeout-ms <ms>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait "$ARGUMENTS"`

Present the full command output without summarizing it.

The command reads the per-job JSON and returns only when its status is `completed`, `failed`, `error`, or `cancelled`. `queued`, `running`, and a brief missing-registration window are waiting states. Absence from a `running` list is never completion evidence.
