# Caelush Phase 11A Verification Foundation Design

**Status:** Approved continuation design from `Caelush V1 — Phase 11A.md`.

**Scope:** Phase 11A only. This design establishes the Verification domain contracts, intent planner, evidence envelope, pure evaluation foundation, SQLite durability, and the Final Candidate to Verification Plan boundary. It does not execute checks or authorize completion.

## Baseline and Characterization

The Phase 10D base is the local commit `6e8a0f24cbfe8ccd030c1eb5ab058e3b9f99a9c6` on the local `codex/phase-10d-budget-enforcement-governance-finalization` branch. The requested remote refresh failed because the environment could not complete the GitHub TLS handshake; the commit object and local Phase 10D worktree were verified directly. `origin/master` does not contain this commit, so the selected base is the Phase 10D branch.

The dedicated worktree is `D:\\Develop\\Caelush\\.worktrees\\phase-11a-verification-domain-planning-foundation` on `codex/phase-11a-verification-domain-planning-foundation`.

Fresh baseline results before Phase 11A changes:

- `pnpm install --frozen-lockfile`: passed.
- `pnpm lint`: passed.
- `pnpm typecheck`: passed, including all package builds and package typechecks.
- `pnpm test`: passed, 228 files and 842 tests, with 4 skipped.
- `pnpm build`: passed.
- `pnpm format:check`: failed on 627 pre-existing files; this is `PHASE_11A_FORMAT_BASELINE=627`. No repository-wide formatter rewrite is permitted.

Current Final Candidate path, characterized from the real code, is:

1. `AgentLoop` classifies the provider turn as `FINAL_CANDIDATE` and returns an `AgentLoopExecutionResult`.
2. `RunController.settleExecution` settles the Agent Step and state usage, then calls the existing `markAgentStateVerifying` behavior and changes the AgentRun to `VERIFYING`.
3. The controller writes an `AWAITING_VERIFICATION` continuation containing `runId`, `sourceStepId`, and `finalDecision`, but currently no plan pointer.
4. The existing execution commit atomically writes Run, State, Step, messages, continuation, and durable events; its SQLite adapter currently has no Verification plan/check writes.
5. Events are committed before `RunController` calls the live notifier.
6. `recover()` returns the existing `VERIFYING` boundary without another LLM or Tool call; it has no existing plan to reload.

Therefore the current gap is not a second completion mechanism. It is the missing durable plan and evidence domain between the existing candidate boundary and future verification execution.

## External Architecture Findings

The research is used as design input, not copied as implementation:

- **OpenAI Codex:** the current Codex prompt recommends starting verification with checks specific to the changed code and expanding to broader checks as confidence grows. Caelush absorbs the evidence-first, specific-to-broad philosophy, while keeping the actual verification lifecycle outside the LLM AgentLoop. It rejects any model-only completion claim as authority.
- **OpenCode:** its current engineering prompt requires inspecting README/package configuration and existing conventions, explicitly warning agents not to assume a test framework or test script. Caelush absorbs project-evidence-driven discovery for Phase 11B; 11A stores only typed intents and performs no filesystem or command discovery.
- **Aider:** its current coder/linter flow demonstrates bounded, LLM-friendly diagnostics after edits and a separate test command path. Caelush reserves bounded failure summaries for future repair context, but rejects Aider's automatic command execution as an 11A behavior. Aider's public issue #5254 documents that repository-root `.aider.conf.yml` can supply `test-cmd`/`lint-cmd` that execute through a shell without confirmation; Caelush therefore treats repository-derived commands as untrusted provenance and leaves security/approval to 11B and Phase 9.
- **SWE-agent:** its reviewer module separates solver submissions from reviewer evaluation and can retry after review. Caelush absorbs the solver/reviewer authority separation, but 11A uses a deterministic pure evaluator rather than an LLM reviewer and defers repair/retry to 11C/11D.
- **Cline:** `attempt_completion` is a model-facing completion mechanism. Issue #11546 records premature acceptance while task progress remained incomplete and a verification command failed. Caelush rejects model completion tools entirely: `AgentFinalCandidateDecision` is only a candidate, and only future Verification Authority can authorize `COMPLETED`.

## Domain Contracts

`@caelush/protocol` receives the JSON-safe, strict, bounded contracts:

