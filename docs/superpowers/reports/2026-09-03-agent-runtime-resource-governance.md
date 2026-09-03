# Caelush — Agent Runtime Resource Governance Verification Report

**Date:** 2026-09-03
**Status:** Local implementation and verification complete; remote delivery is not claimed.
**Branch:** `codex/runtime-resource-governance-refactor`
**Baseline:** `5f526ad90c0638c6e8bae342ad43c6b4f63cd7bd`
**Implementation HEAD before this report:** `cefc75e9958b3161af4427474dce6c94cc38dcba`

## Executive result

The approved Internal Tasks 1–8 resource-governance refactor is implemented on the task branch. The low fixed default Tool-call lifetime guard is replaced by a daemon-owned Adaptive resource policy with durable governance state, renewable operational leases, deterministic progress detection, safe replan boundaries, and a durable `WAITING_RESOURCE` Continue/Cancel boundary.

The implementation preserves the existing Core ownership of Run lifecycle, Tool Dispatcher ownership of execution, exact financial accounting, Security/Approval boundaries, Verification-driven completion, and the Phase 8 Runtime boundary. No Phase 14, MCP, Web Search, RAG, sub-agent system, new Phase 8 round, or new Phase 10/11 round was introduced. No sub-agent was used.

Local application and package verification passed. The final `pnpm check` command reached and passed lint, build, typecheck, and Vitest, but its repository-wide Prettier step failed on the existing formatting baseline: 737 files are already unformatted, including untouched files. Changed-file Prettier checks and `git diff --check` passed. The release artifact E2E and browser E2E passed.

## Root cause addressed

The legacy default combined normal operating capacity with a terminal lifetime ceiling:

```text
maxSteps = 8
maxToolCalls = 8
timeoutMs = 10_000
```

Consequently, a healthy workspace scan could consume eight Tool operations and then be rejected even when the requested next batch was valid and productive. The characterization fixture records the old behavior: four already-accounted Tool calls plus a five-call batch produces the legacy `TOOL_CALLS` hard-stop. The same accounting snapshot under Adaptive governance is admitted when it is within the per-turn batch bound and no hard enterprise limit is exceeded.

The refactor separates:

- exact financial/accounting limits from operational leases;
- per-provider-response Tool batch size from lifetime Tool operations;
- deterministic progress/no-progress governance from model claims;
- soft replan/pause boundaries from hard terminal ceilings; and
- provider-local timeout authority from an optional Adaptive hard Run deadline.

## Implemented architecture

### Protocol and compatibility

`@caelush/protocol` now owns the strict, JSON-safe `RunResourcePolicy` contract. It validates positive safe integers, optional hard ceilings, bounded policy structure, and explicit policy mode. Run creation accepts exactly one of `resourcePolicy` or legacy `limits`.

Legacy requests are normalized to `LEGACY_FIXED`:

- `maxSteps` becomes the hard Agent-Turn ceiling;
- `maxToolCalls` becomes the hard Tool-operation ceiling;
- `timeoutMs` remains the legacy hard Run deadline; and
- token and cost limits remain exact accounting ceilings.

Adaptive requests retain their canonical policy. Enterprise hard limits are intersected with the request and cannot be increased by the client. Compatibility `limits` values are derived for old consumers, while Adaptive deadline behavior uses the policy’s optional `hardLimits.maxWallClockMs` rather than an implicit ten-second timeout.

The daemon is the only owner of `DEFAULT_ADAPTIVE_RESOURCE_POLICY`:

```text
operational lease: 24 Agent Turns / 64 Tool operations
per-turn batch:    16 Tool calls
progress window:   8 Turns
nudge threshold:    3 identical no-progress repeats
replan threshold:   4 no-progress Turns
pause threshold:    2 unsuccessful replans
hard wall clock:    absent by default
```

The default configuration is published through `DaemonInfo`; CLI and Web consume the protocol projection and do not duplicate policy defaults.

### Durable resource state

