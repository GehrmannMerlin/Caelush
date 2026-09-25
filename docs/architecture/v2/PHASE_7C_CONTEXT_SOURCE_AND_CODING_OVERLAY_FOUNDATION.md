# Phase 7C — Context Source Provider Migration & Coding Context Overlay Foundation

Status: implementation verified; production cutover intentionally pending.

Phase 7C establishes the target Context Source layer without changing the
production Context composition. The source layer is a parallel target path for
the later Context Engine and Materializer rounds.

## Scope and authority

The source of truth for this round is the current `main` source tree, followed
by the Context Engineering V2 Current → Target Interface Freeze, the Context
Engineering V2 Refactor Specification, and the Phase 7A/7B foundation
documents. The Phase 7C implementation must reconcile against current source
facts without widening the round.

The canonical Phase 7C base is the Phase 7B commit
`e70e6c80abe7a4fbeec61dbce2a6af22571b30df` on `main`.

The implementation boundary is:

```text
ContextSourceProvider
        ↓
ContextItem[]
        ↓
ContextSourceRegistry
        ↓
ContextPlanner
        ↓
ContextDocument
```

The boundary stops before `ContextMaterializer`, provider protocol messages,
production `ContextEngine` orchestration, and AgentLoop cutover.

## Ownership model

### Generic Agent Context

`@caelush/agent` owns generic source contracts and providers. The Generic
Context layer knows only durable Agent facts and safe injected data ports. It
does not know Coding Agent types, the filesystem, Runtime implementations,
Storage, Security implementations, Memory implementations, hosts, or provider
SDKs.

The frozen Generic Source IDs are:

```text
agent.conversation
agent.checkpoint
agent.memory
agent.extension-contributions
agent.branch-context
```

### Coding Context Overlay

`@caelush/coding-agent` owns Coding-specific source factories and narrow input
ports. Coding providers translate workspace, project, retrieval, runtime,
Git, verification, skill-catalog, and temporal facts into the generic
`ContextItem` contract. They do not expose Coding-specific types to the Agent
Context Kernel.

The frozen Coding Source IDs are:

```text
coding.workspace
coding.runtime-facts
coding.project-instructions
coding.project-metadata
coding.relevant-files
coding.skill-catalog
coding.git-state
coding.verification-repair
coding.temporal
```

There is no default global registry containing both families. The host or
product composition registers providers explicitly with priorities and
criticality.

## Frozen provider contract

All providers implement the existing `ContextSourceProvider` contract:

```ts
interface ContextSourceProvider {
  readonly id: ContextSourceId;
  collect(input: ContextSourceInput): Promise<ContextSourceResult>;
}
```

The provider receives the already-frozen `ContextSourceInput` shape. Phase 7C
does not add workspace, cwd, project snapshots, memory arrays, Git state, or
Coding-specific fields to `ContextPrepareInput` or `ContextSourceInput`.

Each result contains exactly:

```ts
interface ContextSourceResult {
  readonly providerId: ContextSourceId;
  readonly providerVersion: string;
  readonly items: readonly ContextItem[];
  readonly diagnostics: readonly ContextSourceDiagnostic[];
}
```

`ContextSourceRegistration.criticality` remains a composition decision. A
provider never declares that it is required or optional. Required failures
fail the source collection; optional failures become bounded safe diagnostics;
abort cancellation always propagates.

Provider versions are deterministic, non-empty, and semantically meaningful.
They may be based on a static schema version, an injected source snapshot
version, a durable identity range, or a deterministic content digest. They may
not use wall-clock time, random values, build timestamps, or process-local
counters.

Provider output is canonical and immutable. Every emitted item passes the
existing `createContextItem`/`assertContextItem` boundary, and the result
arrays and diagnostic arrays are frozen before leaving the provider.

Source references remain traceable but safe. They must not expose credentials,
secret environment values, raw private host paths, or exception stacks. Coding
filesystem references use workspace-relative identities, opaque project
identities, or resource references.

## Generic providers

### `agent.conversation`

