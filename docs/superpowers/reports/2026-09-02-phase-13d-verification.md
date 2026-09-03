# Phase 13D Task 7 Verification

## Scope and baseline

- Baseline HEAD: `39fef9d` (`feat(web): add inline run controls and recovery UI`)
- Task: Phase 13D Task 7 only
- Production backend changes: none
- Protected packages changed: none (`Protocol`, `Core`, `Security`, `Runtime`, and `Verification` remain untouched)
- Phase 13E: not started
- Delivery action: tests and this report only; no push, merge/fast-forward, or branch deletion

The Task 7 implementation adds one real integration test under `apps/web/test/`. It starts the real daemon, uses a real `CaelushClient` and `WebSessionManager`, a deterministic provider, the daemon's configured Security/Approval path, and the real Tool/patch settlement path.

## Real integration coverage

### New Web integration coverage

`apps/web/test/phase-13d-integration.test.ts` covers:

1. `WAITING_APPROVAL` projected by the real daemon event stream into the real Web manager.
2. `Approve Once` resolution through the real HTTP client and daemon, followed by continuation of the waiting Tool.
3. Exact-once Tool assertion: the provider emits one patch Tool call and the workspace changes exactly once.
4. `Reject` resolution through the real Web manager, with the workspace unchanged and no Tool execution beyond the one model request.
5. Public projection safety: the test asserts the real `RUN` approval scope and the public `APPROVE_ONCE`/`APPROVE_RUN`/`REJECT` option set. The default daemon safe action does not supply optional presentation `toolName`/`summary` fields; no backend change was made to fabricate them.

### Existing real daemon/service coverage reused for Task 7

The focused daemon integration set passed and already exercises the remaining required boundaries:

- daemon-confirmed cancellation, AbortSignal propagation, durable `USER_REQUESTED` intent, and late provider output discard;
- graceful daemon shutdown with active work cancellation;
- close/reopen of the same SQLite database and `recoverRun` of the same Run without duplicate verification;
- durable SSE replay from `Last-Event-ID`/`afterSequence`, including live tailing and no duplicate sequence IDs;
- real Tool/file/verification lifecycle and exact-once patch assertion in the production control-plane fixture.

The restart test uses two real `startDaemon` instances against one SQLite path. A separate Windows child-process restart harness was not required for this repository run; the same-database service-level restart test passed and is the strongest available fallback under the brief.

## TDD evidence

The new test was first run RED. The initial real assertion expected the default approval action to contain `toolName` and `summary`; the daemon's existing public safe-action projection omits those optional fields, so the failure was classified as a public-projection fixture mismatch rather than a missing Web behavior. The test was narrowed to fields guaranteed by the existing public contract, then rerun GREEN.

Final new-test result:

```text
apps/web/test/phase-13d-integration.test.ts
  Test Files  1 passed (1)
  Tests       2 passed (2)
```

## Focused verification

Passed:

```text
Client control/client/timeline:       2 files, 14 tests passed
CLI control/reconnect:                2 files, 12 tests passed
Daemon control/production/SSE E2E:    5 files, 10 tests passed
New real Web approval integration:    1 file, 2 tests passed
```

The broader Web focused command ran serially and reproduced three pre-existing fixture failures in `approval-control.test.ts` (2) and `cancellation-control.test.ts` (1). The failures are not caused by the new integration file or a production change:

- two approval fixture assertions expect `submitPrompt()` to return `true` while their stream fixture immediately crosses a terminal/recovery boundary;
- the non-cancellable-status fixture expects `controlMode: "NONE"` for a `PENDING` recovery candidate, while the current reviewed Task 5/6 behavior exposes `PENDING_RUN_CONFIRMATION`.

These are recorded as existing Web test/fixture noise and were not silently changed within Task 7.

## Required final command sequence

Commands were attempted in the brief's required order:

