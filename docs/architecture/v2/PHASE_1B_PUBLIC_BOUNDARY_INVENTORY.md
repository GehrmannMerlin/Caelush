# Phase 1B — Public Boundary Inventory

Architecture V2 Phase 1B. This inventory records the **real** public surface of
every workspace project as scanned from `package.json` `exports` maps, so the
later migration phases can see exactly which entry points they must preserve,
split, or retire.

Scan facts for this document:

```text
repo scan root              <repository root>
scanned projects            21 (17 packages + 4 apps)
authoritative scope         <project>/src/**
diagnostic scope            <project>/test/**   (never baselined)
scan tool                   scripts/architecture/scan-workspace.mjs
rule set version            2
```

---

## 1. Export surface, all 21 projects

| Project                  | Public subpaths                                         | Caelush dependencies declared                                                          |
| ------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@caelush/protocol`      | `.`                                                     | none                                                                                   |
| `@caelush/ai`            | `.`                                                     | none (skeleton)                                                                        |
| `@caelush/agent`         | `.`                                                     | none (skeleton)                                                                        |
| `@caelush/runtime`       | `.`                                                     | `protocol`, `shared`                                                                   |
| `@caelush/coding-agent`  | `.`                                                     | none (skeleton)                                                                        |
| `@caelush/storage`       | `.`                                                     | `core`, `memory`, `events`, `llm`, `protocol`, `tools`, `verification`, `runtime`(dev) |
| `@caelush/client`        | `.`                                                     | `protocol`                                                                             |
| `@caelush/llm`           | `.`, `./messages`, `./turn`, `./request`, `./errors`    | `protocol`                                                                             |
| `@caelush/core`          | `.`                                                     | `context`, `llm`, `protocol`, `tools`, `verification`                                  |
| `@caelush/context`       | `.`                                                     | `llm`, `protocol`, `security`, `shared`                                                |
| `@caelush/tools`         | `.`                                                     | `runtime`, `protocol`                                                                  |
| `@caelush/security`      | `.`, `./sensitive-path`, `./redaction`                  | `protocol`, `runtime`, `tools`                                                         |
| `@caelush/verification`  | `.`                                                     | `protocol`                                                                             |
| `@caelush/memory`        | `.`                                                     | none                                                                                   |
| `@caelush/events`        | `.`                                                     | `protocol`                                                                             |
| `@caelush/shared`        | `.`                                                     | none                                                                                   |
| `@caelush/observability` | `.`                                                     | none                                                                                   |
| `@caelush/daemon`        | `.`, `./entry`, `./paths`, `./version`, `./diagnostics` | 12 internal packages                                                                   |
| `@caelush/cli`           | `.`, `./args`, `./print`                                | `client`, `protocol`                                                                   |
| `@caelush/web`           | `.`                                                     | `client`, `protocol`                                                                   |
| `@caelush/launcher`      | `.`                                                     | `cli`, `client`, `daemon`, `protocol`                                                  |

Observations that matter for migration:

- Only four projects publish a subpath beyond `.`: `llm`, `security`, `cli`,
  `daemon`. Every other public surface is a single root entry, so a migration
  that changes internals does not need to publish new subpaths to preserve a
  contract.
- `daemon` and `cli` publish subpaths that `launcher` consumes
  (`@caelush/daemon/entry`, `@caelush/daemon/paths`, `@caelush/daemon/version`,
  `@caelush/daemon/diagnostics`, `@caelush/cli/args`, `@caelush/cli/print`).
  Those are host-to-host contracts and are outside the target graph.
- The three Phase 1A skeletons publish only `.` and declare no dependencies.
- No project publishes a wildcard subpath.

## 2. Legacy package migration inventory

Each entry records the current public entry points, the exported symbol groups,
the target owner, the migration operation, and notes.

### 2.1 `@caelush/llm` → `@caelush/ai`

```text
Public entry points:  .  ./messages  ./turn  ./request  ./errors
Exported groups:      message schemas and types, request contract, model
                      capabilities, usage, finish reason and tool call,
                      turn result, stream events, error taxonomy,
                      provider port and call context, provider registry,
                      LLMGateway, OpenAI-compatible adapter factory,
                      wire diagnostics
