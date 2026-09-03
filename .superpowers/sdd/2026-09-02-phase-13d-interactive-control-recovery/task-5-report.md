# Phase 13D Task 5 Report — Run recovery and reload persistence

## Scope and baseline

- Baseline: `ab3797ffcfa27fc031a8a395deaed7d501627b07` (Task 4 reviewed CLEAN/PASS).
- Scope: Web run recovery classification and reload session selection persistence only.
- No changes were made to Protocol, Core, Security, Runtime, Verification, Daemon, or Storage.
- Task 6/7 and Phase 13E were not started.

## Implementation

- Added `SessionSelectionStore` in `apps/web/src/application/session-persistence.ts`.
  - Persists only a JSON-encoded `SessionId` under the workspace-scoped selection key.
  - Validates reads and writes through `SessionIdSchema`.
  - Validates membership against the current candidate set and clears invalid/non-member values.
  - Does not store Run, Timeline, or Approval state.
- Updated `WebSessionManager`.
  - Loads the persisted selection only after candidate discovery and membership registration.
  - Persists a selection only after the selected candidate has been validated.
  - Adds `prepareRecoveryRun`, `selectRecoveryRun`, and `confirmPendingRun`.
  - `PENDING` is exposed as `PENDING_RUN_CONFIRMATION` and is never auto-started.
  - `RUNNING` and `VERIFYING` attach one stream and admit `recoverRun` only from `onOpen`.
  - `WAITING_APPROVAL` loads durable pending approvals first. A real pending request prevents recovery admission; an empty durable list is handled safely and permits stream-open recovery.
  - Multiple active Runs remain untouched and expose `RECOVERY_PICKER`; no Run is implicitly selected or replaced.
  - Existing Task 4 stream generation, abort-before-replace, replay cursor, and reconnect behavior remains in place.
  - New Run creation now uses the same `confirmPendingRun` Web start path.
- Updated `WebHostApp` to provide one `SessionSelectionStore` to managers.
- Added focused tests for recovery classification, pending-start gating, approval protection, reload replay, and invalid/non-member persistence.

## Verification evidence

Commands run after implementation and formatting:

```text
pnpm exec vitest run apps/web/test/recovery.test.ts apps/web/test/session-persistence.test.ts apps/web/test/reconnect.test.ts apps/web/test/session-manager.test.ts
Test Files  4 passed (4)
Tests       24 passed (24)

pnpm --filter @caelush/web typecheck
$ tsc --noEmit
exit 0

pnpm typecheck
exit 0

pnpm exec prettier --check apps/web/src/application/session-manager.ts apps/web/src/application/session-persistence.ts apps/web/src/app.ts apps/web/test/recovery.test.ts apps/web/test/session-persistence.test.ts
All matched files use Prettier code style!

git diff --check
exit 0
```

The initial Red run was observed before implementation: the new persistence module was missing and the recovery assertions failed because PENDING admission and stream-open recovery did not exist. The focused suite passed after the minimal implementation, including the pre-existing Task 4 reconnect/session tests.

## Changed files

- `apps/web/src/application/session-manager.ts`
- `apps/web/src/app.ts`
- `apps/web/src/application/session-persistence.ts`
- `apps/web/test/recovery.test.ts`
- `apps/web/test/session-persistence.test.ts`

## Deferred / blockers

No blockers found within Task 5. Approval UI, cancellation UI, reconnect/recovery presentation, real daemon restart integration, final release verification, and all Phase 13E work remain outside this task.

## Task 5 follow-up fix from independent review

Fix baseline: `54a9139`.

- `WAITING_APPROVAL` recovery now distinguishes a successful empty durable approval list from an approval-query failure or unavailable query. Query failure publishes the existing `RUN_REFRESH_FAILED` error boundary, attaches the lifecycle without recovery admission, and therefore never calls `recoverRun` from stream `onOpen`.
- Web selection persistence now scopes `setCandidates`, `read`, and `write` with `WorkspaceRef.id` (`WorkspaceId`). `WorkspaceRef.path` remains limited to workspace/session matching and discovery. This keeps selections isolated for different workspace identities sharing a path and stable when one identity's path representation changes.
- Added regression coverage for approval-query failure and both workspace-identity cases in `apps/web/test/recovery.test.ts` and `apps/web/test/session-persistence.test.ts`.

The fix remains limited to Task 5 Web application behavior and tests/reporting. No Protocol, Core, Security, Runtime, Verification, Daemon, or Storage files were changed, and Task 6/7 were not started.

### Follow-up verification

```text
pnpm exec vitest run apps/web/test/recovery.test.ts apps/web/test/session-persistence.test.ts apps/web/test/reconnect.test.ts apps/web/test/session-manager.test.ts
Test Files  4 passed (4)
Tests       27 passed (27)

pnpm typecheck
exit 0

git diff --check
exit 0

pnpm exec prettier --check apps/web/src/application/session-manager.ts apps/web/test/recovery.test.ts apps/web/test/session-persistence.test.ts .superpowers/sdd/2026-09-02-phase-13d-interactive-control-recovery/task-5-report.md
All matched files use Prettier code style!
```

### Round 2 Important fix verification

The review reproduction is now covered by `apps/web/test/recovery.test.ts`: after a
`WAITING_APPROVAL` Run first returns a successful empty approval list and attaches a
`recoverOnOpen` stream, a second `prepareRecoveryRun` approval query failure revokes
that lifecycle's recovery admission before the delayed `onOpen`. The delayed open
therefore remains at the safe waiting boundary and does not call `recoverRun`.

