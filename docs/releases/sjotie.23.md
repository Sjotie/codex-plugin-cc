# sjotie.23 — released on the fork (2026-10-21)

**Tier H:** process identity, mutual exclusion and job artifact integrity.

## Status

The native blocker below (a fresh Bash refused after interactive compact) is
solved by design D: a stable session capability C, an attempt T per
SessionStart, and a compact that keeps C only from a proven ready
predecessor. Contract, build notes and tests:
[sjotie.23-compact-d-design.md](sjotie.23-compact-d-design.md).

- Vendored core: factory-core `82f99ab7` (`fenced-lock.source.json`).
- Plugin: `feat/1916-d-compact` up to `e71eb067`, merged into
  `sjotie-integration` and fork `main`.
- Cross-family review: Muse GO on D (`bdfe274`) and on the delta
  `bdfe274..e71eb067`, no P1 or P2.
- Native proof on macOS arm64, Claude Code 2.1.301
  (`tests/fenced-lock/macos-d-pty-probe.py`): 12/12 green, including manual
  and auto compact, a worker publishing over compact, and Stop/End.
- The native proof runs with the Bash sandbox off. Sandboxed Bash cannot
  write plugin state on macOS: Claude gives plugin hooks a
  `CLAUDE_PLUGIN_DATA` outside the sandbox write area. This predates D and is
  open on Homebase #1916.
