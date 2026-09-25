# Phase 7A — Context Kernel Foundation & Source Registry

Status: foundation implemented; production Context cutover is intentionally deferred.

Phase 7A establishes the parallel target foundation in `@caelush/agent` without
changing the production Context composition. The frozen `ContextEnginePort`,
`ContextPrepareInput`, and `PreparedModelContext` remain the existing AgentLoop
boundary. The daemon and Core continue to use `LegacyContextRuntimeAdapter`
over `@caelush/context` until the fixed later rounds.

## Canonical foundation

The Agent package now owns the following Phase 7A contracts from its public root:

- branded `ContextFingerprint`, `ContextItemId`, `ContextSourceId`, and
  `ContextArtifactId` values;
- `PreparedAgentContext` as the semantic foundation contract;
- validated, immutable `ContextItem` values with source/version provenance,
  retention, priority, budget, cache, freshness, sensitivity, atomic-group and
  payload metadata;
- `ContextPolicy`, derived from `ModelDescriptor` limits plus host policy and
  request overhead;
- `ContextTokenEstimatorPort` and a provider-neutral UTF-8 fallback estimator;
- `ContextRequestOverheadEstimatorPort`, where tool schemas are request
  overhead rather than selectable ContextItems;
- `ContextSourceProvider`, registration and result contracts;
- deterministic immutable `ContextSourceRegistry` construction and sequential
  Required/Optional source collection semantics.

The old Phase 3 text-only Provider item remains available as
`LegacyContextItem`. It is an explicit compatibility seam for the existing
Provider/Hook and Coding prompt paths; it is not the Phase 7A Kernel item and
does not make the legacy production Context runtime consume the new Kernel.

## Authority and boundary rules

- `ModelDescriptor.limits.contextWindowTokens` and
  `ModelDescriptor.limits.maxOutputTokens` are the only intrinsic model-window
  authority in the new Kernel.
- `effectiveInputLimitTokens` is the model context window minus output reserve,
  safety reserve, and request overhead.
- Tool schema overhead is deterministic, provider-neutral, and network-free.
- Source collection is sequential and ordered by registration priority followed
  by deterministic source-id comparison.
- Required source failures fail closed; non-abort Optional failures become a
  bounded safe diagnostic; cancellation propagates.
- The new Context Kernel has no dependency on filesystem, Runtime, Storage,
  Coding Agent, legacy Context, provider SDKs, or host applications.

## Deliberately not implemented

The following remain fixed for later rounds and are not part of this foundation:

`ContextPlanner`, semantic History Units, `ContextDocumentBuilder`,
`ContextMaterializer`, Coding Context Source migration, semantic compaction,
Checkpoint V2, Authority Rehydration, Artifact/Usage/Receipt persistence,
Daemon production cutover, and `@caelush/context` retirement.

## Current legacy consumer inventory

These production files still depend on `@caelush/context` by design and form the
baseline for later migration rounds:

- `apps/daemon/src/daemon-composition.ts`
- `apps/daemon/src/routes/execution.ts`
- `packages/core/src/agent-error-mapper.ts`
- `packages/core/src/agent-loop-input.ts`
- `packages/core/src/agent-loop-ports.ts`
- `packages/core/src/agent-loop-request.ts`
- `packages/core/src/agent-tool-batch.ts`
- `packages/core/src/legacy-context-runtime-adapter.ts`
- `packages/core/src/llm-token-estimator.ts`
- `packages/core/src/run-agent-execution.ts`
- `packages/core/src/run-controller-ports.ts`
- `packages/core/src/verification-profile-provider.ts`

This inventory is intentionally non-zero in Phase 7A. Removing or rewriting it
belongs to the fixed production cutover and retirement rounds.