The Conversation Provider consumes `ContextSourceInput.conversation`, whose
authority is `AgentConversationSnapshot`. It emits one `ContextItem` per
durable stored Agent message using the `AGENT_MESSAGE` payload kind.

The item identity preserves the durable message ID, sequence, owning turn, and
Run identity. It never uses an array index or loop counter as semantic
identity. It does not create `AIMessage` values, perform model projection,
group Tool protocol units, select history, or protect the recent tail. Those
responsibilities remain with `ContextHistoryIndexer` and `ContextPlanner`.

### `agent.checkpoint`

The Checkpoint Provider consumes an injected current-checkpoint loader or
data-only adapter. It may expose an existing compatible checkpoint as a
`CHECKPOINT` ContextItem with its source identity, checkpoint identity,
version, and recovery metadata preserved.

It does not implement Checkpoint V2, checkpoint-chain creation, persistence,
history summarization, authority rehydration, database migration, or writes to
Storage. `@caelush/agent` remains independent of `@caelush/storage`.

### `agent.memory`

The Memory Provider consumes an injected safe memory projection. It does not
depend on `@caelush/memory` and does not reimplement Memory security policy.
Disallowed or sensitive records are omitted by the upstream safe projection.

Memory items are reference material with `RETRIEVABLE` retention by default.
Memory cannot become a Project Instruction, Core Policy, `PINNED`, or
`CRITICAL` item merely by being wrapped in a ContextItem.

### `agent.extension-contributions`

The Extension Contribution Provider consumes only Phase 6F contributions that
have already passed validation, bounds, replay/recompute policy, and safe
projection. It maps those contributions to canonical ContextItems and
preserves provenance.

It never reruns hooks, writes Hook receipts, publishes RunEvents, changes Run
state, or recreates the Phase 6F recovery policy.

### `agent.branch-context`

The first implementation is an intentional stable NoOp Provider. It returns
the frozen provider ID, a stable provider version, no items, and no
diagnostics. It does not inspect the filesystem and does not implement Session
Trees, branch persistence, LCA calculation, or branch summaries.

## Coding providers

Coding providers live under `packages/coding-agent/src/context/`. They use
injected data-only ports so the new target layer does not depend on
`@caelush/context`.

### `coding.workspace`

Consumes a safe workspace descriptor and emits workspace identity, project
identity, cwd semantics, runtime kind, and other explicitly safe environment
metadata. It never emits raw `process.env`, secret environment variables,
credential paths, shell history, or arbitrary home-directory content.

### `coding.runtime-facts`

Consumes a safe Runtime/authority projection and emits bounded active-process
and runtime-state facts. It never exposes a Runtime handle, child-process
object, raw environment, secret command output, credential, or unbounded
terminal buffer.

### `coding.project-instructions`

Consumes a narrow project-instruction discovery result or adapter projection.
The current discovery behavior remains authoritative:

```text
AGENTS.override.md → AGENTS.md → CLAUDE.md fallback
project root       → nested directories → cwd
total read cap     = 32 KiB
realpath           = inside workspace
symlink escape     = blocked
```

The resulting items use Project scope, Pinned retention, Semi-stable cache
behavior, Internal sensitivity, and a High/Critical priority selected by
composition. They are `PROJECT_INSTRUCTION`, never `CORE_POLICY`, and cannot
override Core Security Policy.

### `coding.project-metadata`

Consumes a safe Project Profile/Metadata projection and emits reference facts
such as ecosystem, language signals, package manager, monorepo state,
manifests, scripts, and tooling. These facts are not instructions, even when
their source text contains instruction-like content.

### `coding.relevant-files`

Consumes the existing Relevant File Plan through a narrow data port. The
provider wraps the established discovery → ranking → budget-selection chain;
it does not replace it with an unbounded glob.

The source-side limits remain:

```text
maxSelectedFiles   = 12
maxTotalTokens     = 12,000
maxPerFileTokens   = 4,000
minUsefulFileTokens = 128
MAX_READ_BYTES     = 262,144
```

The existing workspace and project boundary, ignore policy, sensitive-file
blocking, text-only validation, NUL detection, UTF-8 validation, line-safe
truncation, and explicit-path diagnostics remain upstream responsibilities
and must be preserved by the adapter contract and regression tests.

