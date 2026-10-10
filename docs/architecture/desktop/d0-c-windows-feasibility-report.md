# D0-C Windows x64 Desktop Feasibility Report

## Round and Result

- **Round:** Caelush Desktop & Cloud — D0-C, Windows Desktop Technical Feasibility POC
- **Base commit:** `7b87351acc2c3b6bcca7ac15b59a53cf26f8893d` (D0-B on `main`)
- **Product version:** `0.1.0` (unchanged)
- **Target:** Windows x64
- **Result:** **PARTIAL**
- **POC label:** `POC_ONLY_UNAUTHENTICATED_TRANSPORT`

The POC ran from a copied portable product archive with a bundled Node runtime,
Electron Main, the existing Daemon, Web assets, Storage migrations, `node-pty`,
and the packaged Sandbox Runner. The fixture did not call a paid model or the
Cloud server. It did not modify production Agent, Daemon, Runtime, Storage, or
Protocol code.

The run proved the packaged startup, PTY, Runner, HTTP/SSE, and restart-recovery
paths on this Windows host. It did **not** prove graceful Daemon shutdown or a
clean Windows host run. Those two blocked gates prevent a COMPLETE result.

## Runtime Decision

```text
SELECTED_RUNTIME: BUNDLED_NODE_24
REJECTED_OR_DEFERRED_ALTERNATIVE: ELECTRON_EMBEDDED_NODE — deferred, not rejected for a proven ABI incompatibility
VERIFIED_NODE_VERSION: v24.18.0 (bundled), v24.21.0 (Electron embedded)
VERIFIED_ELECTRON_VERSION: 44.7.0
ABI_EVIDENCE: Bundled Node modules ABI 137 / N-API 10; Electron Node modules ABI 149 / N-API 10; the same packaged node-pty binary loaded in both runtimes. PTY I/O passed under bundled Node, and the bounded Electron probe drove PTY I/O using the bundled Node child.
DECISION_REASON: Bundled Node 24.18.0 is within the Daemon's declared Node range and passed the complete packaged Daemon, SQLite, PTY, Web, and SSE fixture. The Electron runtime also passed its bounded ESM/SQLite/native-module probe, but the complete Daemon was not executed under that runtime. The independent Node executable is the tested baseline and does not depend on Electron's RunAsNode fuse.
```

The tested Electron binary accepted `ELECTRON_RUN_AS_NODE=1`. Electron's
embedded runtime successfully loaded ESM, `node:sqlite`, and the packaged
`node-pty` native module. This is bounded evidence only: the entire Daemon was
not run in Electron's embedded Node, and the PTY test launched the bundled Node
executable as its PTY child. The module ABI numbers differ, so later packaging
must continue to validate the exact native artifact against the selected
runtime. N-API version `10` was reported by both runtimes.

## Windows Host and Artifacts

The test host was Windows 11 Home, build `10.0.26300`, 64-bit x64. The POC was
copied to a generated directory under the user's temporary directory. During
the staged execution, `PATH` contained Windows `System32` only. The following
commands resolved as absent from that path: `node`, `pnpm`, `rustc`, `cargo`,
and `git`. Electron Main explicitly launched the staged `runtime/node.exe`;
the Daemon did not use system Node discovery.

