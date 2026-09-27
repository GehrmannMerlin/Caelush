# Architecture V2 Phase 8B — Context Compaction Incremental Source and Gain

Status: implemented on `main` from the frozen Phase 8B base.

## Base and starting state

- Phase 8B allowed base SHA: `5375edbfa9cbe2975aa0f005a556f62b74187da7`.
- Starting branch: `main`.
- Starting `HEAD` and `origin/main`: the allowed base SHA.
- Starting worktree: clean.
- Scope: incremental Context checkpoint coverage, cumulative semantic source, complete
  summary serialization, checkpoint budget, meaningful-gain gating, and the existing
  ContextEngine integration.
- Explicitly out of scope: Phase 8C–8F authorities, validators, enrichers, rebuilders,
  coordinators, persistence migrations, and provider adapter changes.

## Source audit findings

The existing Phase 8A/7D implementation already provided the semantic history index,
safe compaction cut planner, V1/V2 checkpoint contracts, the Context summarization runner,
and the atomic compaction commit/event port. The audit identified five Phase 8B gaps:

1. checkpoint coverage removed whole units and used the V2 anchor Turn as a filter, so a
   cross-Turn range could leave covered messages in Context and double-count overlapping
   Turn/ToolProtocol token estimates;
2. the latest checkpoint was read directly by ContextEngine, with no explicit NONE/V2/V1
   state or cumulative source resolver;
3. the summary source silently capped messages, parts, text, and serialized JSON, omitted
   ToolCall input, and replaced durable projected ToolResult content with a placeholder;
4. checkpoint output budget and pre-provider semantic gain were not represented;
5. ContextEngine passed the recent-tail target and a new delta range directly to the
   summarizer, then rebuilt active coverage from an already residual history.

The implementation keeps the existing Context authority, runner, commit transaction, and
AgentLoop overflow retry. It does not add a second orchestration root or persistence path.

## Final incremental contracts and factories

All new contracts live under `@caelush/agent` Context compaction and are exported through
the Context public index and Agent root only.

### Checkpoint state

`IncrementalCheckpointState` is the frozen three-arm union:

```text
NONE       no checkpoint exists
V2         latest ContextCheckpointRecordV2, validated against the full history index
LEGACY_V1  latest legacy V1 record, readable recovery memory only
```

`createIncrementalCheckpointResolver({ checkpointRepository })` reads only
`ContextCheckpointRepositoryPort`. It validates the latest V2 through the canonical
coverage projection, rejects mismatched Run identity, and never converts a V1 record or
uses a V1 ID as a V2 predecessor.

`createContextCompactionCoverage({ history, latestCheckpoint })` is the single Agent-owned
coverage authority used by preparation and ContextEngine source filtering. It returns the
residual history, recovery checkpoint, V2-only trusted predecessor ID, and a unique covered
message identity set.

### Cumulative source input

`createContextIncrementalCompactionResolver()` produces:

```text
ContextIncrementalCompactionInput {
  previousCheckpoint?: ContextCheckpointRecordV2
  newSourceMessages: StoredAgentMessage[]
  cumulativeSourceRange: ContextMessageRange
  newSourceRange: ContextMessageRange
}
```

New source selection is model-visible only, Run-scoped, inclusive by sequence, sorted by
sequence, and endpoint-identity checked. A V2 predecessor requires a strictly later new
range; overlap or regression fails closed. NONE and LEGACY_V1 begin a new V2 chain from the
current plan range.

## V2 A → B → C proof

For the canonical chain:

```text
checkpoint A: cumulative 1..100
plan B:       new 101..160  -> cumulative 1..160, previousCheckpoint = A
plan C:       new 161..220  -> cumulative 1..220, previousCheckpoint = B
```

The resolver takes the predecessor's first message ID, first sequence, and anchor Turn and
the current plan's last message ID and last sequence. The `newSourceMessages` list contains
only the current range. The V2 anchor Turn is metadata identity; it is never used as the
whole-range coverage filter. The checkpoint envelope and the structured summary source use
the same cumulative range.

## V1 compatibility and partial boundaries

V1 remains readable and exposes its StructuredCheckpoint as recovery memory through the
compatibility coverage path. It returns no trusted predecessor identity and the incremental
resolver starts the next V2 chain at the current plan range.

V2 coverage uses `same runId && firstSequence <= sequence <= lastSequence`. Its endpoint
IDs must resolve to the indexed model-visible messages with matching sequences and the
first endpoint's anchor Turn. Every ToolProtocolUnit must be fully covered or fully
uncovered; a partial V2 protocol throws bounded `ContextPlanningError(INCONSISTENT_PLAN)`.

For V1, a partial affected ToolProtocolUnit removes none of that protocol's message IDs
from the coverage set, retaining the complete protocol in residual Context. This keeps the
ToolCall/ToolResult boundary whole without fabricating a V2 safe-cut guarantee.

Residual units and `ContextHistoryIndex.estimatedTokens` are rebuilt from unique
`ContextMessageRef.messageId` values. Overlapping Turn and ToolProtocol views therefore
contribute one token estimate per durable message.

## Canonical semantic summary source

`createContextSummarySourceSerializer()` exposes one frozen `SummarySourcePolicy`:

```text
includeAssistantText                 true
includeToolCalls                     true
includeToolResultProjectedContent    true
includeRawToolOutput                 false
includeHiddenChainOfThought           false
```

The serializer is pure, deterministic, provider-neutral, and storage-neutral. It emits
canonical JSON with source range, safe-cut provenance, security framing, optional recovery
memory, and complete allowed source messages.

Allowed source facts are:

- User text;
- User attachment reference metadata (`artifactId`, `label`, `mediaType`);
- Assistant text;
- Assistant ToolCall ID, name, and recursively redacted JSON-safe input;
- ToolResult identity/error metadata and durable `projectedContent`;
- StructuredCheckpoint recovery memory.

ToolResult observation references, provider opaque state, hidden reasoning, attachment
bytes, and any external lookup are excluded. Historical source is explicitly marked
`UNTRUSTED_DATA`. A previous checkpoint is framed as `RECOVERY_MEMORY` and
`NOT_CURRENT_AUTHORITY`. Credential-like strings (`password=`, `Bearer`, `sk-`, `rk-`,
`token=`, `secret=`, and `authorization=`) are deterministically redacted.

There is no message-count, part-count, benign-text, or serialized-source cap. The
compatibility `serializeContextSummarySource(ContextSummarizationInput)` wrapper delegates
semantic serialization to the canonical serializer and only adds the existing Phase 7D
authority/model/reason/target compatibility fields. It retains the existing one-attempt
runner and deterministic fallback behavior.

## Budget and gain policy

`createContextCheckpointBudgetResolver()` uses private deterministic policy constants:

```text
target = floor(effectiveInputLimitTokens * 0.05)
max    = min(floor(effectiveInputLimitTokens * 0.08), 8192, selectedTokens - 1)
target = min(target, max)
```

The resolver requires positive safe integer inputs, never returns zero, and treats an
impossible positive budget as a bounded unavailable-budget path. The gain evaluator uses
the conservative maximum checkpoint estimate:

```text
estimatedCheckpointTokens = maxTokens
estimatedFreedTokens      = selectedTokens - maxTokens
gainRatio                 = estimatedFreedTokens / selectedTokens
```

The ContextEngine's package-internal meaningful-gain gate requires positive freed tokens
and `gainRatio >= 0.15`. Insufficient budget or gain skips the semantic provider call.
No Protocol or user configuration constant was added for this initial policy.

## ContextEngine integration boundary

ContextEngine indexes the conversation once, resolves the incremental state, builds the
canonical coverage projection from the full index, and filters Context conversation source
items by covered message identity. On a planned compaction it resolves the checkpoint budget
and gain before requiring or calling the summarizer. A successful call receives only the
new model-visible messages, the cumulative source range, the safe cut, the recovery
checkpoint, and the checkpoint budget target.

The existing atomic compaction commit/event path remains authoritative. The committed V2
checkpoint uses the cumulative range and V2 predecessor ID. After commit, ContextEngine
rebuilds coverage from the full indexed history and the committed record, filters the
original collected source results through the same covered identity set, replaces the
checkpoint source, and keeps the existing single-compaction count and post-commit
notification ordering.

## Verification evidence

Focused Phase 8B and direct regression tests currently cover:

- canonical V2/V1 coverage, cross-Turn removal, partial-Turn residuals, protocol safety,
  unique token accounting, and identity validation;
- NONE/V2/LEGACY_V1 state and A→B→C cumulative source resolution;
- complete summary serialization, projected ToolResult content, attachment metadata,
  framing, redaction, deterministic output, and no-omission behavior;
- checkpoint budget and conservative gain evaluation;
- ContextEngine target-budget plumbing, new-source selection, cumulative checkpoint range,
  atomic commit, notification order, and post-commit filtering;
- Phase 7D, Phase 7F, and Phase 8A Context regressions;
- this Phase 8B architecture boundary guard.

The final Phase 8B focused matrix passed: 11 test files and 58 tests, including the new
coverage, serializer, budget/gain, engine, and architecture tests plus the Phase 7D, 7F,
and 8A regressions. The final repository gates also passed:

- `pnpm build`;
- `pnpm typecheck`;
- `pnpm lint`;
- `pnpm check:architecture:ci` with zero new violations and zero stale baseline entries;
- `node scripts/check-repository-hygiene.mjs`;
- targeted Prettier check for every Phase 8B source, test, and architecture-document file;
- `git diff --check`.

The repository-wide `pnpm format:check` remains a pre-existing baseline failure (487
unrelated files are reported by the current repository configuration); no broad formatting
rewrite was made. The Phase 8B task explicitly does not run the full `pnpm test` suite.

## Explicitly NOT STARTED in Phase 8B

The following remain future scope and are intentionally absent:

- `SemanticCheckpointDraft`;
- `SemanticSummaryValidator`;
- authority facts and authority enrichers;
- `ContextCompactionRebuilder` and true `tokensAfter` rebuilding;
- persistence idempotency or any new SQLite migration/schema/table;
- `ContextRecoveryPlanner`;
- `ContextCompactionCoordinator` or a new orchestration root;
- auxiliary Context compaction or financial/token budget ledger entries;
- provider adapter output-token projection or provider-result validation;
- final production Coordinator cutover and later Phase 8C–8F migration work.
