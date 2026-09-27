# Phase 8D — Context Compaction Rebuild and Persistence

Status: implemented on `main` from base `40c40ef74fc7d630b2d838062c9f7410581a249f`.

Phase 8D closes the gap between the planner's retained-token estimate and the
tokens actually produced by the Context materializer. It adds a tentative,
Agent-owned rebuild before durable checkpoint commit, binds the resulting V2
checkpoint to deterministic source and checkpoint digests, and makes Storage
replay safe without introducing a second Context or Event authority.

## Defect addressed

Before Phase 8D, the compaction planner's `retainedTokens` value was persisted
as `tokensAfter`. That value described the planner's retained Context items,
not the materialized model input. A checkpoint could therefore be committed as
fitting while the real materialized input still exceeded the effective input
limit.

Phase 8D defines `tokensAfter` as the estimate reported by the same production
materializer and receipt estimator used by the final Context build. The
candidate is checked against the effective input limit before the checkpoint
or its completion event is committed.

## Agent-owned tentative rebuild

`ContextCompactionRebuilder` is a provider-neutral Agent contract. Its frozen
input is:

```text
conversation
checkpoint
sourceRange
policy
model
```

The rebuilder has no Storage, SQLite, daemon, summarizer, commit, usage, or
notifier dependency. The production Engine supplies a private closure through
the factory. That closure invokes the shared no-compaction build path:

```text
planner
  -> rehydrator
  -> document builder
  -> selected conversation messages
  -> provisional receipt
  -> materializer
  -> audit receipt / estimatedInputTokens
```

The final build uses the same path. The candidate result also returns the
selected durable message IDs for auditability; it never writes usage, emits an
event, or mutates the active checkpoint.

## Authority ordering and candidate projection

After semantic summary and deterministic facts are produced, the Engine takes a
tentative authority snapshot. It then builds an immutable candidate checkpoint
projection and applies the same range-coverage algorithm used for a committed
checkpoint. The candidate rebuild/materialization runs before commit:

```text
summary/facts
  -> tentative authority snapshot
  -> candidate coverage and checkpoint projection
  -> ContextCompactionRebuilder
  -> fit check
  -> atomic checkpoint + completion-event commit
  -> fresh authority snapshot
  -> final shared build/materialization
```

If the candidate is oversized, the Engine does not commit it and retains the
previous active checkpoint/source projection. A successful compaction has two
authority snapshots (tentative and post-commit); a non-compaction preparation
has one.

## Durable `tokensAfter`

For a successful compaction:

```text
checkpoint.tokensAfter
  == tentative materialized receipt estimate
```

It is deliberately not assigned from `compactionPlan.retainedTokens`. The
candidate fit decision and the persisted field use the same rebuilt estimate.
The final materialization is performed again after commit so the returned
Context reflects the newly authoritative checkpoint and fresh authority state.

## Durable digest definitions

The Agent digest builder uses the stable version
`context-checkpoint-v2-digest-v1`.

### `sourceDigest`

The durable source digest is an outer envelope over:

- the semantic source digest produced by the Phase 8C summary source
  serializer;
- the predecessor V2 checkpoint ID, digest, and source range, or `null`;
- each newly covered durable message ID, sequence, message schema version, and
  model projection version, sorted deterministically;
- the new incremental source range; and
- the cumulative source range represented by the checkpoint.

This keeps semantic content and durable source identity bound together without
making Storage interpret conversation history.

### `checkpointDigest`

The checkpoint digest covers exactly the digest version, schema version `2`,
the source range, and the structured checkpoint. It intentionally excludes
the checkpoint ID, creation time, and token estimates so those persistence
metadata values do not alter the semantic checkpoint identity.

## V2 immutability and repository idempotency

`SqliteContextCheckpointRepositoryV2` checks an existing row by checkpoint ID
before insertion:

- an exact immutable V2 record returns the existing decoded record;
- a V2 record with any differing immutable field raises `StorageConflictError`;
- a V1 row using the same ID also raises `StorageConflictError`.

The comparison covers identity, Run, schema, predecessor, source range,
structured checkpoint, token estimates, model reference, prompt version,
digests, degraded state, reason, and creation time. There is no update path and
no `tokensAfter` patching path in the V2 implementation.

## Atomic commit and replay proof

The Context compaction commit store writes the V2 checkpoint and durable
completion event in one SQLite transaction. A failure rolls both back.

When an exact V2 checkpoint already exists, the commit path does not append a
second event. It queries durable completion events for the same Run and
checkpoint ID and requires exactly one matching event whose completion payload
agrees with the checkpoint's reason, source range, `tokensBefore`,
`tokensAfter`, and degraded flag. Missing, duplicate, or mismatched proof
fails closed with `StorageConflictError`.

The replay result therefore returns the existing checkpoint and no newly
committed events. Live notification occurs only for newly committed events;
idempotent replay cannot duplicate notifier delivery.

## Restart behavior and crash-window boundary

After a process restart, a durable V2 checkpoint can be reused only when its
immutable row and its unique completion event proof are both present. A row
without exactly one matching completion fact is treated as a conflict rather
than being silently repaired or re-emitted. SQLite transaction rollback keeps a
partial first commit from becoming visible.

Provider I/O crash recovery is intentionally not solved by Phase 8D. Provider
request replay, external side effects, and a recovery planner belong to later
execution/recovery phases. Phase 8D only makes the Context checkpoint and its
durable completion fact atomic and exactly replayable.

## Explicit non-goals

Phase 8D does not introduce:

- `ContextCompactionCoordinator`;
- `ContextRecoveryPlanner`;
- an `AUXILIARY_LLM` budget kind;
- `ContextCompactionAttempt` or a new table, column, or migration;
- a second Context preparation authority;
- a second durable Event writer or EventBus;
- Phase 8E recovery orchestration; or
- Phase 8F final acceptance policy.

## Validation evidence

The focused Phase 8D/8A–8C and Storage regression matrix passed:

```text
20 test files, 161 tests passed
```

The required static gates passed:

```text
pnpm build
pnpm typecheck
pnpm lint
pnpm check:architecture:ci
node scripts/check-repository-hygiene.mjs
targeted Prettier --check
git diff --check
```

Architecture output reported zero new violations, zero stale baseline entries,
and `Readiness: READY`.
