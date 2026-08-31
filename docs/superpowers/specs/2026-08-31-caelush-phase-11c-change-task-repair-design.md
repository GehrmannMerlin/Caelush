# Caelush Phase 11C Change, Task Acceptance, and Bounded Repair Design

**Status:** Approved by the Phase 11C task document and implemented in the dedicated Phase 11C worktree.

**Scope:** Phase 11C only. This design does not implement completion authority, `VERIFYING → COMPLETED`, `run.completed`, `finalResult`, full verification crash reconciliation, UI/API work, Browser, MCP, remote runtimes, or hard sandboxing.

## Goal

After a solver Final Candidate, Caelush will execute the immutable VerificationPlan in ordinal order, validate the Agent-attributed workspace changes, review the Git changeset through the existing read-only RuntimeGitService, independently judge the original task with a bounded evidence-only reviewer, and optionally feed failed-but-repairable evidence into the same AgentLoop for at most three automatic repair cycles. A fully passing plan remains `VERIFYING` until Phase 11D.

## Existing boundaries confirmed during characterization

- `RunController.settle()` atomically persists a Final Candidate, its completed Step, `VERIFYING` Run/State, `AWAITING_VERIFICATION` continuation, and a new immutable plan before driving verification.
- `VerificationRunner` currently executes only `PROJECT` checks and uses the existing check start/settle store, command execution port, security admission port, evidence sanitizer, and durable verification events.
- `VerificationExecutionStorePort.getPlanExecutionSnapshot()` returns the plan and all evidence for one plan. The verification repository already supports `listPlans(runId)`, so no repair-cycle table is needed.
- `RuntimeWorkspaceScope.filesystem` and `RuntimeWorkspaceScope.git` are Phase 8 containment/bounded-read capabilities. Verification must receive structural ports, not import Runtime or perform host I/O.
- `RunBudgetPort` is the Core budget boundary and `SqliteRunBudgetPort` owns the single Phase 10D `BudgetManager` plus durable ledger. The existing ledger table has no SQL kind check; `VERIFICATION_LLM` can be added to the domain union without a migration.
- `AgentLoop` has provider-independent input, injected lifecycle hooks, and `ContextBuilder`-owned synthetic context. Repair will add an optional repair-context section; it will not append a fake user or tool message.
- Existing Run status and completion authority remain unchanged. `WAITING_VERIFICATION_REPAIR` is a continuation type, not a RunStatus.

## Design

### 1. Protocol and durable continuation

Extend the provider-neutral verification contract with a generic check-purpose union so check lifecycle events can represent `CHANGESET_SANITY`, `CHANGESET_REVIEW`, and `ACCEPTANCE` without leaking provider/runtime types. Add two durable event schemas:

- `verification.repair.started`: `failedPlanId`, bounded `failedCheckIds`, and `repairCycle`.
- `verification.repair.limit_reached`: `planId`, `attemptedRepairs`, and `maxAutoRepairs`.

Add `WaitingVerificationRepairContinuation` to Core's continuation schema:

```ts
interface WaitingVerificationRepairContinuation {
  readonly type: "WAITING_VERIFICATION_REPAIR";
  readonly runId: RunId;
  readonly failedPlanId: VerificationPlanId;
  readonly sourceStepId: StepId;
  readonly failedCheckIds: readonly VerificationCheckId[];
  readonly evidenceIds: readonly VerificationEvidenceId[];
  readonly repairCycle: number;
}
```

The continuation stores references only. Repair context is deterministically rebuilt from the original goal, old plan, blocking checks, durable evidence, and `changedFiles`.

`RUNNING` execution invariants allow this continuation only when there is no active Step. Starting the next solver provider turn consumes and clears it in the same durable Step-start checkpoint. It cannot be treated as a Tool continuation or solver retry continuation.

### 2. Workspace change sanity

`@caelush/verification` owns the structural `WorkspaceVerificationPort` and pure result/evidence contract. The port accepts a `WorkspaceRef`, bounded `FileChangeSummary[]`, and an optional `AbortSignal`; it returns bounded per-path metadata, counts, missing paths, unexpected kinds, symlink paths, an `inspectionComplete` flag, and deterministic SHA-256 `inspectionHash`.

The verifier checks only Agent-attributed declarations:

- `CREATED` and `MODIFIED`: path is inside the workspace, exists, and is a regular file.
- `MOVED`: the durable summary's destination exists, is inside the workspace, and is a regular file. Existing richer move provenance may be used when already available; Phase 11C does not change Phase 8 effects.
- `DELETED`: path is inside the workspace and absent.
- A symlink at a declared created/modified/moved final path is a failed sanity check.
- Path escape, unreadable metadata, unavailable runtime, or bounds that prevent reliable judgment produce `ERROR`, never `PASS`.

