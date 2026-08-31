# Verification Architecture

## Phase 11 boundary

Phase 11 is fixed to exactly four rounds: 11A planning foundation, 11B verification execution, 11C evidence/review integration, and 11D completion authority. This document describes the shared 11A contract and the 11B execution boundary. No 11A-1, 11A-2, 11E, or implicit execution round exists.

Phase 11A creates the durable intent for verification. Phase 11B executes only deterministic `PROJECT` checks for `LINT`, `TYPECHECK`, `TEST`, and `BUILD`; it does not execute Git, workspace, task, or LLM-review checks and does not transition `VERIFYING` to `COMPLETED`.

## Contract ownership

`@caelush/protocol` owns JSON-safe, provider/runtime-independent contracts:

- `VerificationPlanId`, `VerificationCheckId`, and `VerificationEvidenceId` use the existing UUIDv7 prefixed-ID convention.
- `VerificationPlan` binds one Run and one final-candidate source Step to an immutable planner version, canonical SHA-256 hash, ordered checks, and creation time.
- A check has a discriminated intent (`PROJECT`, `WORKSPACE`, `GIT`, or `TASK`), a requirement (`REQUIRED`, `IF_AVAILABLE`, or `ADVISORY`), a stage, and a durable lifecycle status. Project purposes are `LINT`, `TYPECHECK`, `TEST`, and `BUILD`; workspace, Git, and task purposes are `CHANGESET_SANITY`, `CHANGESET_REVIEW`, and `ACCEPTANCE`.
- Evidence is bounded and JSON-safe. It contains a safe summary and structured details; it never carries a Provider SDK value, Runtime object, database row, credential, raw hidden reasoning, or unbounded output.

The plan schema rejects unknown fields, mismatched check ownership, duplicate logical intents, non-contiguous ordinals, and more than 32 checks. It does not contain commands. Commands and command discovery belong to a later execution round.

`AwaitingVerificationContinuation` carries `verificationPlanId`. A `VERIFYING` Run without a matching durable plan is an invariant failure, not a recoverable “replan now” case.

## Planner boundary

`DefaultVerificationPlanner` is a deterministic pure planner exposed by `@caelush/verification`. It accepts only Protocol planning facts: Run ID, source Step ID, goal, workspace reference, changed-file summaries, and optional project/Git facts. It has no filesystem, network, Runtime, Tool, Storage, EventBus, LLM, clock, or ID-factory dependency.

The default ordered matrix is:

| Order | Intent                     | Requirement                 | Stage           | Inclusion                                      |
| ----: | -------------------------- | --------------------------- | --------------- | ---------------------------------------------- |
|     0 | project lint               | `IF_AVAILABLE`              | `FAST_STATIC`   | code project or unknown                        |
|     1 | project typecheck          | `IF_AVAILABLE`              | `FAST_STATIC`   | code project or unknown                        |
|     2 | project test               | `IF_AVAILABLE`              | `BEHAVIORAL`    | code project or unknown                        |
|     3 | project build              | `IF_AVAILABLE`              | `BROAD`         | code project or unknown                        |
|  next | workspace changeset sanity | `REQUIRED`                  | `CHANGE_REVIEW` | changed files are non-empty                    |
|  next | Git changeset review       | `REQUIRED` / `IF_AVAILABLE` | `CHANGE_REVIEW` | Git true / unknown; omitted when known non-Git |
|  last | task acceptance            | `REQUIRED`                  | `ACCEPTANCE`    | always                                         |

The planner returns a draft. Core owns plan/check ID factories and the durable creation timestamp. The canonical hash excludes random plan/check IDs and timestamps and includes the source Step, planner version, and ordered intent/stage/requirement data. This makes retries and restarts compare intent rather than incidental identity.

## Evaluator boundary

`evaluateVerification` is a pure projection over a validated plan and evidence. It returns only `INCOMPLETE`, `FAILED`, `ERROR`, or `PASSED`, with bounded ID lists and advisory warnings. Zero checks are incomplete. Required or available blocking checks that are pending, running, cancelled, or missing evidence are incomplete. Blocking failures and errors are preserved as distinct outcomes. An `IF_AVAILABLE` check may be skipped only with matching discovery evidence that says the capability is unavailable. Advisory failures produce warnings and do not block a pass.

This evaluator is not connected to `COMPLETED` in 11B. Completion authority, review policy, and the remaining WORKSPACE/GIT/TASK execution remain future Verification rounds.

## Durable boundary

Storage adds one committed migration with three tables: `verification_plans`, `verification_checks`, and `verification_evidence`. Foreign keys bind plans to Runs/source Steps, checks to plans, and evidence to plans/checks. `(run_id, source_step_id)` and `(plan_id, ordinal)` are unique. Complete Protocol JSON remains the source of truth; scalar columns exist for integrity checks and indexed lookup.

The existing `RunExecutionStore.commit()` writes the Run, State, Step, conversation append, `AWAITING_VERIFICATION` continuation, VerificationPlan/checks, and durable lifecycle events in one `BEGIN IMMEDIATE` transaction. The plan is written before the transaction commits, and durable events are published only after commit. The new event is `verification.planned`; its payload contains only plan ID, source Step ID, count, planner version, and requirement counts. It contains no goal, candidate text, commands, tool arguments, secrets, or hidden reasoning.

Creating the same `(run, source Step)` plan with the same hash is idempotent. A different hash is a conflict and never silently replaces a plan. A later check insert failure rolls back the plan prefix, so there is no plan-less or partially planned `VERIFYING` boundary.

## Recovery

Recovery loads the existing continuation and plan. It performs zero Planner, Provider, Tool, Runtime, or Verification calls. It validates the plan/check relationship and hash already recorded in durable data, then returns the existing `AWAITING_VERIFICATION` boundary. Missing, malformed, mismatched, or corrupt plan data fails closed; recovery never regenerates a different plan from current workspace state.

Cancellation, deadline/timeout, retry, budget, Security, Runtime, Tool Dispatcher, AgentLoop, and EventBus ownership remains unchanged. Phase 11B consumes the existing Run-owned signal and deadline authority but adds no verification timeout, budget, approval workflow, Runtime object, ToolInvocation, or completion status to Protocol data. See [Verification Execution](verification-execution.md).
