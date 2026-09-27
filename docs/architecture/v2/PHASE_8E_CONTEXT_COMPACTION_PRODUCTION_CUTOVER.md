# Phase 8E — Context Compaction V2 Production Cutover

## 1. Phase identity

Phase 8E — Coordinator, Recovery, Budget Accounting & Production Cutover.

This report records the implementation against the frozen Context Compaction V2
interfaces and the Phase 8E task text. Phase 8F was not started.

## 2. Base state

- Base SHA before Phase 8E work: `ff2bd838e0e55e36dc116d97a1ceb4e260700689`.
- Starting branch: `main`.
- Starting `HEAD`: `ff2bd838e0e55e36dc116d97a1ceb4e260700689`.
- Starting `origin/main`: `ff2bd838e0e55e36dc116d97a1ceb4e260700689`.
- Starting worktree: clean.
- Workflow: direct implementation on `main`, as required by the Phase 8E
  instructions; no feature branch, rebase, force push, or pull request.

## 3. Source audit before the cutover

The audit found the following real production state:

- Compaction orchestration still lived inline in
  `packages/agent/src/context/engine/context-engine.ts`.
- The daemon supplied a broad `forcedPolicy` containing tail ratios, source
  limits, and observation bounds, so recovery authority was split across the
  host.
- `apps/daemon/src/context/ai-context-summarizer-adapter.ts` called the AI
  gateway without entering the Run budget ledger.
- The existing Storage ledger already owned LLM, verification, and Tool
  accounting and already aggregated token/cost usage across ledger rows.
- The AgentLoop already implemented the exactly-one forced overflow path:
  normal main attempt, one `FORCED_RECOVERY` preparation and one second main
  attempt; a second overflow becomes `CONTEXT_EXHAUSTED` without a third main
  provider call.

## 4. Coordinator contracts

The final Agent public surface contains the frozen contracts:

- `ContextCheckpointIdFactory.create(): ContextCheckpointId`.
- `ContextCompactionRequest` with identity, conversation, history, policy,
  model, reason, and cancellation signal.
- `ContextCompactionOutcome` with `COMPACTED` and
  `NOT_APPLICABLE` (`NO_COMPRESSIBLE_HISTORY` or `INSUFFICIENT_GAIN`).
- `ContextCompactionDependencies` containing the existing planner, incremental
  resolver, checkpoint budget, gain evaluator, summarizer, validator, facts
  provider, deterministic fallback, enricher, rehydrator, tentative rebuilder,
  commit port, clock, and checkpoint ID factory.
- `ContextCompactionCoordinator.compact(request)`.

No `RequestV2` or `DependenciesV2` contract was introduced.

## 5. Frozen wiring adaptation

The coordinator is composed per Context preparation through a private
composition closure in the Agent Engine. The closure binds the latest
`IncrementalCheckpointState` exactly once from the existing resolver. It also
binds the existing event factory and event ID factory when constructing the
durable `context.compaction.completed` draft. The coordinator itself receives
only the frozen request and Agent-owned dependencies; it has no Storage, daemon,
Runtime, raw-artifact, or provider SDK authority.

The private tentative-rebuild closure captures the current source collection,
history coverage, authorities, materializer, and receipt builder. It assigns the
candidate checkpoint identity before using the existing shared build path. This
keeps candidate fit validation identical to final Context materialization while
keeping host-specific wiring out of the public request.

## 6. Production coordinator flow

Production compaction now follows one path:

```text
ContextEngine
  → ContextCompactionCoordinator.compact()
      → compaction planner
      → incremental resolver
      → checkpoint budget
      → gain gate
      → exactly one semantic summary attempt
      → summary validation
      → deterministic facts
      → semantic enrichment or deterministic fallback
      → source/checkpoint digest construction
      → tentative shared rebuild
      → candidate fit gate
      → atomic checkpoint/event commit
      → live notification after commit
  → activate committed checkpoint
  → fresh authority snapshot
  → shared final build and fit gate
```

An absent plan or unavailable/insufficient gain returns `NOT_APPLICABLE` without
committing. A candidate that remains over the effective input limit also returns
`NOT_APPLICABLE / INSUFFICIENT_GAIN` without committing. Infrastructure errors
escape through `ContextSummarizationInfrastructureError`; cancellation remains
cancellation and never degrades to fallback or commit.

## 7. Recovery planner

`ContextRecoveryPlanner` is Agent-owned.

- `NORMAL`: no action, or only `COMPACT_HISTORY` when pressure and compressible
  history both require it.
