# Architecture V2 — Phase 7F Context Production Daemon Cutover

Status: Phase 7F implementation boundary. This document records the production cutover and does
not claim final Context V2 acceptance or begin Phase 7G.

## Scope

Phase 7F moves the daemon's active Agent turn path behind the frozen
`ContextEnginePort`. The target path is an Agent-owned V2 engine composed by the daemon with
Coding Context adapters and Storage ports. `packages/context` remains present as a compatibility
facade for consumers that have not yet migrated; it is no longer the production prompt,
selection, compaction, or Context persistence authority for Agent turns.

The phase does not delete the legacy Context package, redesign the frozen Agent seam, create a
second conversation authority, or start the final Context V2 acceptance work reserved for Phase 7G.

## Production path

For each Run-bound Context Engine, `apps/daemon/src/context/v2-context-composition.ts` constructs
an immutable Source Registry and injects:

- the Agent-owned V2 `ContextEngine`;
- the resolved model descriptor as the budget authority;
- the request-overhead estimator, semantic history indexer, planner, compaction planner,
  rehydrator, document builder, materializer, receipt builder, and injected clock;
- the Storage V2 checkpoint repository, usage store, and atomic compaction commit port;
- the existing V2 artifact store remains the only artifact identity/projection authority for
  attachment or other large-content references; this bounded production source set does not create
  a new artifact because it never loads raw historical Tool output;
- the daemon's existing Run Event notifier;
- one summarization runner over the existing AI gateway.

`daemon-composition.ts` now calls this factory from `createContextEngine`. It no longer constructs
`createLegacyContextRuntimeAdapter`, `createDefaultContextBuilder`, or
`createLocalRelevantFilePlanner` for the active turn path, and it no longer creates a synthetic
`historyPrefix` authority. Core receives an empty, narrow compatibility view for the pre-V2 Tool
observation fallback; it has no legacy Context assembly, selection, compaction, checkpoint, usage,
or provider-retry capability. Usage reads use the V2 store and are projected only at the daemon API
boundary for the existing UI contract.

## Source registry

The registry is immutable, priority-ordered, and deterministic. Generic Agent sources are:

`agent.core-policy`, `agent.conversation`, `agent.checkpoint`, `agent.memory`,
`agent.extension-contributions`, and `agent.branch-context`.

Coding sources are:

`coding.workspace`, `coding.runtime-facts`, `coding.project-instructions`,
`coding.project-metadata`, `coding.relevant-files`, `coding.skill-catalog`, `coding.git-state`,
`coding.verification-repair`, and `coding.temporal`.

The daemon's local Coding ports use `Runtime.openWorkspace()` for workspace containment, bounded
instruction and file reads, realpath checks, path resolution, discovery, Git facts, sensitive-file
filtering, explicit-path preference, and deterministic goal-aware ranking. Source providers own
their bounded validation. Required-source failure fails closed; optional-source failure contributes
only a bounded diagnostic.

The existing base system policy is now the required, pinned, critical, stable, secret-safe
`agent.core-policy` item. It is rendered by the V2 document builder and materialized once as the
single AI system-message boundary.

## Preparation and compaction

Preparation follows one sequence:

1. reject cancellation and derive request overhead/policy from the resolved `ModelDescriptor`;
2. load the latest checkpoint and collect all registered sources;
3. index semantic history and create the initial plan;
4. snapshot current authority (goal, changed files, approvals, active process projection,
   verification, resource governance, and project facts);
5. compact closed semantic candidates when history or policy pressure requires it, or when the
   loop requests forced recovery;
6. re-plan from the new checkpoint, uncompacted tail, and current sources;
7. rehydrate current authority over checkpoint state, build the document, materialize once, and
   produce the receipt/report/usage/fingerprint from the same final facts.

The summarizer makes one gateway attempt and never retries. Non-cancellation failure is converted
by the Agent summarization runner into a deterministic minimal degraded checkpoint. Cancellation
propagates. Forced recovery uses the tighter injected tail/source policy and fails with
`CONTEXT_EXHAUSTED` when the known final materialization cannot fit.

## Durable compaction boundary

V2 checkpoints carry durable Run/turn/message-range identities and sequence values. The daemon
does not write them directly. The Agent engine submits the checkpoint and the metadata-only
`context.compaction.completed` draft to `ContextCompactionCommitPort`; Storage commits both in one
SQLite transaction and assigns durable event sequence. Only after the commit returns does the
engine call `RunEventNotifierPort.notifyCommitted`.

The event payload records only checkpoint identity, reason, covered sequence range, bounded token
estimates, and degraded status. It does not contain summary text, prompt content, Tool arguments,
provider state, or hidden reasoning. The checkpoint remains the Context authority.

## Compatibility facade and remaining boundary

The old Context package remains available because a small set of compatibility and presentation
consumers still use its types: project inspection for the Verification assembly, the legacy usage
projection used by the daemon API boundary, and Core's frozen compatibility type declarations.
Those consumers are not allowed to feed the production Agent turn path. Phase 7G owns the remaining
facade retirement, final historical Context reconciliation, and the final Context V2 acceptance
decision. Until then, this repository intentionally does not claim that all legacy Context
consumers have disappeared.

## Evidence

The cutover is guarded by:

- `tests/architecture/phase-7f-context-production-cutover.test.ts`;
- Agent normal-preparation and compaction/atomic-notification tests in
  `packages/agent/test/context/phase-7f-engine.test.ts`;
- the existing Phase 7E persistence-boundary tests, updated to permit the now-required daemon
  injection of the Agent-owned receipt builder while continuing to forbid duplicate stores and
  event writers.

The full validation result and commit identity belong to the task handoff, not to this static
architecture note.