Target owner:         @caelush/ai
Operation:            MOVE + ADAPT + FACADE
```

Notes. This is the largest and most cohesive single-destination move: every
exported group belongs to the final AI package. `ADAPT` applies to the contract
shapes — the final package defines its own model/provider/API split rather than
carrying the legacy gateway shape across — and to the provider registry, which
must become an explicit registry rather than a global. `FACADE` applies to the
legacy package itself, which may survive as a re-export shim once the symbols
actually live in `@caelush/ai`. The `./messages` subpath is consumed by
`@caelush/context` and `@caelush/storage`, and `./request`/`./turn`/`./errors` by
`@caelush/core`, so those consumers must be re-pointed as part of the move.

### 2.2 `@caelush/core` → `@caelush/agent`

```text
Public entry points:  .
Exported groups:      AgentLoop and decision mapping, agent state and step
                      lifecycle, agent step gate, tool result normalization and
                      batch conversion, RunController and its input/result
                      contracts, run execution history, run execution store
                      errors, run deadline, run termination authority, budget
                      ports, resource governor and loop detector, progress
                      ledger, TaskAcceptanceReviewer
Target owner:         @caelush/agent
Operation:            MOVE + EXTRACT
```

Notes. The kernel itself moves. `EXTRACT` covers the concerns the final agent
package may not own: persistence and commit orchestration (which belongs to
storage behind ports), and coding composition (which belongs to coding-agent).
This package has the heaviest migration pressure in the repository: 23 source
files import `@caelush/llm` and 10 import `@caelush/context`, so the LLM and
Context splits must land before `core` can be re-identified as `agent`.

### 2.3 `@caelush/context` → `@caelush/agent` + `@caelush/coding-agent`

```text
Public entry points:  .
Exported groups:      workspace scope, project root/profile detection, project
                      inspector, project intelligence snapshot, project
                      instruction discovery, environment detection, ignore
                      policy, candidate file discovery, relevance ranking,
                      token estimation, file budget selection, relevant file
                      planner, context builder, context renderer
Target owners:        @caelush/agent, @caelush/coding-agent
Operation:            SPLIT
```

Notes. This package is the clearest example of a split. Generic context assembly
— the context engine, context items, budget arithmetic, and model context
rendering — belongs to the agent kernel. Workspace and project intelligence —
workspace scope resolution, project root detection, project profile, project
inspector, project instructions, ignore policy, candidate discovery, relevance
ranking, and relevant-file planning — is coding-specific and belongs to the
coding agent. One public subpath (`./messages` on `@caelush/llm`) is already
consumed narrowly, which confirms the package is used as a contract consumer
rather than a deep dependency.

### 2.4 `@caelush/tools` → `@caelush/agent` + `@caelush/coding-agent`

```text
Public entry points:  .
Exported groups:      tool handler and execution request, execution environment,
                      security context assertion, execution result, argument
                      validation and normalization, result sanitizer port,
                      execution store port and errors, approval key, tool
                      registration, model guidance, security facts projection,
                      registry and registry builder, tool exposure filtering,
                      registry options, schema runtime, schema policy
Target owners:        @caelush/agent, @caelush/coding-agent
Operation:            SPLIT
```

Notes. The generic tool framework — contracts, registry, schema runtime,
dispatcher lifecycle, observation, and batch coordination — belongs to the agent
kernel. The concrete coding tools and their runtime-backed handlers belong to the
coding agent; the execution primitives they call already live in `runtime`. This
package is the single largest source of target-to-legacy risk: 16 source files
import `@caelush/runtime`, and `@caelush/agent` may never depend on runtime. The
split must therefore be complete rather than partial, or the framework half will
drag runtime into the kernel.

### 2.5 `@caelush/security` → `@caelush/agent` + `@caelush/coding-agent` + `@caelush/runtime`

```text
Public entry points:  .  ./sensitive-path  ./redaction
Exported groups:      policy kernel and capability evaluation, approval
                      workflow and key computation, gate implementation,
                      security facts, sensitive path classification,
                      secret redaction
Target owners:        @caelush/agent, @caelush/coding-agent, @caelush/runtime
Operation:            SPLIT
```

Notes. Three-way split. The generic policy kernel, capability matrix, approval
workflow, and result sanitization contracts belong to the agent kernel.
Sensitive-path classification and command policy are coding-specific. Child
environment allowlisting and path boundary enforcement already belong to
runtime — and note the inversion: `security` currently _depends on_ `runtime`,
which becomes a legal target-to-target edge once both are re-identified, so this
particular split does not need to cut that edge. The `./sensitive-path` and
`./redaction` subpaths are a deliberate narrow public surface, already consumed
by `@caelush/context` only.

### 2.6 `@caelush/verification` → `@caelush/agent` + `@caelush/coding-agent`

```text
Public entry points:  .
Exported groups:      verification plan and check contracts, planner, canonical
                      hash, evaluator, evidence normalization, completion seal,
                      runner coordination