- `FORCED`: fixed order
  `DEFER_LOW_RETRIEVABLE → REDUCE_OPTIONAL_SOURCES → COMPACT_HISTORY →
  TIGHTEN_RECENT_TAIL → EXHAUSTED`.
- Forced target tail is approximately `effectiveInputLimit * 12%`, capped at
  `4096`, bounded by the normal target.
- Forced minimum tail is approximately `effectiveInputLimit * 5%`, capped at
  `1024`, bounded by the forced target.
- The recovery-adjusted compaction policy changes only target/min recent-tail
  tokens. Context window, effective input limit, reserves, request overhead and
  pressure thresholds remain unchanged.
- `EXHAUSTED` is a terminal decision and is never written to successful usage
  telemetry.

There is at most one semantic summary call during a preparation, including
forced recovery. A tighter tail is a parameter to that one compaction attempt,
not a second summary attempt.

## 8. Source recovery

Recovery adjusts `ContextPlan` decisions, not source results. Every source item
continues to receive exactly one decision, so receipt reconciliation remains
total.

- `DEFER_LOW_RETRIEVABLE` applies to optional atomic groups whose items are all
  `retention === "RETRIEVABLE"` and `priorityClass === "LOW"`; the whole group
  becomes `DEFERRED / RETRIEVABLE_DEFERRED`.
- `REDUCE_OPTIONAL_SOURCES` drops other selected optional groups with
  `DROPPED / TOTAL_BUDGET`.
- Explicit `atomicGroupId` values and history-derived conversation atomic groups
  are handled as whole groups; no group is split.
- Registry `criticality === "REQUIRED"` is the authority. Required Core Policy,
  Conversation, Checkpoint, project/workspace/runtime authority and other
  required registrations cannot be reduced.
- Planner decisions marked current/recent, pinned, mandatory, or
  `OPEN_PROTOCOL_UNIT` are protected. Current user intent and open ToolProtocol
  units therefore remain selected and unsplit.
- Forced observation bounds remain as a narrow daemon host policy solely for raw
  Tool observation reprojection. Tail and optional-source authority was removed
  from the daemon.

## 9. Budget accounting

The Storage-internal `BudgetEntryKind` now includes `CONTEXT_COMPACTION`; no
Protocol budget kind and no database migration were added. The existing
`BudgetManager`, ledger, aggregate snapshot, and in-flight crash recovery are
reused.

The daemon composition adds `context-compaction-composition.ts`. Its auxiliary
owner is deterministic and includes the Run ID, the canonical summary source
digest, requested model identity, and summary prompt version:

```text
context-compaction:<digest(runId, sourceDigest, model, summaryPromptVersion)>
```

The budgeted adapter:

1. estimates the complete provider-independent summary request;
2. admits `CONTEXT_COMPACTION` before gateway I/O;
3. clamps requested output to both the summary target and admitted output ceiling;
4. settles exact reported usage immediately after provider completion;
5. marks missing/partial usage conservative through the existing Storage port;
6. marks provider failures conservative; and
7. propagates budget infrastructure failures as a typed Agent infrastructure
   error.

Terminal conservative/settled owners are not reopened, so a retry cannot create
a free second auxiliary call. Auxiliary input/output tokens and cost enter the
existing aggregate Run snapshot, while auxiliary work does not increment Run
steps or Tool calls.

## 10. Budget evidence

Focused Storage and daemon tests prove:

- successful compaction admission/settlement records a settled
  `CONTEXT_COMPACTION` row and projects actual tokens while Steps and Tool calls
  remain unchanged;
- budget `EXCEEDED`/`UNAVAILABLE` prevents provider I/O (`provider calls = 0`)
  and permits the coordinator's deterministic fallback when it fits;
- provider failure marks the auxiliary owner `CONSERVATIVE`;
- missing usage becomes `CONSERVATIVE`, never zero-usage `SETTLED`;
- malformed semantic output settles real provider usage before the semantic
  runner selects fallback;
- cancellation propagates, does not commit a checkpoint, and does not silently
  release the auxiliary reservation; and
- a previously conservative owner is not admitted again.

## 11. Engine cutover

The Engine no longer directly performs semantic summary, deterministic facts,
checkpoint enrichment/fallback, digest assembly, tentative rebuild orchestration,
or compaction persistence. The superseded inline path and `commitCompaction`
helper were removed. The Engine now performs collection, coverage, pressure and
recovery planning, coordinator invocation, checkpoint activation, fresh authority
snapshot, shared final build, fit validation and usage recording.

## 12. Daemon cutover