- Follow-up on #1916: a disabled Stop gate now only reads effective job status and
  needs no receipt; an enabled gate still requires current admission before
  reconciliation/review. Missing admission skips the review and allows Stop,
  with a systemMessage warning; state writes stay refused. Other exit-1 hook
  failures are also non-blocking. Missing transcripts report unproven admission.
  The old harnesses accept only the byte-exact pre-D session-admission blob
  `4155409a29102697cd70263af006c106ca6a97a1` at `258047fb`, refusing all other
  sources (including version declarations inside comments).
  `CLAUDE_CONFIG_DIR` is documented as trusted
  process input, with both project root and source resolved through symlinks
  at check time; later filesystem changes are not covered.
  These follow-ups require review and are not part of the installed .23.
  After the Opus NO-GO on `353e3bf`, local verification on 23-10 used
  `node --test --test-concurrency=4 tests/*.test.mjs` through test-slot and
  test-home: **522 tests, 516 pass, 6 skips, 0 failures** (Node 26.12.1).
  The review regressions first had six failures on `353e3bf`, then all
  **13/13** passed. The committed pre-D fixture is byte-equal to the source
  at `258047fb` (verified with `git hash-object` and `cmp` against `git show`);
  the earlier synthetic v2 declaration was not a real compatibility test.
  The first full run used an overlong temporary socket path (121 bytes;
  a direct bind gave `AF_UNIX path too long`) and was aborted; the isolated
  rerun used a fresh short temporary root. No failures were waived.
  The Stop output follows the [Claude hooks JSON contract](https://code.claude.com/docs/en/hooks#json-output):
  `systemMessage` on exit zero warns without blocking Stop. This local test
  checks emitted JSON, not a new native Claude UI journey. Scanner/platform
  outcomes are injected in transport tests; no new Mac result is claimed.
- Installation (marketplace checkout, cache, `installed_plugins.json`) is a
  separate step.

The sections below describe the earlier generation-based candidate and its
evidence; they are kept as the record of why D was needed.

## Provenance and contract

- Previous pushed plugin candidate: `636f0c9e8c7709a6ac5faf0ae13633e0b03e8a85`.
- Vendored source: factory-core `3982b9947291996586bddf6fe06736c71ed63818`.
- Module SHA256: `e0c4c59fb32f4329b4759e3849849b834a361fe543e0ba97d4b6f61ad9502842`.
- Unchanged marker SHA256: `a6c51a60de872adb0f219ae08c64703e05262792b5080e329fafd6b7edbe8470`.

SessionStart prepares the existing F under A and scans after F. Old S0 must
be positively gone or protocol-proven before seal. Bash consumes only the
exported certificate. The fixed Stop and SessionEnd paths recover that same
certificate from A and revalidate the current provider completion receipt;
a seal or ready row alone grants nothing. Every new SessionStart revokes the
old generation before input parsing/env-file writes. SessionEnd persists
cancellation before teardown and revokes only its original activation.

The immutable per-SID locator binds canonical root, transcript and provider
config to A's generation. Numeric exit zero, exact raw hook command, current
generation/SID/root/source and the measured Claude 2.1.301 receipt shape are
required. Every acquire rereads evidence; no receipt cache. Unknown, crash,
changed/missing locator, F, A or record refuses. Existing-only SQLite opens
never CREATE a replacement authority. See the [transport contract and evidence](sjotie.23-session-transport.md).

The shared `MACOS_SCAN_PROVEN` remains false. Only fixed SessionStart's
preparation call opts into the measured macOS scanner. No libproc addon,
generic executor, unsandboxed retry or second admission authority exists.

## Verification table

Darwin 25.5.0 arm64; Claude 2.1.301, Node 26.7.0. Tests use the machine test
slot, including normal waits; no global settings changed.

| Check | Result | Boundary |
|---|---|---|
| Core | 133 tests / 464 assertions; Bun 1.4.0 and Node 22.22.3/26.7.0; nine kernel holder/contender pairs | Unit process proof injected |
| Core causal controls | 12 base + 14 session + 10 revocation + six existing-open controls detected; new tests first red | Exact source copies, nonzero tests/failures |
| Plugin causal controls | Previous `129692e`: 23 pass / 47 fail of 70; all 25 guard mutants detected | Deterministic parent-completion fixture |
| Plugin regression | 146 tests: 129 pass / 17 explicit platform skips; transport 70/70 also on Node 22; selected existing runtime 1/1; version check green | No full Linux runtime suite or native Node 22 journey claimed |
| Core boundary | 2469 tracked files, no secrets/rises, baseline five unchanged | Static boundary scan |
| Native startup/resume | Both pass: real sandboxed `/codex:native-probe` commits setup/job; enabled Stop completes review jobs 0→1→2; End cancels index/job and expires old certificate | Byte-equal product, exact raw production hook commands; local owned fake Codex for Stop body |
| Sandbox / no rescan | Actual denied write EPERM; Stop/End inherit no proof exports; zero consumer ps/lsof | SessionStart alone scans |
| Managed completion | Startup/resume exit zero grants; exit one and SIGKILL-after-stdout refuse in all three consumers | `hook_success` type alone is insufficient |
| Actual compact | Latest actual observation: same SID/epoch/base cert/A, same ENVfile now contains g1, actual A SELECT ready/g1, Bash still has exact g0/resume envelope; Stop 6→7; g1 control works in same sandbox | First refusal is row.generation !== consumer.generation. No product fix; provider cache/delivery internals unknown |
| Actual clear | Current g1 capture and pre-clear positive control complete; actual End clear/new SID; old row pending/no admission and initial job cancelled | Post-clear Bash refused by Claude automatic approval as Code from External; replay unmeasured. No alternate execution route; own child stopped/awaited |
| Hook timeout | Final startup/resume 1156/271 ms under unchanged 5000 ms; interactive resume 571 ms | Earlier genuine 5018 ms timeout safely refused; availability limitation retained |
| Earlier M1/M2/M3 | First route2 source `95a1778c` / `c4668fbf`: native marker, old owned O2 blocks; after exit same F seals; missing record/replaced F/other root refuse; root/other-user inventory sampled | Historical five-scenario proof pinned to that source; not relabeled final-source proof |
| Windows | Explicitly unsupported | Native loading/W1–W6 unmeasured |

The fresh neutral additional-context timestamp is visible in measured model
input; the generation token is absent. Raw completion metadata carries the
token. Suppressed custom-only JSON and static-context probes failed to retain
the current resume receipt. Their cause is unknown. There is no blind seal,
cache or process fallback.

The [compact diagnosis and design options](sjotie.23-compact-diagnosis.md)
includes a [durable sanitized JSON](sjotie.23-compact-evidence.json), 19/19
local observer controls and the exact cause. Product files remain unchanged.

## Evidence files

The retained session temp root is:
`/private/var/tmp/0o63ecs/s/1e0c7e2c2af59990-mvi4opz9ce422e/`.
These files are local evidence, not permanent release assets:

- `fenced-lock-companion-1la5OW/summary.json`: final startup/resume, hashes/timings.
- `fenced-lock-companion-1la5OW/actions-summary.json`: latest genuine PTY cause observation, red product path; cleanup.
- `fenced-lock-companion-1la5OW/actions-observation-after-clear.json`: approval refusal and readonly footprint; no sandbox replay.
- `fenced-lock-companion-1la5OW/actions-summary.companion-red.json`: earlier partial compact/clear fixture.
- `t1916-observation-controls-oO9Grg/summary.json`: current 19/19 controls.
- `t1916-observation-controls-fWjdAQ/summary.json`: old harness, 1 pass / 2 directed failures.
- `fenced-lock-companion-1la5OW/actions-state-after.json`: readonly clear footprint.
- `fenced-lock-companion-1la5OW/actions-summary.unsupported-stdin.json`: earlier launcher-only socket-stdin failure, zero Claude actions.
- `fenced-lock-companion-KLHg0i/summary.json`: causal previous-candidate companion failure.
- `t1916-timestampreceipt.mialwt/summary.json`: four managed completion controls.
- `t1916-final-plugin-nNxn1z/summary.json`: final focused/runtime/version/Node22 checks.
- `session-transport-controls-UmdUUc/summary.json`: old baseline plus 25 plugin mutants.
- `t1916-final-core-mutants-b5eaknob/summary.json`: final core admission/session/revocation controls.
- `fenced-existing-mutants-3fD6xY/summary.json`: six no-CREATE controls.
- `fenced-lock-route2-Y1ysUl/summary.json`: earlier five-scenario route2 proof.

## Reproduce and undo

Prefix test commands with the machine's `test-slot.ts run --`:

```sh
node --test tests/state-lock-session-start.test.mjs tests/state-lock-unit.test.mjs tests/state-lock-macos.test.mjs tests/commands.test.mjs tests/bump-version.test.mjs
node tests/fenced-lock/session-transport-mutations.mjs
uv run python tests/fenced-lock/macos-d-pty-probe.py   # native macOS, wire v3 (design D)
node scripts/bump-version.mjs --check 1.0.7-sjotie.23
```

The older `macos-companion-*` harnesses belong to the generation transport
(wire v2) and refuse to run on wire v3 (`tests/fenced-lock/wire-v2-only.mjs`).
They remain the record of the pre-D evidence: run them only against
`FENCED_LOCK_PRODUCT_REF=258047fbc24cfb8539897875410282c65ede842b`.

The interactive helper requires a real TTY. Use an existing authenticated
profile only for the test process; no login/default account changes. The
fixture isolates owned state/config, uses actual sandbox `failIfUnavailable`
and `allowUnsandboxedCommands=false`, and never writes product state from its
bootstrap. Stop's local fake Codex proves the review body without an external
Codex account. Only owned children may be stopped and awaited.

Not proven: full native clear replay, functional Bash after compact, native
Windows, network filesystems, Linux PID namespaces on this Mac or native Node
22 Claude-hook/Bash end to end. Cooperative same-user processes are the trust
model; this is not authentication against a malicious same-user file/argv
forger. macOS legacy adopt/stop-old/seal/unfence requires a separately reviewed
operator route. Unknown evidence remains a refusal.

Undo the unpublished delta by reverting its scoped commits. Before any future
live rollback, review drain/recovery. Never remove A, F or locator metadata to
bypass a refusal. Final cross-family review and any publication remain with
the orchestrator after the functional blocker is resolved or scoped explicitly.