Target owners:        @caelush/agent, @caelush/coding-agent
Operation:            SPLIT
```

Notes. The generic completion gate, evidence contracts, and evaluator belong to
the agent kernel, since completion authority is a kernel concern. Project command
resolution (lint/typecheck/test/build), changeset sanity and review, and task
acceptance are coding-specific and belong to the coding agent. This package
depends only on `protocol`, so it is the cheapest split in the repository and a
good early candidate.

### 2.7 `@caelush/memory` → `@caelush/agent`

```text
Public entry points:  .
Exported groups:      memory contracts and extraction job shapes
Target owner:         @caelush/agent
Operation:            MOVE + ADAPT
```

Notes. Memory belongs to the agent kernel because the kernel owns conversation
and session domain. The durable side stays behind storage ports, so the moved
implementation adapts to ports rather than owning persistence. `@caelush/storage`
imports this package from 3 source files, which must be re-pointed.

### 2.8 `@caelush/events` → `@caelush/agent` + `@caelush/storage` + `@caelush/daemon`

```text
Public entry points:  .
Exported groups:      durable agent event and draft contracts, durable event
                      store port, duplicate event error, event bus, event
                      stream and watch options
Target owners:        @caelush/agent, @caelush/storage, @caelush/daemon
Operation:            SPLIT
```

Notes. Agent event contracts, the event bus, and replay cursor semantics belong
to the agent kernel. The durable event store adapter and its sequence persistence
belong to storage. Live streaming fan-out and HTTP/SSE transport stay in the
daemon as host composition. `@caelush/storage` imports this package from 5 source
files today; those move with the durable half.

### 2.9 `@caelush/shared` → `@caelush/runtime` + `@caelush/coding-agent`

```text
Public entry points:  .
Exported groups:      path containment helper, project hard-exclusion directory
                      names and globs
Target owners:        @caelush/runtime, @caelush/coding-agent
Operation:            SPLIT + DELETE
```

Notes. Only three exports, and both groups are low-level path/project utilities:
the path boundary helper belongs to runtime, and the project exclusion lists
belong to whichever package owns project scanning (coding agent). No package
named `shared` survives in the final graph. `@caelush/runtime` imports this
package from 3 source files, which is the entire current usage.

### 2.10 `@caelush/observability` → no permanent package

```text
Public entry points:  .
Exported groups:      none — the package entry is empty
Target owner:         none
Operation:            DELETE
```

Notes. The package publishes an empty entry and no other project depends on it.
Observability is a host concern: the daemon composes logging and tracing, and any
shared shape is expressed through protocol contracts rather than a feature
package. This is the one legacy package with no migration work beyond removal.

## 3. Target package ownership summary

| Target                  | Legacy packages that feed it                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `@caelush/ai`           | `llm`                                                                                        |
| `@caelush/agent`        | `core`, `context`, `tools`, `security`, `verification`, `memory`, `events`, `shared`(guides) |
| `@caelush/runtime`      | `security`(env/path), `shared`, plus existing runtime code                                   |
| `@caelush/coding-agent` | `context`, `tools`, `security`, `verification`, `shared`                                     |
| `@caelush/protocol`     | none — already final                                                                         |
| `@caelush/storage`      | `events`(durable half)                                                                       |
| `@caelush/client`       | none — already final                                                                         |
| `daemon` (host)         | `events`(live fan-out)                                                                       |
| no package              | `observability`                                                                              |

## 4. Highest-risk split points

Ranked by how much they constrain migration order. No code is moved in Phase 1B;
this is analysis only.

```text
1. @caelush/tools -> runtime
   16 source files import @caelush/runtime. @caelush/tools is destined for
   @caelush/agent, which may never depend on runtime. Until the runtime-backed
   handlers move to coding-agent, tools cannot be re-identified as agent code.

2. @caelush/storage -> core
   5 source files. Storage may depend on neither agent nor ai, so this edge makes
   the whole storage package unreachable for both target re-identifications.