- New UUIDv7-prefixed IDs: `VerificationPlanId`, `VerificationCheckId`, and `VerificationEvidenceId`, using the existing branded ID schema style.
- `VerificationCheckSpec` is a discriminated union for `PROJECT`, `WORKSPACE`, `GIT`, and `TASK` intent. Project purposes are `LINT`, `TYPECHECK`, `TEST`, and `BUILD`; workspace purpose is `CHANGESET_SANITY`; Git purpose is `CHANGESET_REVIEW`; task purpose is `ACCEPTANCE`.
- Each check has `requirement` (`REQUIRED`, `IF_AVAILABLE`, or `ADVISORY`), stable `stage` (`FAST_STATIC`, `BEHAVIORAL`, `BROAD`, `CHANGE_REVIEW`, or `ACCEPTANCE`), bounded `purpose`, provenance `source` (`SYSTEM`, `PROJECT`, or `USER`), an immutable ordinal, and a lifecycle status (`PENDING`, `RUNNING`, `PASSED`, `FAILED`, `ERROR`, `SKIPPED`, or `CANCELLED`). Ordinals are zero-based and contiguous.
- `VerificationPlan` contains `id`, `runId`, `sourceStepId`, `plannerVersion`, `planHash`, ordered checks, and `createdAt`. A plan is immutable after persistence and belongs to exactly one Run and one Final Candidate Step.
- `VerificationEvidence` contains `id`, `planId`, `checkId`, `kind`, bounded `summary`, optional bounded JSON `details`, and `capturedAt`. Evidence is append-only and scoped to one plan/check; it cannot carry Error instances, abort signals, secrets, prompts, hidden reasoning, or unbounded output.
- `AwaitingVerificationContinuation` adds required `verificationPlanId`; decoding and storage enforce that the referenced plan has the same `runId` and `sourceStepId`.
- The only new lifecycle event is strict durable `verification.planned`, carrying `verificationPlanId`, `sourceStepId`, `checkCount`, `plannerVersion`, and bounded summary counts. It never carries goal text, final answer text, commands, Tool arguments, secrets, or hidden reasoning.

Legacy Phase 1 `VerificationResult` and `VerificationState` remain available where existing observation/state contracts still need them; Phase 11A does not reinterpret them as completion authority. Existing execution events named `verification.started`/`verification.completed` are not used by the new path and no new execution event is introduced.

## Plan Hash and Planner

`DefaultVerificationPlanner` lives in `@caelush/verification` and imports only public `@caelush/protocol` contracts. It is deterministic, synchronous or promise-compatible, LLM-free, filesystem-free, network-free, Runtime-free, Storage-free, and Tool-free. It consumes only:

```ts
interface VerificationPlanningInput {
  readonly runId: RunId;
  readonly sourceStepId: StepId;
  readonly goal: string;
  readonly workspace: WorkspaceRef;
  readonly changedFiles: readonly FileChangeSummary[];
  readonly projectFacts?: VerificationProjectFacts;
}
```

The planner never reads `package.json`, invokes Git, guesses commands from file extensions, calls a provider, or receives Storage/Runtime/EventBus/ToolDispatcher objects. It produces intent checks only. The default plan contains `PROJECT` LINT/TYPECHECK/TEST/BUILD as `IF_AVAILABLE` for a coding project (or conservatively when project facts cannot disprove it), and always contains `TASK` ACCEPTANCE as `REQUIRED`. Non-empty `changedFiles` adds required workspace changeset sanity and adds Git changeset review as `REQUIRED` only when Git repository facts are explicit, otherwise `IF_AVAILABLE`.

The planner deduplicates by canonical `(kind, purpose)` identity, orders by stage and then stable kind/purpose order, and assigns contiguous ordinals. The canonical hash input includes only `sourceStepId`, `plannerVersion`, and ordered check specs including requirements/provenance. It excludes plan ID, check IDs, and timestamps and is SHA-256 encoded as lowercase hexadecimal. Plan size is bounded at 32 checks; all text and JSON envelopes use existing safe protocol limits plus explicit bounded refinements.

`VerificationPlannerPort` is structural and is owned by Core's ports. Core can coordinate a planner without importing the concrete Verification package. The planner does not consume Phase 10 token, cost, Tool-call, retry, or provider budgets.

## Evaluation Foundation

`evaluateVerification` is a pure function in `@caelush/verification`. Its result is `INCOMPLETE`, `PASSED`, `FAILED`, or `ERROR`, plus non-blocking advisory warnings and safe reasons. It never transitions a Run.

