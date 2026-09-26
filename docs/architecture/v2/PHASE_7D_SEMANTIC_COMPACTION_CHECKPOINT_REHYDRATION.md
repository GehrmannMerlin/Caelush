# Architecture V2 Phase 7D — Semantic Compaction, Checkpoint V2, Authority Rehydration, and Materialization Closure

Status: complete as a parallel target path. The production Context path remains
`Core -> LegacyContextRuntimeAdapter -> @caelush/context`.

## Scope and ownership

Phase 7D closes the target-path seam from semantic history through provider-neutral
`AIMessage[]` materialization. `@caelush/agent` owns the generic contracts and pure
implementations; `@caelush/storage` owns the SQLite adapter for the Agent checkpoint
repository port. The daemon, Core, CLI, Web, and coding-agent production composition
are not wired to this path in Phase 7D.

The Agent Context implementation has no filesystem, Runtime, Storage, legacy Context,
Coding Agent, daemon, client, provider SDK, or SQLite dependency. Storage depends on
the public Agent contracts in the allowed direction; Agent does not depend on Storage.

## Semantic compaction

`ContextCompactionPlanner.plan({ history, policy, reason })` is pure, deterministic,
and in-memory. Its public reason vocabulary is exactly:

- `PROACTIVE_PRESSURE`
- `SELECTION_PRESSURE`
- `FORCED_PROVIDER_OVERFLOW`

The planner canonicalizes overlapping Conversation Turn and Tool Protocol views by
durable message identity. It selects the oldest eligible `CLOSED` semantic units first,
keeps Tool call/result units atomic, protects OPEN units and the current/latest turn,
and preserves the policy's recent-tail and minimum-tail thresholds. A plan carries a
single `ContextMessageRange`; it never fabricates a cross-turn identity. Durable message
IDs and `StoredAgentMessage.sequence` values are the source identity.

Checkpoint coverage preparation is a separate target-path helper so the frozen Planner
signature does not grow a `latestCheckpoint` argument. A V2 checkpoint's covered range
is removed from the next candidate history. A V1 checkpoint can provide auxiliary
recovery context, but cannot become the trusted `previousCheckpointId` of a V2 chain.

## Checkpoint payload and V2 envelope

`StructuredCheckpoint` remains payload version `1` and is now a canonical immutable
contract. Its payload preserves goal, constraints, progress, discoveries, decisions,
files, errors, verification, process, approval, governance, references, next intent,
and the compatibility `sourceRange.from/to`. In V2, those two numbers mean durable
`StoredAgentMessage.sequence` values. The authoritative identity is the envelope's
`ContextMessageRange`, containing Run ID, conversation-turn ID, first/last message IDs,
and first/last sequence.

`ContextCheckpointRecordV2` adds schema version 2, optional trusted V2 parent, source
range, structured payload, token estimates, AI `ModelRef`, summary prompt version,
source/checkpoint digests, degraded state, compaction reason, and creation time. The
V2 record is immutable: the target repository has no `updateTokensAfter` operation.
The existing table is reused without a first-wave migration: `summary_version = 2`,
the source sequence columns mirror the range, and the remaining V2 envelope metadata
lives in a versioned `data_json` envelope. The legacy V1 repository and its production
`updateTokensAfter` surface remain available for compatibility and are restricted to
V1 rows.

## One summary attempt and fallback

The summarization runner passes semantic `StoredAgentMessage[]` to the injected
`ContextSummarizerPort`. Its bounded deterministic serializer includes durable
identity, projection version, safe text, and Tool metadata while omitting raw Tool
observations, full artifact bodies, provider state, runtime objects, and credentials.
Source and checkpoint digests are canonical SHA-256 digests over the stable semantic
representation.

There is exactly one summarizer call. A successful call produces `degraded = false`.
A non-cancellation failure produces a deterministic minimal checkpoint with current
authority facts and the source range, and returns `degraded = true`. Cancellation is
propagated and never converted into a fallback summary. The runner does not invoke an
AgentLoop, Tools, retrieval, approval, verification, retry loop, fallback model, or
second provider. No daemon summarizer composition is added in this phase.

## Authority rehydration

`ContextAuthoritySnapshot` is supplied by the host through a narrow async port, but
rehydration itself has no side effects. `Summary remembers; Authority decides`:
authority values take precedence over checkpoint values, and `undefined` means “use
the recovery value” while an explicit empty array means “the current authoritative
collection is empty.” The output is immutable `RehydratedContextState`.

`ContextDocumentBuilder` renders current authority overlays with an explicit
`AUTHORITATIVE CURRENT STATE` label. Checkpoint sections are rendered as
`RECOVERY SUMMARY (NON-AUTHORITATIVE)`. This keeps contradictory states, such as a
current verification result and an older recovery verification result, visible without
letting a recovery summary silently override live authority.

## Materialization closure

`ContextMaterializer.materialize({ prepared, model, signal })` emits only provider-neutral
`AIMessage[]`:

1. the deterministic system/context document;
2. selected historical conversation projected by the recorded
   `modelProjectionVersion` through `AgentMessageProjectorRegistry`;
3. selected reference/contribution context represented by the document;
4. the current/latest turn and OPEN Tool protocol at the tail.

Hidden model-audience messages are omitted. Closed Tool call/result sequences stay
atomic and ordered. Projectors cannot emit system messages by their public return type,
so system injection remains solely the Materializer's responsibility. Cancellation is
checked before work and between projections; partial messages are never returned.

## Production compatibility and phase boundary

Phase 7D adds no RunEvent, no Event-driven compaction control, no durable atomic
compaction commit port, and no production Engine V2 cutover. It does not implement
Artifact V2, Usage V2, final receipt/fingerprint authority, provider-overflow authority
cutover, or Context facade retirement. Those remain later work. Phase 7E has not
started; the planned order after this phase remains 7E, 7F, then 7G.