3. @caelush/core -> llm
   23 source files, the largest single edge in the repository, and it spans four
   subpaths (messages, turn, request, errors). The LLM split must preserve those
   subpath contracts or re-point 23 files.

4. @caelush/storage -> llm
   2 source files, but the same structural problem as (2): storage may not depend
   on ai either.

5. @caelush/core -> context
   10 source files. Of the 10, most are context assembly (kernel) and the rest
   are project intelligence (coding-agent), so this edge cannot be cut by a
   single re-point; it requires the context split to land first.

6. @caelush/coding-agent -> tools / security / verification
   No such edges exist today because coding-agent is an empty skeleton. These
   become the target edges the moment the split lands, so the coding halves must
   arrive without dragging the generic halves with them.

7. @caelush/context -> security (2 files) and @caelush/core -> verification (4 files)
   Narrow but load-bearing: they prove the narrow subpath pattern
   (./sensitive-path, ./redaction) already works and can be reused.
```

## 5. Architecture discrepancy

Phase 1B found one place where the frozen Phase 1A specification and the derived
rule model disagreed. It is recorded here rather than silently resolved.

### 5.1 `runtime -> shared`

Phase 1A documented `runtime -> shared` as **allowed**:

```text
docs/architecture/v2/DEPENDENCY_BOUNDARIES.md, Phase 1A:
  "runtime -> shared and runtime -> protocol are not V2 violations and never
   will be"
```

Phase 1B's rule model forbids it and baselines it as migration debt
(`RUNTIME_MUST_NOT_DEPEND_ON_SHARED`, 3 source files, plus one manifest entry).

Why Phase 1B forbids it. Phase 1A's `V2_ALLOWED_DEPENDENCIES` only covered the
seven target packages, so `shared` had no place in the model at all and the
Phase 1A prose was a statement about an unmodelled case. Phase 1B's migration map
assigns `shared` to `runtime` and `coding-agent` with a `DELETE` operation, which
makes `shared` a legacy package pending deletion. Under the frozen Phase 1B
principle — a target package never depends on a package Architecture V2 is
deleting — `runtime -> shared` is target-to-legacy debt.

Consequence. `runtime`'s use of `shared` is a **migration obligation**, not a
permitted permanent edge: the three utility exports must move into `runtime`
itself (and the project exclusion lists into the coding agent) rather than being
imported from a package that is scheduled for deletion.

This is a rule-set coverage decision, not a rewrite of the frozen V2
architecture. The frozen specification still says `runtime` owns path and
execution utilities; Phase 1B simply records that `@caelush/shared` is not the
permanent home for those utilities. If a later phase decides that `shared` should
survive as a permanent neutral utility package instead of being deleted, the
correct response is to change the migration map — one `destinations` array and one
operation list — and regenerate the baseline through the audited protocol. No
rule is edited by hand.

### 5.2 `protocol` in the allowlist

The Phase 1B specification states `agent -> ai -> protocol`, `runtime ->
protocol`, `coding-agent -> ... -> protocol`, `storage -> protocol`, and `client
-> protocol`, but lists `protocol` itself as `-> none`. Reading `protocol` as a
member of each allowlist would repeat one fact seven times and invite the exact
drift Phase 1B removes. Phase 1B therefore models `protocol` as a universal
contract in `V2_UNIVERSAL_TARGETS`: every target may depend on it, and nothing
depends on the targets from it. This is a presentation of the same rule, not a
different rule.

### 5.3 `target -> host`

Phase 1A forbade four specific `-> daemon` edges. Phase 1B initially generalised
the target graph and the target-to-legacy rule but not the `-> daemon` rule,
which would have silently dropped four enforced edges. It was caught by the
Phase 1A test suite and restored as `deriveForbiddenTargetToHostEdges()`: every
target is now forbidden from depending on every host (`daemon`, `cli`, `web`,
`launcher`). Recorded here because the failure mode — a rule model refactor that
narrows coverage — is exactly what the ratchet exists to prevent, and it was the
retained Phase 1A tests, not the new rules, that detected it.

## 6. What Phase 1B does not do

No symbol is moved by this inventory. No legacy package is renamed, deleted, or
emptied. No facade or compatibility shim is created. No dependency is removed
from a legacy package to reduce the baseline. The inventory exists so the
migration phases know exactly which public entry points they are responsible for
preserving.