Relevant file content is `REFERENCE`, never a Project Instruction or Core
Policy. Small, high-relevance excerpts may be pushed into Context; large or
full content remains retrievable through later controlled Tool or Artifact
paths.

### `coding.skill-catalog`

Defines the frozen `SkillCatalogEntry` and `SkillCatalogPort` contracts. The
first implementation provides a real NoOp port and provider that returns an
empty list. An injected catalog may provide only lightweight name,
description, opaque resource reference, and version data.

Full Skill bodies, Skill Runtime, skill loading Tools, Skill persistence,
marketplace behavior, and expanded workspace permissions are out of scope.

### `coding.git-state`

Consumes a narrow safe Git projection or public Runtime Git operation result.
It emits bounded branch metadata and changed-path/status summaries. It does
not execute Git directly, import `node:child_process`, emit a giant diff, or
make repository history permanently resident in Context. Full diffs remain a
future retrievable capability.

### `coding.verification-repair`

Consumes existing bounded Verification evidence or repair projection. It emits
Diagnostic/Reference material with turn-scoped, ephemeral/dynamic semantics
unless composition explicitly protects it for the current repair turn.

It does not execute verification, declare verification passed, complete a Run,
change Completion Authority, or create a new user message.

### `coding.temporal`

Consumes an injected deterministic clock. It emits current date/time and a
relative-time anchor as Dynamic Runtime Facts. The same clock input produces
the same payload, source reference, and provider version. The provider does
not scatter direct `Date.now()` calls through the target source layer.

## Authority and item conventions

Provider IDs and item types remain separate concepts. Provider IDs use the
frozen IDs above. Item types remain open strings and use the existing Phase 7B
conventions where applicable:

```text
agent.conversation
agent.checkpoint
agent.memory
agent.extension

coding.workspace
coding.runtime_fact
coding.project_instruction
coding.project_metadata
coding.relevant_file
coding.skill_catalog
coding.git_state
coding.verification_repair
coding.temporal
```

The existing Document Builder maps these semantic item types to explicit
authority labels:

| Item type                                                                                 | Document authority                     |
| ----------------------------------------------------------------------------------------- | -------------------------------------- |
| `coding.project_instruction`                                                              | `PROJECT_INSTRUCTION`                  |
| `coding.workspace`, `coding.runtime_fact`, `coding.git_state`, `coding.temporal`          | `RUNTIME_FACT`                         |
| `agent.checkpoint`                                                                        | `RECOVERY_RECORD`                      |
| `agent.memory`, `coding.project_metadata`, `coding.relevant_file`, `coding.skill_catalog` | `REFERENCE`                            |
| `coding.verification_repair`                                                              | `DIAGNOSTIC`                           |
| `agent.conversation`                                                                      | `REFERENCE`                            |
| `agent.extension`                                                                         | existing extension authority semantics |

The generic Planner remains source-agnostic. It may inspect priority,
retention, scope, freshness, sensitivity, source caps, atomicity, and history
semantics, but it must not branch on Coding Source IDs.

## Current-to-target source inventory

| Fact family            | Current authority                           | Phase 7C target                 | Migration form                 |
| ---------------------- | ------------------------------------------- | ------------------------------- | ------------------------------ |
| Conversation           | Message Domain snapshot and stored messages | `agent.conversation`            | Generic provider over snapshot |
| Checkpoint             | Existing compatible checkpoint data         | `agent.checkpoint`              | Injected loader/adapter        |
| Memory                 | Existing safe memory projection             | `agent.memory`                  | Injected data port             |
| Extension contribution | Phase 6F validated contribution pipeline    | `agent.extension-contributions` | Adapter over validated input   |
| Branch context         | Not implemented                             | `agent.branch-context`          | Intentional NoOp               |
| Workspace              | Legacy Workspace/Environment facts          | `coding.workspace`              | Safe descriptor port           |
| Runtime facts          | Runtime/authority projection                | `coding.runtime-facts`          | Narrow safe projection port    |
| Project instructions   | Legacy ProjectInstructionDiscovery          | `coding.project-instructions`   | Discovery-result adapter       |
| Project metadata       | Legacy ProjectInspector/Profile             | `coding.project-metadata`       | Metadata projection adapter    |
| Relevant files         | Legacy discovery/rank/budget chain          | `coding.relevant-files`         | Relevant-plan adapter          |
| Skill catalog          | No current runtime required                 | `coding.skill-catalog`          | Frozen port with NoOp default  |
| Git state              | Runtime/public Git facts                    | `coding.git-state`              | Narrow Git projection port     |
| Verification repair    | Existing Verification repair projection     | `coding.verification-repair`    | Evidence adapter               |
| Temporal facts         | Host clock                                  | `coding.temporal`               | Injected clock                 |

