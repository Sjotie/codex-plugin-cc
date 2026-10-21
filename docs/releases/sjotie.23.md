# sjotie.23 candidate — review required

**Tier H:** process identity, mutual exclusion and job artifact integrity.
No plugin-main landing, publication, tag or installation update is authorized.

## Provenance and admission

- Previous plugin candidate: `636f0c9e8c7709a6ac5faf0ae13633e0b03e8a85`.
- Source: factory-core `95a1778c270d2435a390709bd0d64d494f572af4`.
- Module SHA256: `c4668fbf161003e6a1d5ca39e90f0123ab87a88054f4cfb2246d542b88f68f28`.
- Unchanged marker SHA256: `a6c51a60de872adb0f219ae08c64703e05262792b5080e329fafd6b7edbe8470`.
- O2 `.22` source: `81333c0`; fixture state SHA256
  `b52c238b5a9bda7dc4ab21129286df05b7f1513035c4e3fceaf211b0adbcf8c5`.

The real SessionStart hook prepares the session workspace under A, publishes
F before scanning, preserves unsealed S0 until its old identities are gone or
positively prove the new protocol, and exports a certificate only after seal.
It never adopts a legacy file or stops old writers automatically.

macOS writers consume that certificate only: session, canonical root, F/A
identity and sealed-record hash must match on every acquire. Missing evidence,
hook error/crash, different root/session, replaced F/A and missing/changed
records refuse writes. State directories are created only after admission.
The certificate retains the existing cooperative-process trust model; it is
not authentication against a malicious process able to forge lock files.

The shared `MACOS_SCAN_PROVEN` remains **false**. The proven hook route is
scoped in the plugin; Bash gets no process-scan capability, libproc addon,
generic executor or unsandboxed fallback.

## Verification on this Mac

Darwin 25.5.0 arm64. All test runs use the shared test slot; waits were allowed
to finish. No global slot settings changed.

| Check | Result | Limit |
|---|---|---|
| Core | 48 tests / 130 assertions; nine kernel holder/contender pairs across Bun 1.4.0 and Node 22.22.3/26.7.0 | Admission scanner injected; separate native proof below |
| Core red/green | Old `44338ee8`: 33 failures, two refusals already passing; all eleven guard mutants detected | Individual unknown-domain/inventory/S0 guards also first red |
| Plugin red/green | Old `636f0c9e`: 13 new integration cases fail; malformed-input and pre-admission-directory cases individually red, then green | Deterministic process fixture; final counts recorded on #1916 |
| Metadata/runtime | Module matches source hashes, manifests agree, existing SessionStart export test updated after observed red | No installed plugin changed |
| Native M2 refusal | Actual product SessionStart finds living original O2 writer in S0 after fixture unlinks F; no certificate; actual sandboxed Bash refuses | Own temporary writer and state only |
| Native M2 admission | After owned O2 exit, real hook seals the same F inode; real `/codex:native-probe` acquires and commits `stopReviewGate=true` | End-to-end on Node 26.7.0 |
| Native tamper/root | Missing record, copied/replaced F and different root after valid hook certificate all refuse; state unchanged | Actual file mutations and F-inode checks |
| Native M3 | Hook counts 107–112 root processes (one/two empty argv) and 56–57 other-user processes (readable); no parenthesized argv observed | Counts only; no unrelated argv stored |
| Sandbox witness | All five Bash cases: in-process denied write gets EPERM and ps-call count is zero | No general process-visibility claim from Bash |
| Timeout | An earlier real hook hit the existing 5 s limit at 5018 ms: seal present, no exported certificate, Bash refuses | Availability limitation retained, not called a flake; budget unchanged |
| Focused regression | 91 tests: 74 pass / 17 explicit skips; Node 22 integration 15/15; existing SessionStart runtime 1/1 | Linux-only checks explicitly skipped; no full Linux suite claim |
| Windows | Still explicitly unsupported | Actual Windows loading and W1–W6 unmeasured |

The valid native baseline run against frozen `636f0c9e` is red: original hook
lacks S0/certificate; sandboxed Bash attempts ps twice. An initial API quota
failure before Bash and a fixture isolation error are excluded from product
proof. Claude overrides plugin-data paths for inline plugins, so the harness
binds the real hook to its owned fixture root and uses the normal env-file
export to carry that root into Bash. No installed state is used.

Final native run `fenced-lock-route2-Y1ysUl`: all five scenarios pass; hook
times 1554/656/1153/1067/1517 ms under the production 5000 ms budget. State
SHA256 `e61b8dd8a918fe718e9fa9b3569d5ebc40b2b954b3d78d350385f4bb5d9e87fb`,
hook `15713bcede8d8a05f78c79a3304257c84713787c0cc61939e6df2ea85589293a`.

## Reproduce and inspect

Prefix each command with the machine's `test-slot.ts run --` wrapper:

```sh
node --test tests/state-lock-session-start.test.mjs tests/state-lock-unit.test.mjs tests/state-lock-macos.test.mjs tests/commands.test.mjs tests/bump-version.test.mjs
node tests/fenced-lock/macos-live.mjs
FENCED_LOCK_PRODUCT_REF=636f0c9e8c7709a6ac5faf0ae13633e0b03e8a85 node tests/fenced-lock/macos-live.mjs
node scripts/bump-version.mjs --check 1.0.7-sjotie.23
```

An existing authenticated `CLAUDE_CONFIG_DIR` may be selected for the test
process; do not log in or change the default account. The live harness retains
`summary.json`, product source hashes and Claude tool transcripts in its fresh
temp directory. It runs the actual production hook within the timeout read
from product hooks.json, with real unfiltered ps/lsof. Bash uses sandbox
`failIfUnavailable`, no unsandboxed commands and an in-process fs-denial
control. The Bash ps interceptor throws EPERM if the consumer attempts a scan.
Both admitted and refused paths must be observed. Only owned children are
stopped and awaited; the old writer callback is bounded to ten minutes.

## Review boundaries and undo

**Open companion gate:** actual Claude 2.1.301 gives SessionStart env-file
exports to Bash, but not to Stop or SessionEnd. Therefore the present consumer
refuses SessionEnd state cleanup and the enabled Stop-review task's state
writes. This candidate is functionally incomplete and must not be landed or
sent for the final cross-family review until safe certificate transport and
invalidation are proven. A blind seal fallback is forbidden. The native
positive transport control was the exported session ID (present in Bash,
absent in both later hooks); no positive certificate inheritance is claimed.

Cross-family review follows on the exact candidate branches before pushing.
The shared source is a local reviewed candidate, not a claim of core landing.
No Windows, network-filesystem or Linux-namespace validation is inferred from
Mac results; Node 22 integration/kernel checks do not prove native Claude
hook/Bash under Node 22. M1/P7/P8 baseline observations remain available in
prior commits; M1 was rerun in focused checks.

macOS consumers refuse mutating maintenance (`seal`, `adopt-legacy`,
`stop-old`, `unfence`). Legacy recovery and rollback maintenance require a
separately reviewed operator procedure; this patch provides no sandbox bypass.
A hook timeout or absent hook can leave state unavailable until a later
successful SessionStart. That behavior must be accepted in review.

Undo this unpublished delta by reverting its scoped commits. Before a future
live rollback, review drain and recovery on the relevant platform. Never
remove the authority database or fence to bypass a refusal.