Storage adds one `run_resource_states` row per governed Run through a committed SQLite migration. The repository exposes only protocol-safe data and supports `get`, `createOrGet`, and revision-checked compare-and-swap updates. Persisted state contains policy/mode, lease epoch and starting counters, consumed counters, progress/no-progress summary, replan count, guard state, bounded recent fingerprints, revision, and timestamps.

Raw Tool arguments, raw Tool output, provider payloads, credentials, hidden reasoning, and secrets are not stored in the governance row. Fingerprints are versioned bounded hashes. Storage recovery composes with the existing budget ledger recovery and does not double-count reservations or settled operations.

### Progress and loop detection

Core provides deterministic canonical hashing for Tool requests, Tool results, Tool batches, and Tool-result batches. The `ProgressLedger` stores bounded typed observations and the `ResourceLoopDetector` evaluates the policy thresholds. An identical request with an unchanged result is strong no-progress evidence; a changed result is new information. Similar-looking strings alone do not reject a request.

The escalation path is:

```text
HEALTHY → OBSERVE → NUDGE → FORCED_REPLAN → WAITING_RESOURCE
```

`NUDGE` is non-blocking. `FORCED_REPLAN` preflights and rejects the complete batch, dispatches zero handlers, and creates one safe synthetic result per requested call in source order. Replan results preserve Tool-call/result cardinality and remain model-recoverable. A repeated failed replan creates a durable resource guard; it never emits `budget.exceeded` and never directly completes or terminally fails the Run.

### Core and RunController

The Resource Governor is provider-independent and Tool-agnostic. AgentLoop remains a resumable decision loop and does not access Storage, Runtime, Dispatcher, Tool handlers, Approval resolution, or Verification execution. One settled provider response remains one Agent Turn.

RunController remains the canonical lifecycle owner. Resource state, Run, AgentState, AgentStep, continuation, conversation messages, and durable events are settled through the existing atomic execution boundaries. `WAITING_RESOURCE` stores the open Tool decision in a dedicated continuation, so Continue resumes the same pending decision and does not redispatch already-settled Tool invocations. Recovery does not auto-resume a resource guard.

The durable `resource.guard` event is intentionally bounded and contains only a safe reason, bounded replan count, and bounded requested-call count. It does not expose raw arguments, Tool results, revisions, costs, prompts, or internal causes.

### Timeout and long-running work

Adaptive policy defaults do not install the legacy global ten-second Run deadline. When an Adaptive hard wall-clock limit is configured, the deadline is still derived from the original `startedAt + maxWallClockMs`; PENDING Runs have no active deadline. Deadline scheduling remains Core-owned, ephemeral, injectable, rechecked after wake, chunked for long delays, and disarmed for PENDING/terminal/no-deadline Runs.

Provider-local timeout, Tool timeout, process observation, inactivity governance, and hard Run timeout remain distinct authorities. The existing Runtime process-session behavior remains intact: `yield_time_ms` is observation wait, not a kill timeout, and process sessions are not reattached through a new persistence table.

### Daemon, client, CLI, and Web

The daemon exposes `CONTINUE_RESOURCE` through the existing action path and adds `POST /api/v1/runs/:runId/continue-resource` with no request body. Client, CLI, and Web use the same protocol status/action semantics.

CLI print/control mode recognizes `WAITING_RESOURCE`, keeps the Run non-terminal, and exposes Continue while preserving Cancel. Web renders a bounded Resource Guard card with a safe Chinese explanation and Continue/Cancel actions. Neither surface renders lease counters, fake completion percentages, raw fingerprints, internal thresholds, or policy internals.

## Security and authority audit

- Tool execution still crosses only the Dispatcher; Core governance never invokes a concrete Tool.
- Resource policy metadata is not treated as Security authorization. Approval and permission checks remain in their existing boundaries.
- Verification remains the only route toward completion, and final candidates do not transition directly to `COMPLETED`.
- Adaptive lease renewal does not increase a monetary reservation or a hard cost ceiling.
- Enterprise hard-limit intersection is monotonic and prevents client-side limit increases.
- Public events, Client projections, CLI messages, Web state, and sanitized errors do not expose credentials, raw arguments, raw output, provider payloads, hidden reasoning, or internal abort causes.
- The existing `RunExecutionScope`/AbortSignal host-only boundary is unchanged; no signal was added to Protocol entities, durable governance state, continuation data, approval keys, Tool arguments, or events.
- The production daemon remains loopback-only and no permissive CORS behavior was added.
- No deep cross-package imports or provider SDK types were introduced into public contracts.

