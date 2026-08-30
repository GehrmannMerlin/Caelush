# Phase 9B Durable Approval Workflow — Implementation Plan

> **For execution:** use the `executing-plans` skill and complete each task in order with the listed verification checkpoints.

**Goal:** Implement durable ApprovalRequest persistence and resolution from the Phase 9A Security Gate through ToolDispatcher, ToolBatchCoordinator, RunController, SQLite migration, restart recovery, and architecture documentation.

**Architecture:** Keep Security pure and add small provider-neutral approval ports in Tools/Core. Storage owns SQLite and approval transaction/event details. Dispatcher computes an internal exact approval key and asks the injected approval port for a same-run grant; creation is included in the existing ToolExecutionStore transaction. RunController owns the locked public resolution flow and resumes the persisted continuation through Coordinator recovery.

**Baseline:** Phase 9A remote branch `codex/phase-9a-security-policy-kernel`, commit `586f687fb95de8dcc8153bafa17d25b42876d702`, is not an ancestor of `origin/master`, so it is the explicit Phase 9B base. Fresh worktree baseline required install and a build/typecheck before tests because generated `dist` files are not tracked; after `pnpm typecheck`, baseline tests passed (`196 files / 676 tests / 4 skipped`), lint passed, and focused runtime tests passed. Fresh checkout `pnpm format:check` reported 539 existing warning files; final changed files must have zero warnings and final total must not increase.

## Task 1: Freeze contracts and lifecycle with failing tests first

1. Add focused tests for approval resolution input (`APPROVE` ONCE/RUN and `REJECT`, ONCE maximum-scope restriction), ToolInvocation `WAITING_APPROVAL → RUNNING/FAILED`, ApprovalRequest invariants, exact approval-key determinism and difference cases, and safe approval event payloads.
2. Run the focused tests and record the expected failures before implementation.
3. Add only the missing protocol-free internal types/helpers in Tools/Core, including approval lookup/resolution ports, approval key derivation, default TTL, safe rejection content, and lifecycle transitions.
4. Run the focused tests again.

## Task 2: Add SQLite approval persistence and migration

1. Add a test that opens isolated storage, verifies the committed migration/table/indexes, persists and loads approvals through the public repository API, and rejects codec/row mismatch.
2. Run it red, then generate the next Drizzle migration through the repository workflow and add the schema/table/query indexes without editing prior migrations.
3. Implement the ApprovalRepository with `getById`, `getByInvocation`, `listPendingByRun`, `resolve`, and exact `findApplicableRunGrant` behavior. Add injected clock and event/id dependencies for lazy expiration and atomic resolved events.
4. Extend `CaelushStorage` and its public `src/index.ts` exports without leaking database rows or `DatabaseSync`.
5. Run storage migration/repository tests and the storage package typecheck.

## Task 3: Atomically create approvals from the Dispatcher

1. Add failing Dispatcher and ToolExecutionStore tests for `REQUIRE_APPROVAL`: requested invocation, waiting invocation, one pending ApprovalRequest, one `approval.requested`, no handler call, same-run exact RUN grant reuse, DENY-over-grant precedence, cross-run/key mismatch rejection, and create idempotency.
2. Extend the Tool execution commit/snapshot port with an internal approval creation payload and approval snapshot, then implement the SQLite atomic insert and load path. Preserve existing callers that do not use approval persistence.
3. Make Dispatcher compute the canonical key, use the injected approval port for grant lookup, create safe RUN-scoped pending requests with 15-minute TTL, and commit waiting invocation + request + event together. No raw args enter approval events or model text.
4. Re-run focused and existing Dispatcher/Phase9A tests.

## Task 4: Resume or reject exact Tool boundaries and batch tails

1. Add failing tests for pending/approved/rejected/expired/cancelled Dispatcher recovery, `APPROVAL_REJECTED` observations, approved exact handler execution, and Coordinator continuation after the waiting item.
2. Implement waiting approval lookup/lazy-expiry recovery, approved Gate revalidation, reject/expire failure, and `WAITING_APPROVAL → RUNNING/FAILED` commits. Keep uncertain RUNNING recovery unchanged.
3. Ensure batch recovery resumes the paused item and executes trailing calls exactly once, without replaying the prefix or LLM turn.
4. Re-run focused tool/batch tests and the full test suite.

## Task 5: Implement RunController approval resolution

1. Add failing Core tests for resolution schema, missing/wrong Run or invocation, non-waiting Run, pointer mismatch, idempotent same resolution, conflict, restart recovery, approved resume, rejected/expired resume, and trailing Tool calls.
2. Add `resolveApproval` under `withLock`; validate Run status, continuation pointer, and durable Approval ownership before resolving.
3. Resolve through the ApprovalRepository transaction, transition Run/AgentState `WAITING_APPROVAL → RUNNING` via the canonical state machine, clear only `waitingApproval`, retain the pending decision, notify committed state events, and call Coordinator recovery.
4. Verify no new AgentLoop provider turn occurs and no completed Tool or Run is rerun.

## Task 6: Documentation, architecture guards, and final verification

1. Update `docs/architecture/security.md`, `docs/architecture/tool-system.md`, add `docs/architecture/approval-workflow.md`, update README Phase 9 status, and append Phase 9B rules to AGENTS without claiming future Phase 10 behavior.
2. Add or update architecture tests for dependency direction, public exports, safe approval events, and no daemon approval route unless the scanned composition actually supports one.
3. Format only changed files; verify changed-file warnings are zero and final warning total is no greater than the recorded baseline. Never run `prettier --write .`.
4. Run serially: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, `pnpm check`; inspect `git status --short` and `git diff`.
5. Commit coherent milestones, push `codex/phase-9b-durable-approval-workflow`, and report exact commit, verification evidence, and any pre-existing/non-blocking warning notes.