The minimal implementation keeps the existing stream/lifecycle generation and
reconnect/replay behavior. It adds only an internal `recoveryRevoked` lifecycle flag;
approval-query failure sets it for the same active Run, and `onOpen` checks it before
admission. A later successful query can explicitly restore admission. The existing
`RUN_REFRESH_FAILED` error boundary remains published on query failure.

TDD evidence:

- RED: the new test failed before the fix because `recoverRun` was called once by
  the stale `recoverOnOpen` closure.
- GREEN: the isolated regression passed after the fix.

Fresh final verification from HEAD plus this fix:

```text
pnpm exec vitest run apps/web/test/recovery.test.ts apps/web/test/session-persistence.test.ts apps/web/test/reconnect.test.ts apps/web/test/session-manager.test.ts
Test Files  4 passed (4)
Tests       28 passed (28)

pnpm typecheck
exit 0

git diff --check
exit 0

pnpm exec prettier --check apps/web/src/application/session-manager.ts apps/web/test/recovery.test.ts .superpowers/sdd/2026-09-02-phase-13d-interactive-control-recovery/task-5-report.md
All matched files use Prettier code style!
```

No Protocol, Core, Security, Runtime, Verification, Daemon, or Storage files were
changed, and Task 6/7 were not started.

## Round 3 Important fix

The Round 3 review found that a successful empty approval query only cleared
`recoveryRevoked`; it could not change the already-captured `recoverOnOpen` value
of a stream generation, so recovery could remain permanently unadmitted. The
minimal Web-only fix records the current generation's recovery binding and open
generation. A successful empty durable approval query now uses the existing
abort-before-replace path with `attachStream(active, true)` when the current
generation was non-recovery or has already opened without admission. Otherwise
it only clears the revocation, allowing the pending generation's own `onOpen` to
admit exactly once. Initial approval-query failure also marks the newly attached
lifecycle revoked, so a later reconnect cannot bypass the fail-closed boundary.

Added regression coverage for:

- failure → non-recovery stream open → successful empty durable list → one
  replacement generation and one recovery admission;
- failure/revocation → reconnect generation open → successful empty durable list
  → one replacement generation and one recovery admission.

The existing Task 4 scheduler, abort-before-replace, generation guard, and
replay cursor paths remain unchanged.

### Round 3 TDD and verification

RED focused run before the implementation:

```text
pnpm exec vitest run apps/web/test/recovery.test.ts -t "rebinds"
Test Files  1 failed (1)
Tests       2 failed | 6 skipped (8)
```

GREEN focused run after the implementation:

```text
pnpm exec vitest run apps/web/test/recovery.test.ts -t "rebinds"
Test Files  1 passed (1)
Tests       2 passed | 6 skipped (8)
```

The complete Task 4/5 focused suite then passed with 30 tests:

```text
pnpm exec vitest run apps/web/test/recovery.test.ts apps/web/test/session-persistence.test.ts apps/web/test/reconnect.test.ts apps/web/test/session-manager.test.ts
Test Files  4 passed (4)
Tests       30 passed (30)
```

Final checks for this round:

```text
pnpm typecheck
exit 0

git diff --check
exit 0

pnpm exec prettier --check apps/web/src/application/session-manager.ts apps/web/test/recovery.test.ts .superpowers/sdd/2026-09-02-phase-13d-interactive-control-recovery/task-5-report.md
All matched files use Prettier code style!
```

No Protocol, Core, Security, Runtime, Verification, Daemon, or Storage files
were changed, and Task 6/7 were not started.

## Final Important fix: revoke recovery on confirmed pending approval

The final review identified one remaining fail-open timing path: an existing
`recoverOnOpen` lifecycle could be waiting for its stream `onOpen` while a later
successful approval query discovered a real `PENDING` approval. The old branch
returned without revoking that lifecycle, allowing the delayed `onOpen` to call
`recoverRun`.

The Web-only fix marks the existing same-Run lifecycle `recoveryRevoked` as soon
as a real pending approval is confirmed. If no lifecycle exists, it attaches a
non-recovery lifecycle and marks that lifecycle revoked. The revocation remains
in force across the old generation and subsequent reconnect generations, while
the durable approval projection remains visible as `APPROVAL`. Existing Task 4
abort-before-replace, generation guards, replay cursors, and reconnect behavior
are unchanged. `SessionSelectionStore` scope parameters now use Protocol's
`WorkspaceId` type.

Added regression coverage in `apps/web/test/recovery.test.ts` for:

- an existing recovery-enabled generation that has not opened yet;
- a later successful query returning a real pending approval;
- delayed opening of the old generation and opening of a reconnect generation;
- preserving the approval waiting state and making zero recovery calls.

### Final fix TDD and verification

RED:

```text
pnpm exec vitest run apps/web/test/recovery.test.ts -t "revokes delayed recovery and its reconnect generations"
Test Files  1 failed (1)
Tests       1 failed | 8 skipped (9)
Failure: recoverRun was called once by the stale delayed onOpen path.
```

GREEN:

```text
pnpm exec vitest run apps/web/test/recovery.test.ts -t "revokes delayed recovery and its reconnect generations"
Test Files  1 passed (1)
Tests       1 passed | 8 skipped (9)
```
