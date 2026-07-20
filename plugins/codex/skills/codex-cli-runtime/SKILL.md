---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, `wait`, or `cancel` separately from `codex:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- An explicit user model or effort always wins; otherwise select per the tiers below.
- Model tiers (pick per task): `--model gpt-5.6-luna --effort medium` for very quick cheap exploration; `--model gpt-5.6-sol --effort medium` as the default for everything else; `--model gpt-5.6-sol --effort high` for large implementation work and complex multi-step tasks.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- Use foreground `task` for short work. For work sent to the detached worker, invoke `task --background --wait`; this arms the runtime's job-JSON wait before the subagent can become idle and returns only after a terminal status.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Codex work in `codex:codex-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, hand-roll polling, fetch results separately, cancel jobs, summarize output, or do any follow-up work of your own.
- Do not promise future monitoring. An idle subagent has no active poll. Only say the result is being awaited while the single blocking Bash call is still running.
- Absence from a `running` array never proves completion: queued and registration-lagged jobs can be absent too. Completion means the job JSON says `completed`, `failed`, `error`, or `cancelled`.
- Return the stdout of the `task` command exactly as-is.
- Preserve stdout even when a failed, errored, or cancelled task gives the command a non-zero exit status. If Codex was never invoked and there is no stdout, return nothing.