| Command              | Result                                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint`          | Failed: existing `require-yield` errors in `apps/web/test/reconnect.test.ts` and `apps/web/test/recovery.test.ts`, plus ignored/generated `release-artifacts` browser bundle lint noise (255 errors total). New test was not reported by lint.                                                                     |
| `pnpm typecheck`     | Passed.                                                                                                                                                                                                                                                                                                            |
| `pnpm test`          | Failed: 7 tests failed, 1304 passed, 5 skipped across the existing Web fixtures and daemon environment-sensitive cases; 329 test files completed, 333 total. Notable daemon errors were transient `fetch failed` and `bad port` during the full parallelized suite; the same daemon focused suite passed serially. |
| `pnpm build`         | Passed.                                                                                                                                                                                                                                                                                                            |
| `pnpm build:release` | Started, completed workspace builds and deploy dependency setup, then exceeded the bounded collection window while release packaging was still running. The matching `build-release.mjs`/deploy processes were explicitly terminated; this is recorded as incomplete/timeout, not pass.                            |
| `pnpm test:release`  | Passed: `artifact-e2e passed: 0.1.0`.                                                                                                                                                                                                                                                                              |

The release build/test commands were bounded to avoid an unending deploy process. No result was silently converted to success.

Additional checks:

- Changed-file Prettier check: passed.
- `git diff --check`: passed.
- No production backend, Protocol, Core, Security, Runtime, or Verification file is part of the Task 7 diff.

## Security and authority checks

- Approval authority remains daemon/Security; the Web only displays bounded public approval data and submits a public resolution.
- Cancellation authority remains daemon/Core; the Web does not optimistically render `CANCELLED`.
- Durable event sequence remains the replay cursor; Web does not synthesize event chronology.
- Tool execution remains behind the real Dispatcher; Web never executes a Tool.
- Raw Tool arguments, shell/process output, credentials, hidden reasoning, verification evidence, and diffs are not added to Web control state or markup.
- No `COMPLETED` transition, Verification execution, sandbox, retry, timeout, parallelism, or other Phase 13E capability was added.

## Review and delivery status

Task 7's allowed changes are limited to the new Web integration test and this report. The branch is intentionally left unpushed and unmerged for the main-thread independent whole-branch review and final seal, as requested.

## Whole-branch review follow-up

- Review baseline: `4f7fe10` (`feat(web): add interactive run control and recovery`)
- Important finding: `apps/web/src/components/approval-card.ts` duplicated the client-layer option-to-resolution mapping instead of using the public canonical helper.
- Fix: `ApprovalCard` now imports and calls `approvalResolutionForOption()` from `@caelush/client`; the Web-local `resolutionFor()` implementation was removed. The safe `ApprovalView` projection, scope-gated options, and existing UI remain unchanged.
- Regression coverage: `apps/web/test/control-presentation.test.tsx` now exercises an approval button callback with a mocked shared-helper result, proving the callback uses the shared helper output. Focused result: `1` file, `5` tests passed.
- Follow-up verification: changed-file Prettier check passed, `pnpm typecheck` passed, and `git diff --check` passed. The requested Web control test command passed the focused presentation file; the broader approval/cancellation control files retained the three previously documented fixture failures.
- Delivery: fix committed separately; no push, merge, or master update performed.

## Main-thread final revalidation before delivery seal

The final command sequence was re-run on target `80a908d` after the whole-branch fix:

- `pnpm lint`: failed with existing `require-yield` findings in `apps/web/test/reconnect.test.ts` and `apps/web/test/recovery.test.ts`, plus generated `release-artifacts` bundle lint noise; the run reported 265 problems. No new production-file lint error was observed.
- `pnpm typecheck`: passed.
- `pnpm test`: failed with 3 existing Web fixture failures (`approval-control.test.ts` twice and `cancellation-control.test.ts` once); 1309 passed and 5 skipped. The failures match the previously documented fixture expectations and are not introduced by Task 7's test/report or the canonical mapping follow-up.
- `pnpm build`: passed.
- `pnpm build:release`: workspace build and deploy dependency setup completed, but release packaging produced no further output within the bounded window; the process was explicitly terminated and is recorded as incomplete, not passed.
- `pnpm test:release`: passed with `artifact-e2e passed: 0.1.0`.

The focused final control suite also passed 87 of 90 tests; its same three pre-existing Web fixture failures are listed above. `git diff --check` and the final changed-file Prettier checks passed. Delivery sealing remained for the main thread after this report update.
