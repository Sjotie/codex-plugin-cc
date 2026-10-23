# Codex plugin for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:wait`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 22.13 or later** (the state lock uses `node:sqlite`; `/codex:setup` checks it)
- **Windows is not supported by the fenced state lock.** On native Windows
  the plugin refuses state writes: jobs cannot be created or tracked and
  configuration changes cannot be saved. `/codex:setup` reports that the
  state lock is unavailable. This also applies if a Factory Claude session
  loads the plugin; Factory does not make this limitation disappear.

`1.0.7-sjotie.23` keeps the session capability across compact (design D,
[design and build notes](docs/releases/sjotie.23-compact-d-design.md)). The
[release checklist](docs/releases/sjotie.23.md) lists the measured platform
coverage and the follow-ups that remain open.
On macOS, the `SessionStart` hook prepares only the session's workspace. It
publishes the fence under the SQLite authority, scans for old writers, and
exports permission only after the fence is safely sealed. Bash and background
workers consume that permission without running `ps`. It is bound to the
session, state root, fence, authority database and seal record; missing or
changed evidence refuses writes. The shared `MACOS_SCAN_PROVEN` stays `false`:
only this hook route performs process proof. See the release checklist for
native coverage; this candidate is not permission to publish or install it.
On macOS this candidate accepts only the Claude Code versions listed with
their proof in `plugins/codex/scripts/lib/provider-receipts.json` (now
**2.1.301 on darwin/arm64**): another version, platform or process
architecture refuses with `provider version unproven`. Stop and SessionEnd
recover only the current session capability from the same authority, with a
fresh check of Claude's successful SessionStart receipt. A seal alone grants
nothing.

Every SessionStart first starts a new attempt, which stops the session's
capability at once. A successful **compact** keeps that capability: Bash and
workers that still hold the envelope from before compact work again once the
compact attempt is ready and Claude has recorded its receipt. Startup,
resume and clear issue a new capability, which ends the old one for good;
SessionEnd revokes it after persistent cancellation. A Stop or SessionEnd
activation stays bound to the attempt it started under. A worker's final
result goes to its job log first and the final publication waits up to three
minutes (`CODEX_COMPANION_FINAL_PUBLISH_WAIT_MS`) while a SessionStart attempt
is still pending; any other refusal stops it at once. The design and its
limits are in [design D](docs/releases/sjotie.23-compact-d-design.md); the
earlier [compact diagnosis](docs/releases/sjotie.23-compact-diagnosis.md)
records why the generation design failed after compact. **Native release gate
remains open:** D is built and unit-tested on Linux; the native macOS PTY
proof (`tests/fenced-lock/macos-d-pty-probe.py`) has not run yet. See the
[transport evidence](docs/releases/sjotie.23-session-transport.md).

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add openai/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@openai-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

If the shared app-server connection closes during a saved read-only task,
the companion makes one recovery attempt through a fresh direct app-server
and resumes the same thread. It returns an already completed turn from the
saved history when available; otherwise it continues the task with the same
prompt and run settings. Progress reports the reconnection. A second failure
or an active thread writer ends the job with an error. Write tasks are not
automatically replayed after a mid-turn disconnect; use the reported thread
ID to inspect the work and deliberately resume it. The broker log records
unexpected child exits for diagnosis.

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `${CLAUDE_CONFIG_DIR}/projects` (or `~/.claude/projects` when unset). `CLAUDE_CONFIG_DIR`, like `HOME`, is trusted process input: changing it selects the project root. The root and source are both resolved through symlinks; files outside that root are refused, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex:wait`

Blocks until one job reaches a terminal status and then prints its stored result.
It reads the job's own JSON status, so queued or registration-lagged work is not
mistaken for completion merely because it is absent from a running-jobs list.

Examples:

```bash
/codex:wait task-abc123
/codex:wait task-abc123 --timeout 300
```

Terminal statuses are `completed`, `failed`, `error`, and `cancelled`. The
command exits with 0 for completion, 1 for failed/error, 2 for an unknown job,
124 for timeout, and 130 for cancellation.

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is disabled, `Stop` only reads the job index for running-task notices; it needs no SessionStart receipt and does not reconcile or write state. When enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. On macOS this requires the current proven SessionStart receipt before any reconciliation or review; missing or invalid proof refuses the hook. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:wait task-abc123
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## Troubleshooting

### Timed out waiting for state lock

Every plugin process that changes the job index takes the state lock of the
workspace: `state.lock/` (a directory, the fence) and `state.lock.db` (SQLite,
held with `BEGIN EXCLUSIVE`; the kernel releases it when the holder dies, so
there are no stale locks to clean up). A timeout names the reason and the next
command. Every `state-lock` command prints JSON and has its own `--help`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" state-lock status --cwd <workspace>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" state-lock status --all
```