| Artifact                 | Source                                                                                                                                     | Measured identity                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caelush portable product | Existing Release Builder, built once from the current checkout                                                                             | Version `0.1.0`, Windows x64; archive SHA-256 `d500ba89b2ca755f19b418f5ef055303e0aa9191ceb358be373c29d73ee6dbc3`                                     |
| Bundled Node archive     | `https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip`                                                                               | Official Node `v24.18.0` Windows x64 ZIP; SHA-256 `0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821`                                 |
| Bundled `node.exe`       | Extracted from the verified official Node archive above                                                                                    | Node `v24.18.0`, modules ABI `137`, N-API `10`, SQLite `3.53.1`; SHA-256 `9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de`          |
| Electron archive         | Pinned Electron `44.7.0` npm package; downloaded from `https://cdn.npmmirror.com/binaries/electron/v44.7.0/electron-v44.7.0-win32-x64.zip` | Windows x64 ZIP SHA-256 verified against the pinned package's `checksums.json`: `eee30dc8fa1f5ea95490e59f44e46ea68dd24c6e93d22facf70fe5c2d4c2665c`   |
| Electron executable      | Extracted from the verified Electron archive above                                                                                         | SHA-256 `2529b494f4123f152bce346051f7bd855ef95006424a561953cf17c49a3d1ba8`; embedded Node `v24.21.0`, modules ABI `149`, N-API `10`, SQLite `3.53.4` |
| `node-pty`               | Existing packaged `node-pty@1.1.0` production dependency                                                                                   | Windows x64 `pty.node` SHA-256 `ae323edd0835ee7b9e18cc96a7b2bb4b8173ff768317d178af2788406feb71ff`                                                    |
| Sandbox Runner           | Existing Windows release artifact staged by the Release Builder                                                                            | Windows x64 PE; control protocol `1`; SHA-256 `90c2d476fe8dbe0ad1758c03eb1602d11fbf9aaf58d3ff9fd97dcef78c12ca0e`                                     |

The POC pins Electron `44.7.0` in its isolated `package.json` and lock file;
it does not add Electron to the Monorepo workspaces. The Node archive is checked
against the pinned official digest, and the Electron archive is checked against
the checksum in the pinned npm package before extraction. No Electron Builder
or NSIS installer is involved.

The existing release builder was used once to create a fresh portable archive
from the current source because the ignored local archive predated D0-B. The
build reused the existing Windows Runner artifact and did not rebuild it. The
available Rust toolchain reported `rustc 1.99.0 (b940084d7 2026-09-28)` and
`cargo 1.99.0 (5f94df478 2026-08-27)`, with target
`x86_64-pc-windows-msvc` installed. The MSVC linker toolchain (`cl`, `link`, and
`msbuild`) was unavailable, so the Runner's exact compiler provenance was not
re-established in this round. Its packaged digest and actual behavior were
verified.

## POC Layout and Reproduction

