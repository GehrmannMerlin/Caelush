# Caelush Phase 11D Completion Authority and Verification Recovery Design

**Status:** Approved implementation source for Phase 11D. This is the final Phase 11 round; no Phase 11E or Phase 12 work is included.

## Goal

Make `VerificationCompletionAuthority` the only authority that can move a Run from `VERIFYING` to `COMPLETED`, and make that decision recoverable, candidate-bound, freshness-bound, durable, privacy-preserving, and exactly once.

## Boundaries

The implementation changes only the Core, Protocol, Verification, Runtime read-only fingerprint, Storage, daemon composition, architecture tests, and Phase 11 documentation needed for this authority. It does not add Verification kinds, tools, runtimes, permissions, approvals, retry/budget systems, UI, MCP, Browser, remote execution, hard sandboxing, memory, or multi-agent behavior. Existing Phase 11A planning, 11B project execution, and 11C change/task/repair behavior remain the sources of truth for their responsibilities.

## Design

### Candidate and plan identity

`VerificationPlan` gains an optional-at-decode `candidateHash`, computed as SHA-256 of the UTF-8 `AWAITING_VERIFICATION.finalDecision.candidateText` when Core creates the plan. New completion requires the field and recomputes the hash immediately before completion. A missing or mismatched hash is `FRESHNESS_UNPROVABLE`; legacy plans are never rewritten to manufacture one. `sourceStepId`, `runId`, the current continuation plan ID, and latest-plan identity are checked together.

### Read-only freshness

Runtime's existing `WorkspacePathResolver` remains the only path-safety boundary. `RuntimeFileSystem` gains a bounded-memory-independent raw-byte fingerprint operation backed by streaming SHA-256. It classifies `FILE`, `MISSING`, `SYMLINK`, `DIRECTORY`, and `OTHER`, and rejects paths that fail existing lexical/realpath containment.

Workspace evidence for Agent-attributed `CREATED`, `MODIFIED`, and `MOVED` paths records only `{kind, sizeBytes, sha256}`; deleted paths record `MISSING`. Verification returns ERROR rather than truncating or omitting required fingerprints. Completion re-inspects `AgentState.changedFiles` and compares a deterministic workspace fingerprint hash to the durable successful evidence. This is a read-only revalidation boundary, not an OS-level snapshot or a guarantee against another process changing a file between reads.

Git freshness reuses the existing `RuntimeGitService` adapter and `reviewGitChangeset()`. It rechecks status, attributed paths, per-path diff hashes, unmerged status, truncation, and review completeness. Untracked content is covered by the workspace raw-byte fingerprint. An unavailable optional Git check remains valid only when its durable evidence proves trustworthy unavailability; freshness then relies on workspace fingerprints.

### Evidence digest and seal

The current plan's checks are canonicalized by ordinal then ID; its evidence is canonicalized by check ID, capture time, then evidence ID. Any evidence from another plan, missing check, or incomplete required fingerprint fails closed. SHA-256 of this JSON is `evidenceDigest`.

`VerificationCompletionSeal` is a deterministic tamper-evident integrity digest, not a cryptographic signature or security attestation. Its subject binds `runId`, `planId`, `sourceStepId`, `planHash`, `candidateHash`, `evidenceDigest`, workspace freshness hash, and optional Git freshness hash. The same subject always creates the same `sealHash`.

### Verified final result and invariants

`VerifiedRunFinalResult` is a strict JSON-safe V1 contract with `type: "VERIFIED_COMPLETION"`, the candidate text, bounded summary counts, and the seal references. It contains no raw stdout/stderr, full diff, raw evidence, provider payload, hidden reasoning, prompts, credentials, or host paths. Its text is exactly the candidate text from the continuation; completion never makes another LLM call.

`COMPLETED` requires a matching `COMPLETED` AgentState, no active Step, no continuation, `finishedAt`, and a valid verified final result. Other terminal statuses cannot retain a verified final result. `VERIFYING` continues to require no final result.

### Completion authority decision

The pure authority receives the Run/State/continuation identity, latest plan, evaluation, evidence, freshness result, repair capacity, cancellation/deadline/budget authority, and whether a terminal authority already won. It returns one of `COMPLETE`, `CONTINUE_VERIFICATION`, `START_REPAIR`, `TERMINAL_VERIFICATION_FAILURE`, or a higher-priority terminal authority (`CANCELLED`, `TIMEOUT`, `BUDGET_EXCEEDED`, `MAX_STEPS_REACHED`). Advisory failures/errors remain warnings according to the existing evaluator. A trusted `IF_AVAILABLE` skip may pass; an unsubstantiated skip remains incomplete.

### Atomic persistence and races

Core sends one guarded completion command to the existing `RunExecutionStorePort`. Storage starts `BEGIN IMMEDIATE`, then rechecks current Run status, State and revision, current `AWAITING_VERIFICATION` continuation/plan/source step, latest plan, cancellation intent, and the final candidate subject before writing. In the same transaction it writes Run, State, final result, clears the continuation, persists `verification.finalized`, `status.changed`, and `run.completed`, then commits before notifying subscribers. Cancellation persistence is guarded against terminal Runs. The first durable terminal transaction wins; a later cancellation or completion attempt reloads the terminal state and cannot add a contradictory intent/event.

Terminal verification failure uses the same atomic shape with `VERIFYING → FAILED`, clears continuation, writes bounded `VERIFICATION_FAILED` AgentError, and emits `verification.finalized`, `error`, `status.changed`, and `run.failed` once. Repairable FAILED evaluation continues through the existing bounded 11C repair continuation. Repair exhaustion is terminalized and cannot loop on `verification.repair.limit_reached`.

### Recovery and late writes

Recovery order is terminal Run, durable cancellation, deadline, budget/in-flight accounting, continuation identity, stale RUNNING check, existing evaluation, pending safe work, repair, then completion/failure authority. Terminal Runs are no-ops with no provider/tool/check calls or events. Every stale RUNNING PROJECT, WORKSPACE, GIT, or TASK check is atomically settled to ERROR with bounded `VERIFICATION_INTERRUPTED` evidence; it is never replayed. A reviewer call already in flight is conservatively budget-accounted before stale TASK settlement. Pending checks may continue. A plan with all terminal PASS evidence skips execution and performs only freshness plus authority.

Verification `startCheck()` and `settleCheck()` become guarded by current Run status, current continuation type/plan/source step, and plan ownership. Late results after repair, completion, cancellation, timeout, or a different plan are rejected before check/evidence/event writes. Repeated recovery, concurrent completion, and late provider/command results are idempotent and fail closed.

## Testing strategy

Tests use RED → GREEN → REFACTOR. Pure tests cover candidate binding, authority matrix, fingerprints, workspace/Git freshness, canonical evidence digest, seal determinism, final-result bounds, and invariants. Storage tests use fault injection and SQLite restart to prove atomic rollback, guards, exact-once events, cancellation/deadline/budget races, stale-check recovery, and final-result stability. Architecture tests assert no Verification Runner, Task Reviewer, AgentLoop, Tool, or Runtime owns Run completion and no forbidden scope leakage appears. Existing Phase 8–11 regressions remain mandatory.
