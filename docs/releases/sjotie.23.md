# sjotie.23 candidate — release blocked

**Tier H:** process identity, mutual exclusion and job artifact integrity.
This branch prepares version metadata and evidence. It is not a published
release, a plugin-main landing, or permission to roll out the candidate.

## Provenance

- Plugin base: `7e9677cc0ebcb294ef7e1fb1497c787034860a17`.
- Released old protocols: O1 `c5fc9a5` (.21), O2 `81333c0` (.22).
  Native fixtures verify the original O2 `state.mjs` SHA256
  `b52c238b5a9bda7dc4ab21129286df05b7f1513035c4e3fceaf211b0adbcf8c5`.
- Landed source: factory-core merge
  `2ae84f989d3f3c61b622103aa7e9a20b21100158`, containing `6160e7d06`.
- Module SHA256: `a60dedc470fc7636a6b4cf117d94186cf32a084dcf8dc536aeae5fb82c9c0c91`.
- Marker SHA256: `a6c51a60de872adb0f219ae08c64703e05262792b5080e329fafd6b7edbe8470`.
  Both files match the landed source byte for byte; this delta changes neither.

## Native Mac observations, 21 October 2026

Darwin 25.5.0 arm64; Bun 1.4.0, Node 22.22.3 and Node 26.7.0.
All runs use the machine-wide test-slot wrapper. Its memory/slot waits were
allowed to finish; no global slot settings were changed.

| Check | Observed result | Limit |
|---|---|---|
| Core P1/P2/P4/P5 | 13/13 tests, 55 assertions; all nine Bun/Node 22/Node 26 holder/contender pairs get BUSY, then acquire after the owned holder is SIGKILLed; same-process diagnostic preserves its lock | Scanner is injected in this kernel-lock suite |
| P7 | Original O1/O2 against a directory fence: all four Node 22/26 runs time out, never enter their callback, and preserve the fence inode | Acquire path only; no full old-release race matrix |
| P8 | Both Nodes: rename to empty path succeeds; over file ENOTDIR, over nonempty directory ENOTEMPTY; unlink directory EPERM, read directory EISDIR | Own fixture directories on the local filesystem |
| M1 | Native marker is `new` before and after unlink; `lsof -Fn` retains the original pathname without a deleted suffix | Ordinary shell, own child |
| M2 shell precondition | Original O2 code is paused inside `updateState`, its F is removed by the fixture, new fence records its PID/start in S0 and stays unsealed; after owned-child exit it seals and admits | Ordinary shell; the final admission uses a matcher restricted to that fixture writer, not the full machine scan |
| M2 SessionStart | A real Claude Code SessionStart hook publishes the fence, records the living O2 child in S0, refuses acquire and leaves `sealedAt: null` | Test-only candidate `initial` verdict, actual canary/scanner; no product flag change |
| M2 Bash | A real `/codex:native-probe` command uses Claude's Bash tool with sandbox enabled, failIfUnavailable and no unsandboxed fallback. `ps` fails with `spawnSync ps EPERM`; no S0 record or seal, acquire false | **FAIL: release gate not met** |
| Sandbox witness | Writing the fixture's denied path succeeds from shell/hook, fails from Bash | Confirms that Bash actually ran inside the sandbox |
| M3 shell/hook | Each observed 146 root processes (145 readable argv, one empty) and 73 other-user processes (73 readable); no parenthesized argv in this sample | Counts only; unrelated argv are never stored in the report |
| M3 Bash | `ps` returns EPERM | **FAIL: argument-form classification cannot be proven through this route** |
| Native regressions | Two new tests: 0/2 pass against a module with native scan/marker guards removed, then 2/2 pass on candidate; also 2/2 under Node 22 | Does not replace M2 live proof |
| Focused plugin checks | 76 tests: 59 pass, 17 explicit skips, zero failures; unit, native, command and version tests | Linux namespace/native /proc cases and unavailable pinned Node binary skipped; no full 404-test macOS claim |
| Version consistency | `.23` check fails on `.22` in all six fields, passes after the four manifests are bumped | No publish command executed |
| Windows | Module already refuses on win32; README explicitly says jobs/config cannot be written, including Factory Claude sessions that load it | Actual Windows plugin loading and W1–W6 are **unmeasured** |

The M2/M3 result keeps `MACOS_SCAN_PROVEN=false`. It demonstrates a safe
refusal, not working automatic admission on sandboxed macOS. Do not turn the
flag on based on the successful shell or SessionStart observations. A release
needs a reviewed way to obtain process evidence on the Bash route, then the
remaining native matrix. No sandbox setting was relaxed to get a green result.

## Reproduce

Use the machine's test-slot command before each invocation below. Select an
existing authenticated Claude profile with `CLAUDE_CONFIG_DIR` when needed.
The harness does not inspect or export credentials; the real Claude CLI uses
its existing stored login. No login flow is started.

```sh
node --test tests/state-lock-macos.test.mjs
node tests/fenced-lock/macos-live.mjs
FENCED_LOCK_NODES=<node22-binary> node tests/fenced-lock/macos-filesystem.mjs
node scripts/bump-version.mjs --check 1.0.7-sjotie.23
```

`macos-live.mjs` creates a fresh temp directory, archives original O2 source
from git, verifies its state hash, starts only its own old-writer children,
and loads a fixture plugin into an actual Claude CLI. User/project settings
and MCP servers are excluded. It captures shell, SessionStart and `/codex`
Bash observations. It exits nonzero unless both visibility and the sandbox
denial witness are proven. It keeps `summary.json` and the Claude tool-call
transcript in that temp directory, and stops/awaits only its own children.
It sends TERM to its own Claude child after 120 seconds and KILL after 125
seconds if needed. It does not enumerate or signal Claude grandchildren;
the fixture's own old-writer callbacks have a 180-second lifetime bound.
`macos-filesystem.mjs` prints P7/P8 measurements under every supplied Node,
checks both original state hashes, and retains its fixture directory.

The EPERM unit fixture uses signal 0 against PID 1, never a stop signal. The
first native attempt at the pre-existing test sent SIGTERM and was refused
with EPERM; PID 1 was confirmed alive. The test was corrected before the final
focused run. Synthetic Linux stop-old fixtures also now record the simulated
Linux procfs identity on macOS, instead of accidentally testing a rescan.

## Remaining gates and undo

- Resolve M2/M3 Bash visibility, retaining fail-closed behavior, then run the
  complete applicable native matrix. The Linux 404-test/61-mutation evidence
  belongs to the previous reviewed base and was not rerun as Mac evidence.
- Cross-family delta review before pushing this candidate branch; orchestrator
  decides the subsequent plugin-main landing. No force push, tag, publish,
  installed-plugin update, deployment or live state adoption in this work.
- Determine actual Windows loading before making a measured Windows-impact
  claim. The explicit unsupported boundary is retained meanwhile.
- Undo this delta by reverting its commits. For a future deployed fenced-lock
  rollout, follow README's drain/newCount-zero/unfence procedure with the new
  code before reverting to old writers. Never delete the authority database
  or fence while writers are running.