The POC is isolated under `scripts/poc/windows-desktop/` and uses its own pinned
Electron package manifest and lock file. Run it on a Windows x64 development
host with a current Caelush Windows x64 portable archive:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc/windows-desktop/run.ps1 -BundlePath <path-to-current-caelush-v0.1.0-windows-x64.tgz>
```

The run script stages Electron, Node, the product archive, and test data under
the user's temporary directory. Runtime execution uses only the staged
resources and a sanitized `PATH`; the script records a machine-readable result
outside the repository under `%TEMP%\caelush-d0c-cache\evidence\`. No
`~/.caelush` data is opened. Test data and staging are removed on completion
unless `-KeepStage` is supplied for local inspection. Large runtime artifacts
and evidence are not committed.

The final run's evidence file was
`%TEMP%\caelush-d0c-cache\evidence\windows-poc-20261010-021521-ca5668bb75794ea68bac4a51ceee82e1.json`.
The POC also prints each gate's status and its top-level result to stdout.

## Gate Results

The final command was the `run.ps1` invocation above, with the fresh current-
source archive supplied using `-BundlePath`. Results below reflect the saved
evidence JSON, not a prediction.

| Gate            | Result      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Runtime      | **PASS**    | Staged Node `v24.18.0` started by absolute executable path; ABI `137`, N-API `10`, SQLite `3.53.1`; no Node, pnpm, Rust/Cargo, or Git on the staged process `PATH`.                                                                                                                                                                                                                                                                                 |
| G2 SQLite       | **BLOCKED** | The production Daemon opened and migrated the disposable database; integrity check was `ok` with 32 tables; Session and completed Run survived restart and transcript reads. The first Daemon's normal `close()` did not acknowledge within 20 seconds, so the required graceful-close/reopen sequence is not established. The POC terminated only its owned child before reopening the DB.                                                         |
| G3 PTY          | **PASS**    | Actual packaged `@caelush/runtime` PTY adapter and `node-pty@1.1.0`: native load, PTY spawn, UTF-8 input/output (`PTY-UTF8-终端✓`), normal exit `0`, cancellation/termination observed.                                                                                                                                                                                                                                                             |
| G4 Sandbox      | **PASS**    | Packaged PE and manifest SHA verified; actual workspace status and prepare protocol reached `READY`; restricted child wrote inside the disposable workspace and its write to a sibling directory was denied. Provider reports `PARTIAL` enforcement, not a hard OS sandbox.                                                                                                                                                                         |
| G5 Web/SSE      | **PASS**    | Packaged Web index, JS, and CSS returned HTTP 200 and loaded in Electron. Production Daemon Health/Info schemas passed at an OS-assigned loopback port. A local scripted provider completed one Run with zero external provider calls. Durable SSE sequences were `1..10`; replay after cursor `6` returned `7..10`; aborting the live stream did not cancel or lose the Run.                                                                       |
| G6 Process/IPC  | **BLOCKED** | Private child IPC, PID/generation validation, new generation after restart, stale-generation rejection, child-exit detection, and failure injections all passed: `CHILD_EXIT_BEFORE_READY`, `STARTUP_TIMEOUT`, `INVALID_BOOTSTRAP_MESSAGE`, `GENERATION_MISMATCH`, `CHILD_EXIT_AFTER_READY`, `SHUTDOWN_TIMEOUT`. Normal Daemon shutdown did not acknowledge within 20 seconds. Only the POC-owned child was terminated; final orphan count was `0`. |
| G7 Clean Host   | **BLOCKED** | A copied portable directory ran with `PATH=System32` and no developer tools in that path. This host had no available Windows Sandbox or clean Windows VM, so this does not meet the clean-host gate.                                                                                                                                                                                                                                                |
| G8 Architecture | **PASS**    | The fixture uses the existing Daemon production composition and public package entries; no Agent authority, DaemonInfo capability, Protocol, or production runtime behavior was changed. The targeted architecture check and daemon production E2E result are recorded in the validation section below.                                                                                                                                             |

G2's database-integrity and restart-recovery subchecks passed. G2 remains
BLOCKED because its normal shutdown prerequisite did not pass. G4's provider
reports Windows ACL restricted-token enforcement as `PARTIAL`; the test only
proves the measured disposable workspace/sibling write behavior. It does not
upgrade the product's documented security boundary into a hard sandbox.

## Startup, IPC, and Security Boundaries

- Electron Main forked the explicit staged Node executable and started the
  existing `@caelush/daemon` entry with `port: 0` on `127.0.0.1`.
- A one-use bootstrap value appeared only in the first private child IPC
  message. The child checked exact message fields and reported its PID,
  generation, and selected port on that channel. The POC checked the value was
  absent from argv, environment, and URL.
- Main validated the reported PID and generation. A restart used a new
  generation; stale-generation `SHUTDOWN` was rejected and current-generation
  control was accepted.
- The startup deadline was 10 seconds. Negative startup and shutdown cases
  were injected using bounded test timeouts. Normal shutdown remained bounded
  by the POC's 20-second limit.
- HTTP was unauthenticated loopback traffic for this isolated fixture only.
  The test did not implement or claim Host Token verification,
  `desktopProfileBindingV1`, or `desktopLocalProxyV1`; it did not set
  `hostIdentityVerified` or invent Daemon capabilities.
- The browser-rendered Web assets and renderer use in this POC do not implement
  a production Preload API, Cloud Account Client, Profile Manager, or update
  coordinator.
- The test used no Cloud endpoint and did not connect to the future deployment
  server.

## Targeted Validation

| Check                    | Command                                                                                                                                  | Result                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| POC source syntax        | `node --check` for each `.mjs` and `.cjs` under `scripts/poc/windows-desktop/`                                                           | **PASS**                                            |
| POC Windows vertical run | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc/windows-desktop/run.ps1 -BundlePath <fresh-current-source-archive>` | **PARTIAL** — G1/G3/G4/G5/G8 pass; G2/G6/G7 blocked |
| Daemon production E2E    | `pnpm --filter @caelush/daemon exec vitest run test/daemon-production-e2e.test.ts`                                                       | **PASS** — 2 tests passed                           |
| Architecture CI          | `pnpm check:architecture:ci`                                                                                                             | **PASS**                                            |
| Diff hygiene             | `git diff --check`                                                                                                                       | **PASS**                                            |