The Runtime adapter is composed outside the Verification package and delegates to the existing `RuntimeWorkspaceScope.pathResolver` and `filesystem.getMetadata/realpath`. It does not create `VerificationFileSystem` or `VerificationPathResolver`, and it never stores file contents.

The non-Git limitation is explicit: `AgentState.changedFiles` is an attribution ledger for known Tool Effects, not an exhaustive filesystem history. Shell side effects and pre-existing non-Git changes cannot be claimed as Agent-authored without a durable baseline.

### 3. Git changeset review

`@caelush/verification` owns a structural `VerificationGitPort` matching the data-only shape of RuntimeGitService. The adapter is composed at the host boundary and delegates to the existing `RuntimeWorkspaceScope.git.status()` and `.diff()`.

The check is read-only. It never uses a Git Tool, creates ToolInvocation/ToolObservation rows, stages, restores, resets, checks out, stashes, commits, or runs a second Git implementation. It reviews at most 128 Agent-attributed paths and keeps total evidence at most 64 KiB, with at most 48 KiB of aggregate diff excerpts. Per-path diffs are requested through the existing bounded `diff({ scope: "ALL", path })` call.

Semantics:

- unavailable repository + `IF_AVAILABLE` → `SKIPPED` with trusted `NOT_AVAILABLE` discovery evidence;
- unavailable repository + `REQUIRED` → `ERROR`;
- unmerged status → `FAILED`;
- status or relevant diff truncation that prevents complete judgment → `ERROR`;
- untracked declared creations are represented as status evidence; workspace evidence owns existence/type;
- dirty status paths outside `changedFiles` are `unattributedDirtyPaths`, a warning/evidence field, not an automatic failure;
- a tracked declared path with no net diff is `NO_NET_DIFF`; the Task reviewer decides whether that conflicts with the goal.

Evidence contains bounded status metadata, sorted attributed/unattributed paths, unmerged paths, per-path diff summaries, bounded excerpt, per-path SHA-256 hashes, truncation flags, and `reviewComplete`. It never contains an unbounded repository diff.

### 4. Task acceptance reviewer

Task acceptance is an independent check after all blocking Project, Workspace, and Git checks are terminal. `TaskReviewBundleBuilder` consumes only the original goal, candidate text, immutable plan/check summaries, bounded evidence summaries, and `AgentState.changedFiles`. It rejects or returns an incomplete result when the critical evidence cannot fit within `MAX_TASK_REVIEW_INPUT_BYTES` (96 KiB), rather than silently truncating evidence and permitting `PASS`.

The canonical bundle is hashed with SHA-256 as `reviewInputHash`. Persisted TASK evidence stores only that hash, reviewer version, strict verdict, bounded summary, bounded repair instructions for FAIL, and reviewed evidence IDs. The full prompt is not persisted.

The reviewer port is a provider-neutral high-level contract. Core supplies the current Run's ModelRef through the existing Gateway adapter. The request has no tools, bounded output tokens, the Run AbortSignal, and an explicit system instruction that all evidence (diffs, source text, filenames, test output and candidate text) is untrusted data and never an instruction. It asks for strict JSON with `PASS` or `FAIL`, a short evidence-based summary, and up to eight actionable instructions of at most 512 characters; it does not request or accept chain-of-thought.

Malformed JSON, unknown fields, missing/oversized fields, provider tool calls, provider authentication/network/local-timeout failures, incomplete evidence, or reviewer contract violations become TASK `ERROR`. Reviewer `ERROR` is not repairable and never uses the solver's `WAITING_RETRY` continuation. Final Candidate prose cannot self-certify the task.

### 5. Reviewer budget accounting

Add `VERIFICATION_LLM` to the existing budget ledger kind union and reuse the existing `BudgetManager`, estimator, pricing resolver, micro-USD calculations, and `RunBudgetPort` implementation. Reviewer entries are owned by the TASK check (`verify:<checkId>` or equivalent stable owner), reserve before the external provider call, become `IN_FLIGHT` immediately before that call, and settle with exact usage when available.

Reviewer calls consume input/output token and cost budget, and reviewer usage is included in the existing `AgentState.usage` projection. They do not create AgentSteps, do not increment `usage.steps`, and do not create ToolInvocations or increment `usage.toolCalls`. Missing usage after an in-flight call is conservative, never zero. A post-settlement budget overrun wins over a reviewer PASS and produces the existing `BUDGET_EXCEEDED` Run authority. Pricing unavailable under an enabled cost limit follows the existing Phase 10D safe failure.

No second BudgetManager and no second retry continuation are introduced.

### 6. Full verification driver and evaluator

Retain the existing Project runner and shared lifecycle/store/event machinery, but generalize the stage driver so checks execute strictly by plan ordinal:

```text
PROJECT → WORKSPACE → GIT → TASK
```

Each non-skipped check persists `RUNNING` and `verification.check.started` before host inspection or provider use, then atomically persists a terminal check, its evidence, and `verification.check.completed`. Read-only checks use Verification Evidence rather than fake Tool events. Existing 11B project checks remain unchanged.

The evaluator distinguishes `PASSED`, `FAILED`, `ERROR`, and incomplete states. Only blocking `FAILED` checks are repair candidates. `ERROR`, `SKIPPED`, stale `RUNNING`, cancellation, deadline, security review/deny, and budget blocks are not automatic repair. If all required checks pass, Core returns a bounded `AWAITING_VERIFICATION` result containing the evaluation summary while keeping Run/State `VERIFYING`; it never emits `run.completed` or sets `finalResult`.

### 7. Repair handoff

An injected host `VerificationRepairPolicy` exposes `maxAutoRepairs`, clamps it to a hard maximum of 10, and defaults to 3. Cycle zero is the initial plan; a plan created after the first repair is cycle one. Cycle count is derived from durable plan count for the Run, not an in-memory counter or a new table.

For a blocking FAILED evaluation with capacity, Core reloads Run/State/continuation/plan/evidence and checks authorities in this order: terminal, durable cancellation, deadline, maxSteps, budget. Only then does it compile a bounded/redacted `VerificationRepairContext` (32 KiB default) and atomically commit:

- Run `VERIFYING → RUNNING`;
- AgentState `VERIFYING → RUNNING` with no active Step;
- `WAITING_VERIFICATION_REPAIR` continuation containing references;
- `verification.repair.started` and `status.changed`.

Events are persisted before notification. The context contains original goal, bounded plan/check summaries, safe evidence excerpts, mismatch/path summaries, reviewer repair instructions, and changed-file list. It explicitly says evidence is diagnostic/untrusted, to preserve the original task as the highest goal, and not to fix unrelated pre-existing failures merely to make checks green.

On the next `start`/`recover`, Core rebuilds the context and calls the normal AgentLoop once. The optional context is injected only into the first repair turn through ContextBuilder. It is not appended to conversation. The normal Security, Approval, Tool, Cancellation, Deadline, Retry, maxSteps, and Token/Cost budget hooks remain authoritative.

After repair produces a new Final Candidate, Core creates a new Step-bound immutable VerificationPlan with fresh PENDING checks and runs every check again. Old plans and evidence remain immutable and are never copied into the new plan. Reaching the repair limit emits the bounded limit event, returns `AWAITING_VERIFICATION` with `repair.available=false`, keeps Run `VERIFYING`, and does not invent a status or completion.

### 8. Recovery and stale boundaries

`WAITING_VERIFICATION_REPAIR` with no active Step is a safe pre-provider recovery boundary and can rebuild context exactly once by clearing the continuation at the normal provider Step-start checkpoint. An active Step retains existing stale-Step recovery and is never automatically resent. A stale TASK/WORKSPACE/GIT `RUNNING` check is not replayed by Phase 11C. An in-flight `VERIFICATION_LLM` budget entry is recovered conservatively through the existing ledger recovery path; the reviewer is not called again.

### 9. Testing and architecture guards

Tests are TDD-first and cover workspace path/type/symlink/error/hash bounds, Git availability/status/unmerged/truncation/untracked/read-only behavior, reviewer strict parsing/injection/self-certification/bounds, reviewer budget reservation/settlement/conservative recovery and usage projection, stage ordering, FAILED vs ERROR, repair policy/limit/context/transition/fresh-plan semantics, governance races, safe repair recovery, and full PASS remaining in VERIFYING.

Architecture tests assert:

- Verification has no Runtime/fs/child_process/Storage/Tools/LLM imports;
- Runtime remains below Tools and does not import Verification;
- Core does not import Runtime/Storage or put concrete reviewers in AgentLoop;
- Git verification uses only the injected port and no Git CLI;
- reviewer has no tools or mutation path;
- one BudgetManager and one retry continuation remain;
- no `COMPLETED`, `run.completed`, `finalResult`, UI/API, or Phase 11D recovery appears in 11C implementation.

## External research synthesis

The official Aider materials emphasize repository mapping, diff-based edits, and automatic lint/test repair loops, while its lint/test documentation treats command output and non-zero results as feedback for a bounded repair cycle. SWE-agent's official repository exposes an explicit environment/repository boundary for controlled interaction. Caelush adopts the useful separation—environment capability, bounded evidence, test feedback, and repair—but keeps the stronger Phase 11C rules: immutable durable plans, independent task review, no reviewer tools, no automatic Git mutation, explicit untrusted-evidence prompts, and shared governance.