`v2-context-composition.ts` no longer defines the old broad forced tail/source
policy. It composes:

- the raw AI semantic summarizer,
- the budgeted auxiliary summarizer,
- the existing deterministic facts provider,
- existing Context checkpoint commit/event ports, and
- existing clock and ID factories.

Only narrow forced observation caps remain for the established raw-artifact
materialization path.

## 13. Provider overflow

The AgentLoop overflow authority was not moved. Focused AgentLoop tests still
prove the normal attempt plus exactly one forced-recovery main attempt. If the
second main attempt overflows, the result is `CONTEXT_EXHAUSTED` and main-model
attempt number three is zero. Semantic summary calls are auxiliary and are not
counted as main attempts.

## 14. Raw Tool recovery

The production recovery E2E still proves that the forced main-model materializer
reprojects a durable raw Tool artifact into bounded visible content, preserving
Tool-call identity and the durable artifact boundary. The semantic coordinator
and summarizer receive only canonical stored/projected summary input and cannot
read raw artifacts, repositories, Runtime objects, or unsanitized process output.

## 15. Context usage

`compactionCount` increments only when a checkpoint is actually compacted and
committed. Recovery-only actions do not count as compactions. Successful forced
recovery records the ordered applied/attempted stages:

```text
DEFER_LOW_RETRIEVABLE
REDUCE_OPTIONAL_SOURCES
COMPACT_HISTORY
TIGHTEN_RECENT_TAIL
```

`EXHAUSTED` is not recorded on a successful build. Normal successful builds keep
`lastRecoveryStages` absent/empty.

## 16. Phase 8A–8D regression

The focused matrix passed for:

- 8A pressure and safe cut behavior;
- 8B incremental coverage, summary source, budget and gain behavior;
- 8C semantic validation/authority and Engine boundaries; and
- 8D candidate coverage, digest, rebuild durability and atomic persistence.

## 17. Focused tests

The final focused matrix passed 23 test files and 140 tests. It included:

- Coordinator contract, single-summary, candidate-fit, infrastructure-failure
  and cancellation tests;
- Recovery planner and group-safe recovery application tests;
- production cutover authority guards;
- Storage ledger, settlement, conservative recovery and no-reopen tests;
- budgeted daemon summarizer admission, clamp, denial and provider-failure
  tests;
- AgentLoop overflow tests;
- Context checkpoint commit tests;
- daemon semantic adapter tests;
- daemon production Context E2E; and
- daemon forced recovery/raw-artifact E2E.

All tests in that focused run passed; no focused test failed.

## 18. Static gates

The required non-full-suite gates passed:

- `pnpm build` — passed;
- `pnpm typecheck` — passed;
- `pnpm lint` — passed;
- `pnpm check:architecture:ci` — passed with 0 new violations, 0 stale
  baseline entries, and readiness `READY`;
- `node scripts/check-repository-hygiene.mjs` — passed;
- targeted Prettier check for Phase 8E changed files — passed; and
- `git diff --check` — passed.

## 19. Full suite

`pnpm test` full suite was NOT run in Phase 8E. It is reserved for Phase 8F.

Historical Phase 8D probe information is retained only as history:

```text
3397 passed
3 skipped
19 failed
```

Those historical failures are not represented as Phase 8E results and were not
expanded into unrelated cleanup.

## 20. Commits

- `bf9257635e391e861c44a7a33666c81f88751a34`
  `feat(context): add Phase 8E coordinator and recovery contracts`
- `db36782` `feat(context): cut over Phase 8E compaction and budget`
- The documentation commit SHA is recorded here after the report is committed.

## 21. Push

The final workflow will run:

```text
git push origin main
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git status --short
git log --oneline -12
```

The final verified `HEAD`, `origin/main`, and clean-worktree values are filled
in below after the push.

## 22. Final state

The required final state is:

```text
branch = main
HEAD = origin/main
working tree = clean
```

## 23. Next baseline

```text
PHASE_8F_BASE_SHA=<final SHA>
```

The exact final SHA is recorded after the documentation commit and push.

## 24. Final statement

```text
PHASE 8E COMPLETE

CONTEXT COMPACTION COORDINATOR PRODUCTION AUTHORITY COMPLETE

CONTEXT RECOVERY PLANNER CUTOVER COMPLETE

AUXILIARY SUMMARY BUDGET ACCOUNTING COMPLETE

CONTEXT COMPACTION V2 PRODUCTION PATH COMPLETE

CONTEXT COMPACTION V2 FINAL ACCEPTANCE IS NOT YET SEALED

PHASE 8F HAS NOT STARTED
```