`pnpm build` ran once across the 18 workspaces because the existing release
builder needs current workspace outputs to produce the fresh portable test
archive. No full Monorepo test suite, `pnpm build:release`, Windows installer,
real Provider API, Cloud deployment, or production-server operation was
performed. The workspace build was a build-host prerequisite, not a runtime
dependency of the copied POC.

## Agent and Storage Invariants

The D0-C POC changed none of the following production sources or contracts:

- AgentLoop or Agent Kernel.
- RunController, Completion Authority, or Run state machine.
- Context, Security Prompt, Prompt Cache, or Native Replay.
- Message/Event schemas or durable SSE sequence/replay semantics.
- Provider Credential Authority or model-provider runtime flow.
- SQLite schema, migrations, or repository authority.
- Launcher/Web/CLI production startup paths.

The only Session, Run, and SQLite data was a disposable local fixture below
the generated POC temp root. No user workspace, real Provider key, Cloud
identity, or production database was read.

## Known Issues and Follow-up Constraints

1. **Graceful shutdown:** Normal Daemon close did not report `CLOSED` or a
   bounded failure within 20 seconds after the fixture Run had completed.
   The POC evidence does not identify which internal close phase waited. Keep
   this as a Phase 0 blocker for a follow-up bounded shutdown investigation;
   do not infer that forced process termination is graceful shutdown.
2. **Clean Windows environment:** No Windows Sandbox or clean VM was available.
   Repeat G7 on an isolated Windows x64 host before claiming portable clean-host
   compatibility.
3. **Runner build provenance:** The current host had Rust 1.99.0 and the MSVC
   target but no MSVC linker tools. D6 packaging must make the exact target
   build and signed resource identity reproducible. The POC verified and
   executed the existing packaged binary; it did not compile a new one.
4. **Windows enforcement:** The Runner's restricted-token provider identifies
   its enforcement as `PARTIAL`. Preserve the existing security policy and
   report its scope accurately; do not market it as an OS-level hard sandbox.
5. **Embedded Electron runtime:** A bounded probe passed for Electron Node
   `24.21.0`, ESM, SQLite, and loading the same PTY module, but the Daemon itself
   was not hosted by that runtime. The D0-C selected strategy is bundled Node
   `24.18.0`; D3/D4/D6 should preserve its exact tested Node range and native
   artifact identity unless a later round revalidates a changed strategy.
6. **Desktop security implementation:** POC IPC is not the production Host
   Token channel. Profile binding, authenticated local proxying, Cloud account
   sessions, and vault storage remain for D3/D4.
7. **Distribution:** There is still no formal Electron app, ASAR/resource
   policy, NSIS installer, Authenticode identity, or update mechanism. D6/D7
   retain that work.

## Deferred Implementation Map

- D3 remains the owner of the formal Electron Main/Preload and account/window
  state integration.
- D4 remains the owner of Profile, Host Token, authenticated local proxy, and
  secure credential migration. POC IPC must not be reused as production
  authentication.
- D6 remains the owner of deterministic resource staging, installer and
  upgrade compatibility, and repeatable Windows native artifact builds.
- D7 remains the owner of signed release/update delivery.

No D1-D8 business feature was started in D0-C.

## Next-Round Readiness

```text
D0-C Gate: FAIL
D1-A Ready: YES (Cloud identity work can proceed independently against the D0-B public contract; Desktop work remains gated on the D0-C blockers.)
```

## Shutdown Remediation — 2026-10-10

This section records the remediation run from baseline
`0e9db7508d032cf8a8ed8205c07af0e42387de77`. The historical D0-C gate table and
its PARTIAL/blocked evidence above remain unchanged. The remediation evidence
is stored outside the repository at
`%TEMP%\caelush-d0c-cache\evidence\windows-poc-20261010-112837-d67b41f780ab4e8b96770c8e705e8a10.json`.
The run reused the verified staged product tree and cached Electron `44.7.0`
and Node `24.18.0` resources.

### Root Cause Analysis

#### Observed Symptom

The earlier Windows POC completed a Fixture Run, then timed out while awaiting
the daemon child's `CLOSED` acknowledgement. The child had entered `app.close()`;
`checkpointActive`, `drainWithin`, and SSE Abort had completed. The main process
received no shutdown response before the POC's 20-second bound.

#### Reproduction