The legacy implementation remains in `@caelush/context`. This round does not
physically retire `environment.ts`, `filesystem.ts`, `project-root.ts`,
`project-profile.ts`, `project-inspector.ts`, `instructions.ts`,
`ignore-policy.ts`, `file-discovery.ts`, `relevance.ts`, `file-budget.ts`, or
`relevant-file-planner.ts`.

## Integration boundary

Phase 7C adds a target-path integration fixture that registers Generic and
Coding providers into the existing immutable registry. The fixture verifies
priority ordering, lexical tie-breaking, sequential collection,
deterministic provider output, cancellation propagation, required failure,
optional failure, canonical item ownership, planner selection, and document
authority mapping.

The fixture ends at `ContextPlan`/`ContextDocument`. It does not become a
production Context Engine and does not replace `LegacyContextRuntimeAdapter`.

## Dependency and architecture rules

`packages/agent/src/context/**` must not import:

```text
@caelush/context
@caelush/coding-agent
@caelush/runtime
@caelush/storage
@caelush/security
@caelush/memory
node:fs
node:path
node:child_process
provider SDKs
HTTP/fetch
SQLite/Drizzle
```

`packages/coding-agent/src/context/**` must not import:

```text
@caelush/context
@caelush/core
@caelush/storage
apps/daemon
apps/cli
apps/web
provider SDKs
```

The Coding Overlay may use only public Runtime/narrow Runtime abstractions.
It must not use private cross-package source paths. The implementation must
not introduce a `coding-agent ↔ security` cycle, a second Planner, a second
Message authority, a new RunEvent, or a new persistence authority.

## Explicit non-goals

Phase 7C does not implement or wire:

- ContextMaterializer or provider `AIMessage` projection;
- production Context Engine orchestration or PreparedModelContext cutover;
- semantic compaction or summarization execution;
- Checkpoint V2, checkpoint migration, or checkpoint-chain persistence;
- Authority Rehydration implementation;
- Context Artifact V2, Usage persistence, Receipt persistence, or final
  fingerprinting;
- daemon, Core, CLI, or Web production rewiring;
- physical full migration or retirement of `@caelush/context`;
- Skill Runtime, Branch Context, vector retrieval, or provider-specific prompt
  caching;
- Tool System, Tool Guard, Tool Feedback, or Event System changes.

Phase 7D has not started. The Phase 7C target path ends at
`ContextDocument`.

## Implementation verification

The Phase 7C target path is present in the current source tree and is covered
by focused provider, public-API, authority, integration, and architecture
tests. The verified implementation includes:

- the five Generic Agent Source Providers under
  `packages/agent/src/context/source/`;
- the nine Coding Context Source IDs, safe data ports, and nine Coding
  provider factories under `packages/coding-agent/src/context/`;
- root-only public exports for both provider families and the functional
  `planContext` entry point;
- explicit test-only Registry → Planner → Document composition;
- the unchanged `Core → LegacyContextRuntimeAdapter → @caelush/context`
  production compatibility path; and
- executable guards against forbidden dependencies and Phase 7D+ leakage.

This verification does not imply a production Context Engine cutover. The
legacy Context runtime remains the production path, and the following remain
explicitly deferred: ContextMaterializer, AIMessage projection, semantic
compaction, Checkpoint V2, rehydration, persistence, daemon/client rewiring,
Skill Runtime, Branch Context, Tool changes, and Event changes.
