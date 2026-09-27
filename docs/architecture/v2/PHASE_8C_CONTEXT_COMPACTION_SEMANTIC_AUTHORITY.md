# Phase 8C — Context Compaction Semantic Summary and Deterministic Authority

## Scope and base

Phase 8C is implemented from the Architecture V2 source-of-truth at base
commit `dd06bf0335336cddd206e960e6177605204c3456` on `main`. The phase keeps
the Phase 8A pressure/safe-cut path and the Phase 8B cumulative source,
budget/gain, projected Tool-result, and atomic commit invariants intact.

This phase does not introduce a compaction coordinator, a rebuild protocol,
true post-compaction token accounting, a digest-freeze protocol, persistence
idempotency, a new table, or any Phase 8D–8F budget/recovery work.

## Ownership split

The semantic model may author recovery memory only. Current operational facts
remain outside the model and are collected after the semantic attempt:

- Agent owns the JSON-safe `SemanticCheckpointDraft`, bounded validation,
  summary outcome classification, the `DeterministicCompactionFacts` port, the
  pure fallback builder, the pure accepted-summary enricher, and the inline
  Context Engine orchestration.
- Coding Agent projects durable invocation, observation, and AgentState data
  into bounded coding facts. Only successful settled `read_file` observations
  contribute to `readFiles`; failed reads do not.
- Daemon owns infrastructure adapters: it calls the existing `AIGateway`
  directly for semantic JSON and composes Storage plus the Coding projector for
  deterministic facts.
- The existing `ContextAuthorityProviderPort` remains the current-authority
  overlay for final rehydration. Deterministic compaction facts are not cast to
  or reused as that authority snapshot.

## Semantic summary contract

`SemanticCheckpointDraft` contains exactly these nine fields:

`goal`, `constraints`, `completedWork`, `inProgress`, `blocked`,
`importantDiscoveries`, `keyDecisions`, `criticalReferences`, and `nextIntent`.

Authority fields (`readFiles`, `changedFiles`, `recentErrors`,
`verificationState`, `activeProcesses`, `pendingApprovals`, and
`resourceGovernance`) are rejected at the semantic boundary. The draft is
bounded, cloned, and deeply frozen. Its record envelope is V2, while the
embedded `StructuredCheckpoint.version` remains exactly `1`.

The Daemon adapter uses the current Run model, explicitly sends `tools: []`,
and asks for plain semantic JSON. Historical messages, projected Tool content,
and previous checkpoint data are framed as untrusted recovery input. The
adapter forwards the gateway's resolved `model` and actual `finishReason`.
The prompt/schema version is `2`.

`ContextSummarizationRunner` performs one attempt only:

1. check cancellation and compute the canonical source digest;
2. call the summarizer once;
3. classify the result;
4. return an accepted semantic result or a `FALLBACK_REQUIRED` classification.

`STOP` can be accepted only when the prompt version and exact bounded semantic
shape validate. `LENGTH` is `TRUNCATED`, `CONTENT_FILTER` is `FILTERED`, and
`TOOL_CALLS`/`OTHER` are `FAILED`. Malformed output is `MALFORMED`. Provider
failures do not trigger a second attempt. Cancellation propagates and never
manufactures a fallback.

Daemon parser/schema errors use the Agent-owned typed malformed boundary error,
so they cannot be confused with infrastructure `FAILED` outcomes.

## Deterministic authority and final checkpoint

The engine's compaction sequence is:

```text
summary attempt
  → collect current deterministic facts
  → accepted: ContextCheckpointEnricher
    fallback: DeterministicCheckpointBuilder
  → digest final StructuredCheckpoint
  → existing atomic checkpoint/event commit
  → fresh ContextAuthorityProvider snapshot
  → rehydrate, plan, and materialize
```

The accepted enricher copies only semantic fields from the model and takes all
authority fields and the cumulative source range from current facts/input. The
fallback builder uses the current Run goal, may retain only explicitly allowed
semantic memory from the previous checkpoint, replaces every authority field
with current facts, and adds the stable degraded marker:

`Semantic summarization was unavailable; continue from deterministic durable state.`

Facts infrastructure failures propagate; they are not represented as a
successful degraded checkpoint. An already-aborted signal, cancellation during
summary, and cancellation after summary but before facts all stop before facts
or commit. No-compaction preparation still performs exactly one final fresh
authority snapshot immediately before rehydration.

## Deterministic fact sources and security boundary

The Daemon facts adapter reads existing durable repositories for Tool
invocations/observations, AgentState, pending approvals, verification plans,
and resource governance. It formats only bounded safe summaries. It never
reads raw artifact content. The Coding projector does not expose Tool
arguments, observation content, raw artifact references, or arbitrary error
details; error text is redacted and bounded before it enters facts.

`readFiles` is derived from completed `read_file` invocations paired with a
non-error Tool observation whose safe details include a path. Changed files,
recent errors, active processes, pending approvals, verification state, and
resource governance retain their respective durable authority owners.

## Validation evidence

The focused Phase 8C plus required regression matrix passed with 15 test files
and 72 tests. The complete Agent Context regression passed with 24 test files
and 121 tests. These tests cover semantic shape/immutability, finish-reason and
malformed classification, one-attempt and cancellation behavior, facts bounds,
accepted enrichment, stale-authority replacement in fallback, Coding fact
projection, Daemon gateway/facts adapters, and Context Engine authority timing.

The repository gates also passed: `pnpm build`, `pnpm typecheck`, `pnpm lint`,
architecture CI with zero new and zero stale violations, repository hygiene,
and a targeted Prettier check over all Phase 8C changed files. The global
`pnpm format:check` still reports the repository's pre-existing 487-file
formatting baseline; those unrelated files were intentionally not reformatted.
