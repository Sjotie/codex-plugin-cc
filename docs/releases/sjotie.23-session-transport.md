# Session certificate transport — verification gate

Ticket #1916. Tier H: process identity and state integrity. This work is local
to the candidate branches. No push, landing, tag, publication or installed
plugin update is authorized. Native startup/resume is proven; actual compact reveals a functional blocker below.

## Contract

The same SQLite authority A stores a pending/ready generation for each Claude
session ID. SessionStart commits pending before parsing stdin or writing the
environment file when that SID already has a locator. Every new start source
(startup, resume, compact, clear) takes this path. A valid new session creates
its locator before beginning its first generation. Preparation uses the
existing fence F and process-proof route; finishing validates that certificate
and compare-and-sets the same pending generation to ready. It does not rescan.

Ready alone grants nothing. Every macOS acquire also checks the current
session generation, canonical root, A/F identities, sealed record/hash,
locator binding and the provider's current successful SessionStart receipt.
The provider must have observed numeric exit code zero for the exact fixed
SessionStart command. Claude 2.1.301 can label an exit-one or killed hook
`hook_success`, so the attachment type is insufficient. Its raw stdout must
contain the current generation, session ID, root and source. A later failed
or malformed receipt for this command refuses; known other hook commands
cannot shadow this hook's receipt. An unidentified command remains unknown.
No receipt is cached. Unknown versions refuse.

The locator is immutable runtime metadata under
`<Claude config>/codex-companion-session-admission/<sha256-session-id>.json`.
Its file identity, nonce, config root, workspace, state root and transcript
path bind the epoch in A. It is lookup/deny evidence, not another authority.
Its location is independent of `CLAUDE_PLUGIN_DATA`, so changing that data
root for the same SID revokes the original generation and refuses rebinding.
Missing, partial, corrupt or copied locator evidence refuses. The hook does
not silently repair it.

Claude can create the transcript and its parent directory after SessionStart.
The hook therefore binds one exact future path through its existing canonical
ancestor; only ENOENT permits that declaration. It creates no transcript.
Consumption requires a real regular file at the bound canonical path and
complete valid JSONL containing the provider receipt.

Only the real paths of `stop-review-gate-hook.mjs` and
`session-lifecycle-hook.mjs SessionEnd` may activate the current certificate
without Bash's env-file export. They recover the validated row from A, then
the normal consumer validates it again for each state write. They cannot
prepare, seal or rescan. SessionEnd aborts teardown if cancellation cannot be
persisted; it does not signal that job's process or continue broker teardown.
After successful cancellation, SessionEnd revokes only its original activation
by compare-and-set under A. A delayed End cannot revoke a newer start. Its
completion requires the same fixed entrypoint and original activation object.
Existing-only SQLite opens never use CREATE; loss of A refuses without
recreating an empty authority. The shared `MACOS_SCAN_PROVEN` stays false. Its scoped proof option occurs
only at SessionStart's actual preparation call.

## Evidence and remaining gates

