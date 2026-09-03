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
