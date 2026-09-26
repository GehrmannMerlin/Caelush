# Architecture V2 — Phase 7G Context Engineering Final Acceptance

Status: COMPLETE on `main`.

Phase 7G is the final Context Engineering V2 migration boundary. It retires the
legacy `@caelush/context` package and leaves the Agent V2 Context Engine as the
only production Context authority. The earlier Phase 7A–7F documents remain
historical migration records; where they describe a compatibility package or
legacy adapter as present, this acceptance record supersedes that statement for
the current source tree.

## Final ownership

```text
Agent V2 Context Engine
  ├── generic Context contracts, source planning, materialization and receipts
  ├── bounded token estimation, compaction and checkpoint semantics
  ├── V1 checkpoint decode compatibility and V2 checkpoint production writes
  └── Context Contribution projection at the Agent/Core boundary

Coding Agent
  ├── Runtime-backed local Context ports and bounded project instructions
  ├── Runtime-backed Project Intelligence
  │     ├── root detection and workspace scope
  │     ├── ecosystem, language, package-manager and tooling evidence
  │     ├── root/active package scripts and monorepo facts
  │     └── bounded instruction discovery and environment facts
  └── Coding Tool catalog, operations, security metadata and feedback hooks

Core
  ├── Run lifecycle and model/Tool turn integration
  ├── narrow structural Project Intelligence → Verification profile mapping
  └── compatibility helpers that do not create a second Context authority

Daemon
  ├── the only production composition root
  ├── per-Run V2 Context Engine composition
  └── Protocol Context Usage projection and public API boundary

Storage / Protocol
  ├── Storage persists V2 checkpoints, usage and atomic compaction facts
  └── Protocol owns the stable JSON-safe Context Usage API shape
```

The bounded Tool observation projection is owned by the Agent Tool observation
layer. Core may retain a compatibility conversion helper, but it delegates to
that canonical projector; the daemon injects the same projector into the model
feedback pipeline. No raw Tool output, artifact pointer, provider state, or
hidden reasoning enters the model-facing contract.

## Retirement result

- `packages/context` has been physically removed from the workspace.
- Core's `legacy-context-runtime-adapter.ts` and the retired Core AgentLoop
  compatibility source are removed from production.
- Core and daemon manifests no longer depend on `@caelush/context`.
- `pnpm-lock.yaml` contains no Context package importer or dependency entry.
- The production source scan has zero live `@caelush/context` imports and zero
  `packages/context` paths. Historical migration documents may still mention the
  old package as historical evidence.
- The daemon constructs the Agent V2 Context Engine through
  `createDaemonV2ContextEngine`, and no CLI/Web host constructs an Agent, Runtime,
  Provider, Tool executor, Storage service, or second Run state machine.

## Compatibility and preserved behavior

The retirement changes package ownership, not the external behavior frozen by
the earlier Context rounds:

- V1 checkpoint records remain a decode/replay compatibility input; new
  production compaction persists V2 checkpoint records and durable compaction
  facts through Storage's atomic boundary.
- Context Usage continues to use the existing Protocol
  `ContextUsageProjection`/`ContextUsageResponse` API shape.
- Coding project intelligence is bounded, Runtime-contained and reused by the
  Verification profile provider rather than duplicated in Core or Verification.
- Tool results preserve one-result-per-call ordering, safe feedback semantics,
  bounded content, and the existing observation provenance behavior.
- Context Contributions remain bounded, redacted, non-durable prompt input and
  are not converted into ordinary conversation records or Tool messages.
- Verification evidence remains evidence: only Core/RunController may authorize
  a completed Run.

## Acceptance gates

Phase 7G acceptance is represented by:

- `tests/architecture/phase-7g-context-retirement.test.ts`;
- focused Agent Tool observation projector tests;
- focused Coding Agent Project Intelligence tests;
- focused Core Verification profile mapping tests;
- package-boundary, workspace-shape and prior Architecture V2 boundary tests;
- architecture CI, build, typecheck, test, lint, format and hygiene checks
  recorded in the implementation handoff.

No later architecture phase is implied by this document. Any future work must
be a separately authorized feature or architecture change and must preserve the
single Agent V2 Context authority established here.
