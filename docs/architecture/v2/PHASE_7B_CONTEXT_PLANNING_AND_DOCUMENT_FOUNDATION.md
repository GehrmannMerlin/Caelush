# Phase 7B — Context Planning, Semantic History Units & Context Document Foundation

Status: implemented on `main` from the Phase 7A revision.

Phase 7B establishes the pure, in-memory planning and semantic-document foundation inside
`@caelush/agent`. It does not switch the production Context runtime. The production path remains
`packages/core/src/legacy-context-runtime-adapter.ts` → `@caelush/context`.

## Canonical ownership

- `ContextSourceRegistry` and `ContextItem` remain the candidate-fact authority from Phase 7A.
- `ContextHistoryIndexer` consumes `AgentConversationSnapshot`, `ConversationTurn`,
  `StoredAgentMessage`, and the existing Message Domain Tool protocol rules to produce
  `ContextHistoryUnit` and `ToolProtocolUnit` views.
- `ContextPlanner` is the only Phase 7B selection authority. It consumes ContextItems, ContextPolicy,
  and optional semantic history. It performs no I/O, provider projection, Tool execution, persistence,
  Run transition, or Event publication.
- `ContextDocumentBuilder` turns the selected plan into immutable semantic sections. It preserves item
  identity in the section id and encodes source provider, version, and source reference in the section
  source reference. It does not produce provider `AIMessage[]`.
- `ContextBuildReceipt` remains an opaque foundation type. No receipt or plan persistence is introduced.

## Implemented semantics

The planner separates mandatory and elastic groups. `CRITICAL`, `PINNED`, `REHYDRATABLE`, the current
turn, and an open Tool protocol unit are protected. Explicit atomic groups and Message-Domain-derived
history groups are selected or dropped/deferred as a whole. Source caps are applied before total-budget
selection; unused source capacity remains available to the elastic pool. `RETRIEVABLE` material is
deferred before ordinary optional material when budget is tight.

Every input item receives a frozen `ContextItemDecision`. The frozen budget snapshot is computed from
the actual selection and retains the Phase 7A ModelDescriptor-derived effective input limit. When
protected non-current material exceeds the effective budget, the plan keeps the protected material and
reports `requiresCompaction`; it does not summarize, truncate, or mutate it. A pinned or current-turn
overflow raises a bounded typed error instead of silently dropping user intent.

`ContextDocument` is ordered by cache stability and authority, then retains deterministic plan/history
order. It contains semantic sections only; Materialization, provider translation, and prompt assembly
remain future responsibilities.

## Explicit boundary

Phase 7B does not implement:

- Coding Context Source migration;
- Context Materializer or provider `AIMessage` projection;
- semantic compaction or summary generation;
- Checkpoint V2, Rehydration V2, Context persistence, or receipt persistence;
- daemon, Core, CLI, Web, or AgentLoop production cutover;
- `@caelush/context` retirement;
- new RunEvents, a second Execution Authority, or a second persistence authority.

Phase 7C has not started.