The instrumented original path reproduced the block in C and D. C closed its
BrowserWindow before daemon shutdown; D kept it open. A, B, and E completed.
F completed a Fixture Run without opening a BrowserWindow. G completed the same
Run with `Connection: close`. Additional checks showed that a window closed
before the Run could still reproduce the block while the POC's JS/CSS probe
responses were not fully consumed. With the corrected asset read, A–H all
completed, including B with an idle BrowserWindow still open and D with a
completed Run and BrowserWindow still open at shutdown.

#### Actual Stuck Phase

The failing runs stopped inside Fastify `app.close()`, before
`composition.dispose()` and `storage.close()`. At the stuck boundary,
`activeRunCount` was `0`, checkpoint unsafe count was `0`, drain outcome was
`DRAINED`, and active HTTP response count was `0`; open TCP connections remained.
The final vertical run observed six connections at `appClose` start and
completed that phase in `3995 ms`.

#### Root Cause

The POC helper `verifyAndLoadWeb()` in
`scripts/poc/windows-desktop/poc-main.cjs` fetched the packaged JavaScript and
stylesheet to check their status, then returned without reading either
`Response` body. Those unconsumed Node `fetch` responses retained client
connections in the Electron Main Undici pool. Fastify waited for the resulting
connections during `app.close()`. The BrowserWindow comparison showed that
Renderer liveness alone did not cause the block: after the asset response fix,
both idle and completed-Run cases shut down while the BrowserWindow remained
open.

The IPC handshake also had a separate POC race: `stopDaemonChild()` sent
`SHUTDOWN` before installing its response listener. The same unsafe ordering
was removed from START, PING, and generation-control waits by using a helper
that installs response, send-error, timeout, and exit listeners before sending.

#### Minimal Fix

`verifyAndLoadWeb()` now reads both packaged asset response bodies to completion
before checking they are non-empty. The POC IPC wait helper registers its
listeners before calling `sendIpc()` and removes them on response, send failure,
timeout, or child exit. The Daemon production close sequence and Agent, Context,
Prompt Cache, Native Replay, RunController, Tool execution, SSE, and Storage
semantics were not changed. The internal shutdown observer adds only bounded
phase timings and aggregate socket/request counts for diagnosis.

#### Regression Evidence

- The final POC passed gates G2, G6, and G8. The overall POC result remains
  PARTIAL because G7 remains BLOCKED.
- G2 evidence: shutdown requested; `daemon.close()` fulfilled; `CLOSED`
  acknowledged; child exit code `0`; SQLite reopened; 32 tables;
  `integrity_check = ok`; Session, Run, and assistant Transcript recovered.
- G6 evidence: Startup IPC and generation verified; shutdown request sent;
  `CLOSED` acknowledged; exit code `0`; stale generation rejected; duplicate
  close shared one attempt; all six injected timeout/exit/protocol cases passed;
  orphan child count `0`.
- Isolation cases A–H all passed. C completed a Fixture Run, closed the window,
  and then shut down. D completed a Fixture Run and shut down with the
  BrowserWindow still open. E aborted an active SSE subscription and closed
  normally. `app.close()` completed in 2–5 ms for A–H; the vertical shutdown
  completed it in `3995 ms`.
- `pnpm --filter @caelush/daemon exec vitest run test/shutdown.test.ts`: 6
  passed. `pnpm --filter @caelush/daemon exec vitest run
test/daemon-production-e2e.test.ts -t "naturally completes a plain task and
reads the single final answer after daemon restart"`: 1 passed.
- `node --test scripts/poc/windows-desktop/poc-ipc.test.cjs`: 4 passed.
  `pnpm --filter @caelush/daemon typecheck`, targeted Prettier, POC syntax, and
  `git diff --check` passed. The architecture CI check was not run; this round
  changed no package boundary.

#### Remaining Risks

G7 Clean Host remains BLOCKED because no clean Windows VM or Windows Sandbox was
available; it was not rerun. The remediation POC reuses a staged product tree,
so this round does not establish a fresh release archive hash. The Windows
restricted-token provider still reports `PARTIAL` enforcement, and formal
Electron packaging, Host Token authentication, and signed distribution remain
deferred as documented above. D0-C remains PARTIAL and is not COMPLETE.
