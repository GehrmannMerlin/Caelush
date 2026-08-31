# Caelush Phase 11D Current-Code Characterization

**Repository state:** `ac2ad1c2881374fe6867c2cbcac21693066f6894` on the dedicated Phase 11D worktree, based on `origin/codex/phase-11c-change-task-verification-repair-loop`.

**Baseline:** `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass. `pnpm test` reports 254 files and 931 tests passed with 4 skipped. `pnpm format:check` reports 686 existing warnings; `pnpm check` passes its lint/typecheck/test/build stages and exits non-zero only at that historical formatting stage. No repository-wide formatting rewrite is permitted.

## Mandatory characterization

1. **What does RunController return after Verification PASS?**

   `RunController.driveChangeVerificationLocked()` evaluates the plan and, when the evaluation is not `FAILED`, returns `resultFromSnapshot(current)`. For a `VERIFYING` run with an `AWAITING_VERIFICATION` continuation, this is `AWAITING_VERIFICATION`; there is no completion decision or `COMPLETED` commit.

2. **Which identities are stored in `AWAITING_VERIFICATION`?**

   `runId`, `sourceStepId`, `verificationPlanId`, and the complete `finalDecision`, including `candidateText` and the model turn identity. The continuation schema does not store a candidate hash.

3. **Does `VerificationPlan` bind `sourceStepId`?**

   Yes. `VerificationPlanSchema` requires `runId` and `sourceStepId`; the storage repository also has a unique `(run_id, source_step_id)` boundary.

4. **Does it bind a Final Candidate hash?**

   No. The plan has `planHash` but no hash of `finalDecision.candidateText`. Project command evidence has a resolver candidate hash, which is a different identity and cannot certify the final assistant candidate.

5. **Does the `run.completed` Protocol event exist?**

   Yes. `RunCompletedEventSchema` exists and carries a bounded-by-schema `JsonValue` result. The event factory does not yet expose a completion-specific helper in Core.

6. **Does `VERIFYING → COMPLETED` exist in the Run state machine?**

   Yes. `packages/core/src/run-state-machine.ts` allows it, but no current RunController path invokes it.

7. **What is the current `AgentRun.finalResult` schema?**

   `AgentRunSchema` accepts an optional arbitrary `JsonValue`. It has no `VERIFIED_COMPLETION` discriminator, bounded final text, or seal fields.

8. **Which COMPLETED invariants are missing?**

   `assertRunExecutionInvariant()` checks terminal continuation/active-step rules but does not require that a `COMPLETED` Run has a matching `COMPLETED` State, `finishedAt`, `finalResult`, or a `VERIFIED_COMPLETION` final-result type. It also does not validate a completion seal.

9. **Does `VerificationExecutionStore` validate the current Run status?**

   No. `SqliteVerificationExecutionStore.startCheck()` and `settleCheck()` validate the current plan/check transition, but do not load or guard the Run, State, or current `AWAITING_VERIFICATION` continuation.

10. **Can `settleCheck()` append evidence after the Run is COMPLETED?**

    Yes in the current design: its transaction only requires a terminal check transition and inserts evidence/events. There is no Run-status or continuation identity guard.

11. **Can cancellation intent race completion?**

    Yes. `requestCancellation()` persists the intent through a separate transaction, while normal `commit()` reads before beginning its transaction and does not perform a completion-specific in-transaction cancellation guard. Phase 11D must make completion and cancellation first durable terminal authority wins.

12. **What does `recover()` do with a RUNNING Verification Check?**

    `recoverLocked()` reaches `driveProjectVerificationLocked()`. Project verification returns the known boundary when any check is RUNNING; change verification likewise refuses a blocking RUNNING check. The check is not converted to `ERROR`, no interruption evidence is written, and no terminal decision is made.

13. **What happens when the repair limit is reached and `recover()` repeats?**

    `maybeStartVerificationRepairLocked()` emits `verification.repair.limit_reached` and returns the still-`VERIFYING` snapshot. Repeated recovery can emit the same limit event repeatedly because no terminal failure finalization marker or status transition is made.

14. **What is the current budget-recovery/reviewer in-flight order?**

    `RunController.load()` calls `budget.reconcileState()` before deadline/retry reconciliation. The verification reviewer is called from the TASK executor after the check has been durably marked RUNNING. There is no recovery hook that conservatively settles an in-flight reviewer call before stale TASK recovery, so automatic replay is currently possible through the pending check boundary.

15. **How does the verification-plan repository identify the latest plan?**

    It provides `listPlans(runId)`, ordered by `created_at_ms ASC, id ASC`, and `countPlans(runId)`. There is no `getLatestPlanByRun()` API and no completion-time latest-plan identity check.

16. **How are old/new plans bound to Final Candidate Steps?**

    Every persisted plan is bound to one `sourceStepId`, and the repair continuation points at the failed plan/source step. A new repair candidate creates a new Agent Step and plan, while the old plan remains in storage. The current completion path has no explicit check that the continuation plan is the latest plan or that its subject is the current candidate text, so old-plan late writes are not rejected by the verification store.

## Files inspected

- `packages/core/src/run-controller.ts`
- `packages/core/src/run-execution-state.ts`
- `packages/core/src/run-state-machine.ts`
- `packages/core/src/agent-continuation-schema.ts`
- `packages/verification/src/contracts.ts`
- `packages/verification/src/evaluator.ts`
- `packages/verification/src/runner.ts`
- `packages/verification/src/change-runner.ts`
- `packages/verification/src/workspace-verifier.ts`
- `packages/verification/src/git-verifier.ts`
- `packages/storage/src/run-execution-store.ts`
- `packages/storage/src/verification-execution-store.ts`
- `packages/storage/src/repositories/verification-repository.ts`
- `packages/storage/src/cancellation-repository.ts`
- `packages/runtime/src/workspace-path.ts`
- `packages/runtime/src/filesystem/types.ts`
- `packages/runtime/src/filesystem/local-filesystem.ts`
- `apps/daemon/src/verification-runtime-adapters.ts`

## External architecture research

### OpenAI Codex

The current public `codex-rs/core/src/session/turn.rs` documents and implements a turn loop where a model response is either function calls, which are executed and fed into the next sampling request, or an assistant message, which is recorded as the completed turn outcome. The same loop propagates a `CancellationToken` through pre-sampling and sampling work and returns the abort rather than treating it as normal continuation.

**Absorbed:** explicit separation of tool continuation from a stable final assistant outcome; cancellation has precedence over normal continuation; completion is based on a settled turn outcome.

**Rejected:** Codex's Rust session/history/plugin architecture, its provider-specific protocol, and any assumption that a model-facing turn completion alone is sufficient for Caelush Run completion.

### OpenCode

The current public `packages/opencode/src/session/processor.ts` captures a snapshot before the stream, tracks tool calls separately, settles tool parts explicitly, marks interrupted tool work as error/interrupted, sets the assistant completion time during cleanup, and returns a small lifecycle result (`compact`, `stop`, or `continue`).

**Absorbed:** lifecycle-owned cleanup and one final settlement boundary; interrupted running work cannot remain falsely successful; completion timestamps belong to the cleanup/final boundary.

**Rejected:** OpenCode's Session V1 schema, Effect runtime, service graph, retry policy, and permission architecture.

### Caelush-specific completion design

Caelush keeps Verification evaluation pure and grants completion only to Core's `VerificationCompletionAuthority`/`RunController`. Completion is an in-transaction, guarded transition that binds the current continuation, latest plan, candidate hash, durable evidence digest, read-only workspace/Git freshness, bounded verified final result, and exactly-once durable events. Verification execution never mutates Run completion state, and stale RUNNING checks fail closed as ERROR rather than replaying external work.
