# sjotie.23 candidate — native blocker remains

**Tier H:** process identity, mutual exclusion and job artifact integrity.
The whole candidate is **not landable and not ready for final cross-family
review**. Actual interactive compact has a fresh-Bash refusal; no alternate
Bash admission route is supplied. No push, plugin-main landing, publication,
tag, deployment or installation update is authorized.

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
| Actual compact | Same SID, new generation, current exit-zero receipt 333 ms; Stop 3→4; old capability refuses with unchanged state | Fresh Bash refuses despite current receipt: functional blocker, cause unproven; exact Bash envelope not recorded |
| Actual clear | End reason clear for old SID; new SID/current receipt 142 ms; Bash acquires, Stop 4→5. Later readonly state: old SID pending/no admission, earlier queued job cancelled | Full replay incomplete after compact produced no capability capture/job; final `/exit` observation timed out; only owned child stopped/awaited, no retained PID |
| Hook timeout | Final startup/resume 1156/271 ms under unchanged 5000 ms; interactive resume 571 ms | Earlier genuine 5018 ms timeout safely refused; availability limitation retained |
| Earlier M1/M2/M3 | First route2 source `95a1778c` / `c4668fbf`: native marker, old owned O2 blocks; after exit same F seals; missing record/replaced F/other root refuse; root/other-user inventory sampled | Historical five-scenario proof pinned to that source; not relabeled final-source proof |
| Windows | Explicitly unsupported | Native loading/W1–W6 unmeasured |

The fresh neutral additional-context timestamp is visible in measured model
input; the generation token is absent. Raw completion metadata carries the
token. Suppressed custom-only JSON and static-context probes failed to retain
the current resume receipt. Their cause is unknown. There is no blind seal,
cache or process fallback.

## Evidence files

The retained session temp root is:
`/private/var/tmp/0o63ecs/s/1e0c7e2c2af59990-mvi4opz9ce422e/`.
These files are local evidence, not permanent release assets:

- `fenced-lock-companion-1la5OW/summary.json`: final startup/resume, hashes/timings.
- `fenced-lock-companion-1la5OW/actions-summary.json`: genuine PTY compact/clear, red; cleanup.
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
node tests/fenced-lock/macos-companion-live.mjs
node tests/fenced-lock/macos-companion-actions.mjs <owned-native-summary-root>
node scripts/bump-version.mjs --check 1.0.7-sjotie.23
```

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
