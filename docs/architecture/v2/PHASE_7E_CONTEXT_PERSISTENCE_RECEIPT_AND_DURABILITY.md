# Phase 7E — Context Persistence, Receipt, Usage, and Durability

Phase 7E freezes the persistence-facing boundary for the Context Engineering V2 target path. It
does not replace the production Context runtime. The legacy
`LegacyContextRuntimeAdapter → @caelush/context` path remains the active compatibility path until a
later phase owns the full production assembly cutover.

## Ownership

`@caelush/agent` owns the JSON-safe domain contracts and pure projections:

- `ContextArtifact` metadata/content contracts and the `ContextArtifactStorePort`.
- `ContextBuildReceipt`, source selection receipts, and compaction receipts.
- `ContextUsageSnapshot` and the `ContextUsageStorePort`.
- `ContextCompactionCommitPort`.
- The deterministic, secret-free Context fingerprint and the receipt/report/usage builder.

The Agent builders consume facts that have already been collected by the Context target path. They
do not recollect sources, rerun planning or materialization, read SQLite, call a provider, or put
raw selected content into receipts, reports, usage, or fingerprints. `ContextBuildReport` remains
the kernel-facing compatibility contract and records the truthful request overhead used by the
build.

`@caelush/storage` implements the ports over the existing first-wave tables. It owns SQLite
decoding, fail-closed validation, content hashing, run-scoped artifact identity, usage envelope
encoding, and atomic persistence. The Agent package has no Storage dependency.

## Artifact and usage persistence

Phase 7E does not add receipt, fingerprint, or usage-event tables. Artifact V2 uses the existing
`context_artifacts` table. New artifact identities are deterministic and run-scoped; the content
hash is calculated from the exact UTF-8 content. An explicit artifact ID is accepted only when its
stored ownership and semantic metadata match. Legacy artifact IDs remain readable through the
existing repository.

Usage V2 uses the existing `context_runtime_states` row and stores a versioned source-ID breakdown
envelope in its JSON field. The compatibility columns continue to expose the current model and
window values, while the V2 read path returns the complete immutable source breakdown, build status,
compaction count, fingerprint, and timestamp. Source entries are decoded and returned in stable
order; malformed or incompatible envelopes fail closed.

## Atomic compaction commit

`SqliteContextCompactionCommitStore.commit({ checkpoint, events })` is the Storage implementation of
the compaction commit port. It performs the following operations in one SQLite transaction:

1. Validate checkpoint ownership and source-range consistency.
2. Write the immutable V2 checkpoint using the same envelope and validation helper as the standalone
   V2 checkpoint repository.
3. Append durable event drafts through the existing authoritative event-sequence helper.
4. Commit both facts together.

Checkpoint validation failures, durable-event schema failures, and cross-Run ownership mismatches
roll back the checkpoint row and the `event_sequences.last_sequence` change. Live subscribers are
not notified by Storage; notification remains the daemon's post-commit responsibility. The commit
adapter therefore does not create a second event writer or observation surface.

## Fingerprint and recovery facts

The Context fingerprint includes model identity and limits, policy identity, selected item identity,
conversation message IDs and projection versions, tool definitions, turn input identity, optional
checkpoint identity, and renderer/materializer versions. It excludes raw message content, secrets,
workspace paths, provider credentials, and exception text. Any change to the selected source set,
tool set, policy, projection version, checkpoint, or renderer/materializer version produces a
different fingerprint.

The receipt carries the same fingerprint as `PreparedAgentContext.contextFingerprint`. Its source
entries identify selected, dropped, and deferred item IDs plus provider versions. Its budget,
pressure, tool-schema, materialized-token, checkpoint, and compaction fields are projections of
facts already computed for that build. Usage is a persistence projection of those same facts, not a
second budget authority.

## Boundary guardrails

- Agent Context remains free of Storage, Runtime, legacy Context, provider SDK, daemon, and UI
  dependencies.
- Storage implements Agent ports and retains the legacy repositories for compatibility.
- Core/daemon production composition is unchanged in Phase 7E; there is no new ContextEngine, Run
  state machine, provider turn, or daemon-owned receipt writer.
- Durable checkpoint and event truth is committed before any live observation can be notified.
- Phase 7F and Phase 7G behavior is outside this phase: no production Context cutover, new hook
  surface, recovery policy expansion, or Tool/observation feedback migration is introduced here.