## Test evidence

### TDD and focused coverage

The implementation followed the approved sequence of failing focused tests, observed RED behavior, minimal implementation, and focused GREEN suites. Coverage was added for:

- fixed-budget regression characterization and Adaptive admission;
- policy validation, legacy mapping, ambiguity rejection, and Enterprise intersections;
- migration, repository persistence, CAS conflicts, bounded state, and recovery;
- canonical fingerprints, changed-result handling, bounded progress windows, and escalation;
- Resource Governor batch/replan/hard-limit behavior;
- Adaptive timeout separation and no-implicit-deadline behavior;
- bounded workspace discovery and context projection pressure;
- durable resource recovery and Continue semantics;
- daemon default/info and long-run E2E;
- Client, CLI, and Web Resource Guard controls; and
- release artifact compatibility and provider/package probes.

### Commands and results

| Command                                    | Result                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| `pnpm lint` (as part of `pnpm check`)      | PASS                                                   |
| `pnpm typecheck` (as part of `pnpm check`) | PASS                                                   |
| `pnpm build` (as part of `pnpm check`)     | PASS                                                   |
| full Vitest (as part of `pnpm check`)      | PASS — 346 files, 1353 passed, 5 skipped               |
| changed-file Prettier checks               | PASS                                                   |
| `git diff --check`                         | PASS                                                   |
| `pnpm test:web:e2e`                        | PASS                                                   |
| `pnpm test:release`                        | PASS — `artifact-e2e passed: 0.1.0`                    |
| repository-wide `prettier --check .`       | NOT PASS — existing baseline has 737 unformatted files |

The release E2E initially reported `Run ended with status FAILED` because a stale development daemon at `127.0.0.1:43120` intercepted the artifact launcher and returned the old fixed configuration. The exact stale process was verified as `D:\Develop\Caelush\apps\daemon\dist\main.js`, stopped, and the release E2E was rerun successfully. The artifact E2E diagnostic now includes both stdout and stderr when that assertion fails.

The global Prettier result is not attributed to this refactor: the changed-file checks passed, and the failure enumerated pre-existing repository formatting debt outside the changed set.

## Git and delivery status

The implementation was committed in small task-aligned commits:

```text
013332b docs(runtime): specify adaptive resource governance
d8c5f1e docs(runtime): plan resource governance refactor
443d630 test(runtime): characterize fixed resource budget failure
8c90efb feat(protocol): add adaptive run resource policy
56f666e feat(storage): persist resource governance state
655221c feat(core): detect no-progress execution loops
8bdd428 feat(core): add resource-aware replan boundaries
77de590 feat(runtime): add adaptive resource guard continuation
cefc75e test(runtime): seal adaptive resource governance
```

This report and the artifact-E2E diagnostic improvement are the final documentation/test-harness changes pending commit. The working tree must be rechecked after committing this report.

Remote verification is unavailable: `git fetch origin --prune` previously failed during the TLS handshake. No push, merge to `master`, or remote SHA equality is claimed. The local task branch and local verification seal are the deliverable for this round.

## Final limitations

- The repository-wide formatting gate remains red because of the pre-existing 737-file baseline; remediation of unrelated formatting was intentionally out of scope.
- Remote branch synchronization was not performed because the origin TLS handshake failed.
- Compatibility `AgentRun.limits` remains present for V1 consumers; Adaptive execution authority is the canonical `resourcePolicy`, not the derived compatibility projection.
- Phase 8, Phase 10, and Phase 11 boundaries remain in force. No retry/backoff, budgets beyond existing hard accounting, new sandbox, cancellation redesign, MCP, Browser/Computer Use, remote runtime, or additional completion phase was added.