What `status` can report, and what to do:

**macOS:** a missing certificate, failed/interrupted hook, different workspace
or `CLAUDE_PLUGIN_DATA`, replaced fence/database, or missing/changed seal record
refuses admission. Let the old writers end, then start or resume a Claude
session in the intended workspace so its hook can prepare that root again.
The session's original root is fixed: changing workspace or plugin-data root
requires a new Claude session, rather than rebinding the existing session ID.
The per-session locator in the Claude config directory is runtime evidence;
missing, corrupt or replaced evidence also refuses writes. Do not remove it
to bypass a refusal.
There is no unsandboxed retry. Standalone commands without the hook environment
cannot write state. Do not delete the fence or database to work around this.
The macOS consumer also refuses `seal`, `adopt-legacy`, `stop-old` and `unfence`;
its certificate does not grant authority to change the admission protocol.
Legacy-file recovery and rollback maintenance on macOS require a separately
reviewed operator procedure; the automatic hook does not adopt legacy files or
stop processes. The maintenance instructions below apply to Linux.

- **An old `state.lock` file** (left by plugin 1.0.7-sjotie.22 or older). It is
  never removed automatically. Stop or update the old plugin processes, check
  with `state-lock drain-check` (exit 0 = drained), then move it aside with
  `state-lock adopt-legacy --cwd <workspace> --expect-dev … --expect-ino …
  --expect-sha …`, taking the three values from `status`.
- **Unsealed fence, waiting on old processes.** Plugin processes that started
  before the fence and do not prove the new protocol must end first. They end
  on their own; `state-lock stop-old --cwd <workspace>` stops exactly those
  (pid and start time checked before every signal) and then seals.
- **Unsealed fence, waiting on a residue** `state.lock.<digits>` with two
  names (left by a crashed 1.0.7-sjotie.22 process). Removing it by hand is
  always safe.
- **Unsealed fence, domain `nested` or `unknown`** (a sandbox with its own PID
  namespace, or macOS before its landing proof). Check by hand that no old
  plugin process runs in another namespace, then run `state-lock seal
  --declare-cross-namespace "<who, which namespaces, how drained>"`.
- **`foreign`: the record was made in another procfs** (for example by the host
  while you are in a container with its own `/proc`). This namespace cannot see
  those processes, and an unseen process is not a dead one, so nothing here
  seals it on its own. Seal from the host (any state change there, or
  `state-lock stop-old`), or, only when you know the processes of that record
  are gone, `state-lock seal --declare-cross-namespace "<…>"` here.
- **`rescan`**: the record was made elsewhere; the next state change (or
  `state-lock stop-old`) in this namespace scans again.
- **`moved`**: another procfs was mounted on `/proc` while the lock read it
  (a sandbox that mounts its own `/proc`). Nothing was decided on those reads;
  the next state change reads `/proc` again.

To go back to an older plugin version (the older version cannot pass the fence):

1. Install the older plugin version.
2. Wait until `state-lock drain-check`, run with the code of the new version,
   shows `newCount` 0: no process of the new version runs any more. With
   `result` `moved` the scan counts for nothing (`newCount` is null); run it
   again.
3. Run `state-lock unfence --all` with the code of the new version, preferably
   from a checkout of its release commit (Claude Code may remove old cache
   directories). `state.lock.db` stays; nothing else is deleted.

A process of the new version that still runs puts the fence back; that only
blocks the older version again, it never breaks anything.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