| Check | Evidence | Boundary |
|---|---|---|
| Core source | `3982b9947291996586bddf6fe06736c71ed63818`, module SHA256 `e0c4c59fb32f4329b4759e3849849b834a361fe543e0ba97d4b6f61ad9502842` | Local candidate, not landed |
| Core tests | 133 pass, 464 assertions, five files; Bun 1.4.0 and Node 22.22.3/26.7.0, nine holder/contender pairs | Process proof injected in unit tests |
| Core causal controls | 12 base-admission, 14 session, 10 revocation and six existing-open controls detected | Each runs nonzero tests and observes failures |
| Plugin integration | 70 transport tests green on Node 26 and Node 22; focused suite 146 tests: 129 pass, 17 explicit skips; selected existing SessionStart runtime 1/1; version check green | Deterministic parent receipt fixture; no full Linux suite claim |
| Plugin causal controls | Frozen pre-transport candidate: 70 tests, 23 pass / 47 fail; 25 directed mutants detected, including cancellation-before-broker-shutdown and original-End activation | Each selected mutant runs at least one test and observes failure |
| Native causal baseline | `fenced-lock-companion-KLHg0i/summary.json`: frozen plugin `129692e` permits real Bash but Stop completes no review and End leaves queued job | Isolates companion gap |
| Native final normal journey | `fenced-lock-companion-1la5OW/summary.json`: startup and same-SID resume pass; actual Stop completed-job counts 0→1→2; actual End persists job/index cancellation and expires old certificate | Exact product scripts and raw production hook commands, Node 26.7.0 / Claude 2.1.301 |
| Sandbox and no rescan | Both real Bash journeys get EPERM on denied write; Stop/End receive no exported proof, all consumers make zero ps/lsof calls | Only SessionStart scans |
| Completion semantics | `t1916-timestampreceipt.mialwt/summary.json`: startup/resume exit zero grants; exit one and SIGKILL after stdout refuse in Bash/Stop/End | Provider labels can say hook_success even on failure; numeric exit zero required |
| Timeout | Final normal hooks 1156/271 ms under unchanged production 5000 ms | Earlier real 5018 ms timeout safely refused; availability boundary retained |
| Interactive compact | Actual source compact, same SID, new generation, exit-zero receipt 333 ms; Stop completes next review and old certificate refuses unchanged | Fresh Bash safely refuses despite that current receipt: **functional blocker**; exact Bash envelope was not captured, so stale export is only a hypothesis |
| Interactive clear | Actual End reason clear on old SID; SessionStart clear uses a new SID, receipt 142 ms, Bash acquires and Stop completes next review. Later readonly state shows old SID pending/no admission and earlier queued job cancelled | Full clear assertion stays incomplete: compact denial produced no captured compact capability/job; replay encounters ENOENT; final exit observation times out, owned child stopped and awaited |

The product emits the observed official `hookSpecificOutput.additionalContext`
format with a fresh neutral context timestamp. Actual model input contains
that timestamp and excludes the generation token. The token stays in raw
completion metadata. A suppressed custom-only output and static-context
probes did not retain the current resume receipt; their failure is retained
as evidence, not hidden by a fallback. The cause is unknown. The parser ignores
only the measured one-string-array `hook_additional_context` record as
noncompletion metadata; it still requires a separate exact successful
completion. Missing, malformed or failed current completion refuses.

The whole plugin remains **not landable and not ready for its final cross-family
review** while the actual compact Bash path is unavailable. No disk lookup,
cache or fallback has been added to Bash. This observed limitation is reported
for an explicit route decision. The fixed Stop/End transport is proven on
startup/resume and Stop after compact; it does not establish fresh Bash env
propagation after compact. Stale environment export is a hypothesis: the observer
did not capture the actual compact Bash envelope. The actual action run is red,
not waived. Its first launcher failure (socket stdin, no Claude child) is kept
separately from the subsequent genuine PTY product observations.

Reproduce deterministic controls through the machine test slot:

```sh
node --test tests/state-lock-session-start.test.mjs
node tests/fenced-lock/session-transport-mutations.mjs
node tests/fenced-lock/macos-companion-live.mjs
```

The native fixture copies the product scripts byte-for-byte and uses the
unchanged raw production hook commands. Its bootstrap isolates data/config,
records metadata and denies consumer ps/lsof; it does not write state. Bash
runs the real setup/job paths, Stop runs the real enabled review task through
an owned local fake Codex, and End must persist real cancellation. An EPERM
write control proves Bash sandboxing. Only owned children are stopped and
awaited. The existing five-second SessionStart timeout stays unchanged.
Summary JSON files pin each run's source/harness hashes. Subsequent observer-only
changes add explicit missing-capture reporting and optional environment binding
metadata; those changes were syntax-checked only, not claimed as a new native
run. Full paths live on
the ticket; raw transcripts and account material are not committed.

## Boundaries and undo

These certificates use the existing cooperative-process trust model, not
authentication against a malicious same-user process that can forge files or
JavaScript argv. No libproc addon, unsandboxed retry, generic executor or
second admission authority is supplied. Windows remains unsupported and
unmeasured; no native Node 22 Claude-hook journey is claimed. Linux namespace
and network-filesystem proof is not inferred from this Mac.

Undo this unpublished transport delta by reverting its scoped commits. Do
not delete F, A or locator files to bypass a refusal. Legacy recovery and
mutating maintenance require a separately reviewed operator route.