- Zero checks returns `INCOMPLETE`.
- Required pending/running checks, required checks without evidence, and `TASK ACCEPTANCE` that has not passed return `INCOMPLETE`.
- A blocking `FAILED` returns `FAILED`; a blocking `ERROR` returns `ERROR`.
- A usable `IF_AVAILABLE` check may be `SKIPPED` only when its evidence explicitly proves unavailable; otherwise it is incomplete.
- `ADVISORY` failures produce warnings and do not block a possible `PASSED` result.
- `PASSED` requires every `REQUIRED` check to be passed, every available `IF_AVAILABLE` check to be passed or reliably unavailable, and no blocking failure/error. This evaluator is not connected to `COMPLETED` in Phase 11A.

## Durable Storage

One committed migration adds `verification_plans`, `verification_checks`, and `verification_evidence`. Plans have foreign keys to `agent_runs` and `agent_steps`, checks have a foreign key to plans, and evidence has foreign keys to both its plan and check. `(run_id, source_step_id)` is unique for plans; `(plan_id, ordinal)` is unique for checks. Durable records store typed scalar index columns plus strict JSON payloads decoded through Protocol schemas. Plan/check identity and hash are checked again when read.

The storage adapter exposes a narrow `SqliteVerificationRepository` for creating and reading immutable plans/checks and listing evidence. It does not expose `runCheck`, plan replacement, or update-plan APIs. Evidence append/status mutation remains deferred unless the contract is demonstrably stable; 11A may expose only the read/creation boundary required by tests and future 11B.

`RunExecutionCommit` gains an optional `verificationPlanCreate` payload containing one fully materialized plan and its checks. The SQLite execution adapter writes Run, State, settled Step, conversation, continuation, plan, checks, and `verification.planned` in one `BEGIN IMMEDIATE` transaction, then publishes committed events. Any plan/check/continuation/event write failure rolls back the entire final-candidate boundary. Duplicate `(runId, sourceStepId)` with the same hash is idempotent; a different hash is a fail-closed conflict and never overwrites an immutable plan.

## RunController Boundary and Recovery

When `AgentLoop` returns `FINAL_CANDIDATE`, the controller checks cancellation, deadline, max-step, retry, and budget authority before planning. It calls the injected planner, validates the draft, materializes IDs/timestamp without adding an Agent Step or budget entry, and atomically commits:

```text
settled final-candidate Step
AgentState VERIFYING
AgentRun VERIFYING
AWAITING_VERIFICATION { verificationPlanId, sourceStepId, finalDecision }
VerificationPlan + VerificationChecks
verification.planned
status.changed RUNNING → VERIFYING
```

The result includes `run`, `state`, `verificationPlanId`, `sourceStepId`, and compact plan counts. It does not include a full plan, evidence, completion result, or `run.completed` event. No production path creates `COMPLETED` in this round.

On recovery, an existing `VERIFYING` Run with `AWAITING_VERIFICATION` loads the referenced plan and returns the same boundary. Recovery calls the planner zero times and makes zero LLM/Tool calls. A missing plan, plan/run mismatch, or plan/source-step mismatch is a storage/invariant failure; recovery never chooses a newer plan or silently re-plans. Existing cancellation, deadline, retry, budget, security, and runtime authorities remain unchanged and have priority over planning.

## Explicit Exclusions

Phase 11A does not implement a VerificationRunner, project command discovery, concrete shell/Git/runtime execution, Security/Approval changes, verification ToolInvocations, LLM review, repair loops, re-verification, `VERIFYING → RUNNING`, `VERIFYING → COMPLETED`, `run.completed`, verification execution events, CLI/Web UI, or Phase 12+ work.

Architecture guards must prove:

```text
verification → core/runtime/tools/storage/security/llm: NO
verification → child_process/node-pty/Git CLI: NO
AgentLoop → VerificationPlanner/VerificationRepository: NO
Core → concrete @caelush/verification: NO
Verification command execution: NO
Verification ToolInvocation accounting: NO
Repair loop: NO
New RunStatus: NO
```

## Documentation Changes

Add `docs/architecture/verification.md` and update Agent Loop, execution governance, storage architecture, README, and `AGENTS.md` to describe candidate versus authority, durable intent plans, evidence scope, and Phase 11A exclusions. The README must say checks are not executed yet. The AGENTS rules must freeze Phase 11 to exactly 11A/11B/11C/11D and prohibit plan-less `VERIFYING` production data.
