# Session certificate transport — verification gate

Ticket #1916. Tier H: process identity and state integrity. This work is local
to the candidate branches. Backup pushes to those branches are authorized;
landing, tags, publication and installed-plugin updates remain unauthorized. Native startup/resume is proven for the generation design; actual compact revealed the blocker below, which design D addresses. D's native proof is still open.

## Contract

Design D (built 21-10-2026, [design and build notes](sjotie.23-compact-d-design.md))
replaces the generation. The same SQLite authority A stores, per Claude
session ID, a capability C (stable id, issuing source, base certificate), the
current SessionStart attempt T (pending, ready or revoked) and, while T is
pending, the ready predecessor as candidate. SessionStart commits a new
pending T before parsing stdin or writing the environment file when that SID
already has a locator; this stops C at once. Startup, resume and clear then
prove and seal through the existing route and issue a new C, which ends the
old C for good. Compact takes no new proof: it keeps the candidate C after
validating the unchanged base certificate and the predecessor's receipt
under A. A compact without such a predecessor refuses. Finish
compare-and-sets exactly its own pending attempt to ready. It does not rescan.

Ready alone grants nothing. Every macOS acquire also checks C, the current
ready attempt, canonical root, A/F identities, sealed record/hash, locator
binding and the provider's successful SessionStart receipt for the current
attempt. The provider must have observed numeric exit code zero for the exact
fixed SessionStart command. Claude 2.1.301 can label an exit-one or killed hook
`hook_success`, so the attachment type is insufficient. Its raw stdout must
contain the current attempt id, capability id, session ID, root and source. A
later failed or malformed receipt for this command refuses; known other hook
commands cannot shadow this hook's receipt. An unidentified command remains
unknown. No receipt is cached. A version, platform or architecture not listed
in `provider-receipts.json` refuses. The capability id is unpredictable but
not a secret; the threat model below is unchanged.

The locator is immutable runtime metadata under
`<Claude config>/codex-companion-session-admission/<sha256-session-id>.json`.
Its file identity, nonce, config root, workspace, state root and transcript
path bind the epoch in A. It is lookup/deny evidence, not another authority.
Its location is independent of `CLAUDE_PLUGIN_DATA`, so changing that data
root for the same SID stops the original capability and refuses rebinding.
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
| Interactive compact | Latest observation: Bash retains g0/resume and full-envelope hash while same ENVfile, managed receipt and actual A-row contain g1/compact; Stop 6→7, current g1 control works in same sandbox | Exact first refusal: row.generation differs from consumer.generation. Functional blocker; internal provider delivery/cache step unknown |
| Interactive clear | Current g1 capture is available and positively consumed before clear. Actual End clear and new-SID SessionStart observed; readonly old row pending/no admission and earlier queued job cancelled | Post-clear Bash rejected by Claude automatic approval as Code from External. No g1 replay after clear; permission unchanged, owned child stopped/awaited |

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
propagation after compact. The [observation-only diagnosis and options](sjotie.23-compact-diagnosis.md)
and its durable JSON prove the stale envelope and exact failed predicate. The
action run remains red; the post-clear replay is approval-blocked. The earlier
launcher-only socket-stdin failure remains separate from product observations.

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
Summary JSON files pin each run's source/harness hashes. The latest actual
PTY controller and its probe/bootstrap/replay hashes match the local observation
controls. The live normal-journey launcher's encrypted-capture setup was syntax
checked; the existing normal 2/2 run remains its earlier pinned evidence. Full paths live on
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
