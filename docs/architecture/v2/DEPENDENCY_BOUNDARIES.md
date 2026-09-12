# Caelush Architecture V2 — Dependency Boundaries

This document turns the frozen Caelush Architecture V2 dependency matrix into a
repo-local implementation guardrail. It does not invent architecture; it records
what is already frozen and points at the executable rules that enforce it.

The machine-readable source of truth is
`scripts/architecture/v2-rules.mjs`. The executable check is
`pnpm check:architecture`. The frozen list of pre-existing violations is
`scripts/architecture/legacy-import-baseline.json`.

Current state:

```text
rule set version        2   (Phase 1A shipped version 1; Phase 1B expanded it)
active rules          276   derived from the allowlist, never hand-listed
baseline entries       33   target -> legacy migration debt frozen at the
                            Phase 1A commit 2e0befea64e303374c59dfd873188b95b0f484d4
new violations          0
```

Phase 1B added the two guardrails this document describes but Phase 1A did not
enforce: the compatibility direction lock (`target -> legacy` is forbidden, only
`legacy -> target` is allowed) and the public export-surface boundary. See
`PUBLIC_API_AND_MIGRATION_POLICY.md`, `PHASE_1B_PUBLIC_BOUNDARY_INVENTORY.md`,
and `PHASE_1B_DEPENDENCY_AND_MIGRATION_REPORT.md`.

---

## 1. Core packages

Architecture V2 fixes the core package set:

| Package                 | Identity       | Responsibility                                                                                                                                                                                                                                           | May depend on (final direction)                                          |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `@caelush/ai`           | `ai`           | Model, Provider, API Adapter, AI Message, AI Tool Spec, Stream, Usage, Reasoning metadata, Cache metadata, Model Capability, Authentication                                                                                                              | nothing above it — no Caelush package                                    |
| `@caelush/protocol`     | `protocol`     | Cross-process stable contracts: HTTP/SSE DTOs, public IDs, public errors, public events, client-visible schemas                                                                                                                                          | no Caelush feature package, no app                                       |
| `@caelush/agent`        | `agent`        | General Agent, Agent Loop, Run lifecycle contracts, Context Engine, Message Domain, Tool Framework, generic Security, generic Completion Gate, Memory contracts, Session conversation domain, Agent Events, Recovery, Retry, Budget, Resource Governance | no Caelush package above the kernel                                      |
| `@caelush/runtime`      | `runtime`      | Filesystem, Shell, Process, Patch, Git primitives, Path Boundary, workspace containment, Local Runtime, future Docker/SSH/remote sandbox                                                                                                                 | no Caelush package above the substrate                                   |
| `@caelush/coding-agent` | `coding-agent` | General Agent → Coding Agent composition, Workspace Context Providers, Relevant File Providers, Project Instructions, Coding Tools, Coding Security, Coding Verification, Coding Prompt, future Extension/Skill/MCP                                      | `@caelush/ai`, `@caelush/protocol`, `@caelush/agent`, `@caelush/runtime` |
| `@caelush/storage`      | `storage`      | Durable adapter layer: it implements ports defined by upper layers                                                                                                                                                                                       | no Caelush package that would make it an authority                       |
| `@caelush/client`       | `client`       | Client-side consumption of the cross-process contract                                                                                                                                                                                                    | `@caelush/protocol` only                                                 |

### What each package must never know

- `@caelush/ai` must never know about `Run`, `Session`, `Workspace`, `Runtime`,
  `Storage`, the Daemon, `Approval`, `Verification`, Coding, Git, or the
  filesystem.
- `@caelush/protocol` must never know an Agent, Runtime, Storage, Coding Agent,
  or Daemon implementation, and never a Client implementation.
- `@caelush/agent` must never know a Coding Agent, concrete Runtime operations,
  SQLite, the Daemon, a Client, Git, `read_file`, `exec_command`,
  `apply_patch`, Node/Java project scanning, or the local filesystem.
- `@caelush/runtime` must never know the Agent Loop, `RunController`, a Coding
  Agent, an LLM, the Daemon, or a Client.
- `@caelush/coding-agent` must never know `storage`, `client`, or the Daemon.
- `@caelush/storage` is a durable adapter layer and never a business authority.
  An Agent implementation must never import Storage.
- `@caelush/client` consumes only the cross-process contract.

## 2. Hosts

Architecture V2 fixes four hosts:

| Host            | Responsibility                                                                      |
| --------------- | ----------------------------------------------------------------------------------- |
| `apps/daemon`   | Local Agent Service: the only composition root, HTTP/SSE surface, process lifecycle |
| `apps/cli`      | Terminal presentation and user input forwarding                                     |
| `apps/web`      | Browser presentation and HTTP/SSE consumption                                       |
| `apps/launcher` | Product entry point, daemon discovery and start                                     |

Hosts consume the service. `Web` and `CLI` are never the Run State Authority and
never import the kernel or persistence layers.

A future `experimental/orchestrator` package is explicitly **not** part of
Phase 1A and must not be created.

## 3. Final allowed direction

```text
ai          -> (nothing in Caelush)
protocol    -> (nothing in Caelush)
runtime     -> (nothing above the execution substrate)
storage     -> (implements ports defined above it; never an authority)
agent       -> (kernel contracts only)
coding-agent -> ai, protocol, agent, runtime
client      -> protocol
```

`apps/*` may compose `packages/*`; no package may ever depend on an app. This
direction is enforced today by the pre-existing Phase 6C/8A/12A boundary tests in
`tests/architecture/`, and for the Architecture V2 packages by
`scripts/architecture/v2-rules.mjs`.

## 4. Forbidden dependency matrix

Every cell below is a forbidden edge. `S` marks a forbidden source import;
`M` marks a forbidden `package.json` workspace dependency. Both are enforced for
every listed pair.

| from \ to      | ai  | protocol | agent | runtime | coding-agent | storage | client | daemon | web | cli |
| -------------- | --- | -------- | ----- | ------- | ------------ | ------- | ------ | ------ | --- | --- |
| `ai`           | –   |          | S M   | S M     | S M          | S M     | S M    |        |     |     |
| `protocol`     |     | –        | S M   | S M     | S M          | S M     | S M    | S M    |     |     |
| `agent`        |     |          | –     | S M     | S M          | S M     | S M    | S M    |     |     |
| `runtime`      |     |          | S M   | –       | S M          | S M     | S M    | S M    |     |     |
| `coding-agent` |     |          |       |         | –            | S M     | S M    | S M    |     |     |
| `storage`      |     |          |       |         |              | –       | S M    | S M    | S M | S M |
| `client`       |     |          | S M   | S M     | S M          | S M     | –      |        |     |     |
| `web`          |     |          | S M   | S M     | S M          | S M     |        |        | –   |     |
| `cli`          |     |          | S M   | S M     | S M          | S M     |        |        |     | –   |

Reading the matrix:

```text
AI → Agent                 ❌   AI → CodingAgent  ❌   AI → Runtime     ❌
AI → Storage               ❌   AI → Client       ❌
Protocol → Agent           ❌   Protocol → Runtime ❌  Protocol → CodingAgent ❌
Protocol → Storage         ❌   Protocol → Daemon ❌   Protocol → Client ❌
Agent → CodingAgent        ❌   Agent → Runtime   ❌   Agent → Storage   ❌
Agent → Client             ❌   Agent → Daemon    ❌
Runtime → Agent            ❌   Runtime → CodingAgent ❌ Runtime → Storage ❌
Runtime → Client           ❌   Runtime → Daemon  ❌
CodingAgent → Storage      ❌   CodingAgent → Client ❌ CodingAgent → Daemon ❌
Storage → Daemon           ❌   Storage → Client  ❌   Storage → Web      ❌
Storage → CLI              ❌
Client → Agent             ❌   Client → Runtime  ❌   Client → Storage   ❌
Client → CodingAgent       ❌
Web → Agent                ❌   Web → Runtime     ❌   Web → Storage      ❌
Web → CodingAgent          ❌
CLI → Agent                ❌   CLI → Runtime     ❌   CLI → Storage      ❌
CLI → CodingAgent          ❌
```

Deep specifiers never widen a boundary. `@caelush/agent`,
`@caelush/agent/context`, and `@caelush/agent/tools/foo` all normalize to the
`@caelush/agent` package identity before a rule is evaluated.

### 4.1 The compatibility direction lock (Phase 1B)

Every cell above describes a **target -> target** or **host -> target** edge.
Phase 1B adds the rule that protects the migration itself:

```text
@caelush/<target>  ->  @caelush/<legacy>     ❌ FORBIDDEN, permanently
@caelush/<legacy>  ->  @caelush/<target>     ✅ allowed compatibility direction
```

The legacy packages are `llm`, `core`, `context`, `tools`, `security`,
`verification`, `memory`, `events`, `shared`, and `observability`. A target
package may never depend on one of them, in source or in a manifest. The formal
rule is 70 forbidden target -> legacy edges, each enforced twice.

A package may also never depend on an app. Phase 1A forbade four specific
`-> daemon` edges; Phase 1B generalises that to 28 forbidden target -> host edges
covering `daemon`, `cli`, `web`, and `launcher`, so the rule survives a package
being added.

The reason this is a separate rule rather than an extension of the matrix above:
the matrix says which final package may use which final package. This rule says
a package that has not been migrated yet cannot become a permanent second home
for a responsibility that is supposed to move. It is what stops
`new package -> legacy implementation` from looking like a finished migration.

### 4.2 The public export surface (Phase 1B)

A package may be consumed only through the subpaths its `package.json` `exports`
map declares. Two shapes are forbidden in every project, whatever its identity:

```text
@caelush/<pkg>/src/...              ❌ PACKAGE_MUST_NOT_BE_IMPORTED_THROUGH_SRC
@caelush/<pkg>/<undeclared>         ❌ PACKAGE_SUBPATH_MUST_BE_DECLARED_IN_EXPORTS
../../<other-project>/src/...       ❌ PACKAGE_MUST_NOT_IMPORT_ANOTHER_PROJECT_BY_RELATIVE_PATH
```

The rule is `exports`-driven, not subpath-driven: `@caelush/llm/messages` is legal
because `@caelush/llm` publishes `"./messages"`, and it stops being legal the day
that entry is removed. The real source scope currently has zero such violations.

## 5. Legacy Dependency Baseline

Phase 1A installs the guardrail without rewriting the running system, so the
repository ships a checked-in baseline:

```text
scripts/architecture/legacy-import-baseline.json
```

The baseline records every dependency edge that already violates an Architecture
V2 rule at the moment the rule set became active. Each entry records:

```text
kind              source-import | package-manifest | private-import |
                  cross-workspace-relative-import
edgeClass         why the edge is illegal, e.g. target-to-legacy,
                  target-graph, package-manifest, private-import
sourcePackage     the violating project identity, e.g. agent
sourcePath        the file that contains the edge (source file or package.json)
targetPackage     the illegally referenced project identity
rule              the violated rule id, e.g. AGENT_MUST_NOT_DEPEND_ON_RUNTIME
specifier         the normalized dependency, e.g. @caelush/runtime
dependencyField   the manifest section, for package-manifest entries only
subpath           the undeclared subpath, for private-import entries only
```

The baseline is deterministic, sorted, human-readable, and stored as one entry
per line so review diffs stay meaningful. Line numbers, columns, occurrence
counts, and deep subpaths are deliberately excluded from the match key: ordinary
editing, adding a second import, or switching to a subpath must not churn the
file. A private import additionally matches on its exact specifier, because two
different undeclared subpaths in one file are two distinct findings.

The baseline also carries auditable provenance:

```text
schemaVersion             baseline document shape
ruleSetVersion            which rule set produced it
baselineSourceCommit      the commit whose tree the admitted set was proven on
generatedByRuleExpansion  whether the audited expansion produced it
generationHistory         the rule set version transitions recorded so far
entryCount                number of entries
countsByRule              entries grouped by violated rule
countsBySourcePackage     entries grouped by violating project
entries                   the frozen violations
```

## 6. Ratchet

The baseline is a ratchet, not a whitelist. `pnpm check:architecture` fails in
exactly these cases:

| Situation                                          | Outcome                             |
| -------------------------------------------------- | ----------------------------------- |
| A violation that is listed in the baseline         | allowed, frozen until its migration |
| A violation that is **not** listed in the baseline | `FAIL` — `NEW_VIOLATION`            |
| A baseline entry with **no** matching violation    | `FAIL` — `STALE_BASELINE_ENTRY`     |
| A duplicated baseline entry                        | `FAIL` — duplicate baseline entries |
| A baseline from a different rule set version       | `FAIL` — rule set version mismatch  |

The consequence is that the baseline can only shrink:

```text
Phase 1A  rule set 1   baseline 0    (no rule covered target -> legacy yet)
Phase 1B  rule set 2   baseline 33   (coverage expanded; the debt is frozen)
AI migration           baseline shrinks
Agent migration        baseline shrinks further
coding-agent migration baseline shrinks further
cleanup                baseline reaches zero
```

`pnpm check:architecture` passes when there is **no new violation and no stale
baseline entry**. It does not require the number of legacy violations to be zero.

The baseline may only be regenerated explicitly:

```bash
node scripts/architecture/check-boundaries.mjs --write-baseline
```

This command is never part of `pnpm check`, never runs automatically, and is
refused whenever the write would add entries — including in CI, which refuses any
growing write regardless of flags. Deleting a violation during a migration phase
means explicitly regenerating the baseline, reviewing the removal diff, and
committing it. A new violation can never be hidden by "just regenerating".

### 6.1 Audited rule-set expansion

A rule set can legitimately gain coverage, which discovers violations that were
always there. That case has one sanctioned path:

```bash
node scripts/architecture/check-boundaries.mjs --write-baseline \
  --accept-rule-expansion --baseline-source-commit <sha>
```

It requires all of:

```text
an explicit --accept-rule-expansion opt-in
HEAD exactly equal to --baseline-source-commit
every scanned path committed (a dirty tree cannot prove an edge pre-existed)
```

so the admitted set is provably that commit's own debt, and nothing that landed
afterwards can enter. Phase 1B used it exactly once, to move from rule set 1 to
rule set 2 and admit the 33 target-to-legacy edges that already existed at the
Phase 1A commit. If the pin is not the Phase 1A final commit, the tool prints a
WARNING that the admitted set may include later debt and that a reviewer must
confirm every added entry.

The stricter, optional mode is:

```bash
pnpm check:architecture:verify
```

It additionally fails when the checked-in baseline is not the deterministic
baseline for the current checkout.

## 7. Why the legacy packages remain

Phase 1A installs guardrails. It does not migrate business code.

The following packages keep their legacy identity and are **not** renamed,
deleted, or emptied in this phase:

```text
packages/llm            packages/core         packages/context
packages/tools          packages/security     packages/verification
packages/memory         packages/events       packages/shared
packages/observability
```

They remain the running implementation. Renaming `llm` to `ai` is a later AI
migration phase; renaming `core` to `agent` is a later Agent migration phase;
splitting `context`, `tools`, `security`, `memory`, and `events` is later work
still. Doing any of it now would be a business refactor hidden inside an
architecture phase, and it would remove the very reference points the migration
phases need.

Existing boundary tests in `tests/architecture/` continue to constrain the
legacy packages during the transition. The Architecture V2 rules add a second,
narrower guardrail on top: they protect the **final** identities so the target
graph cannot be violated while the migration is in progress.

## 8. What Phase 1A does not do

Phase 1A explicitly does **not**:

- rename `packages/llm` to `packages/ai`, or `packages/core` to `packages/agent`;
- move `context`, `tools`, `security`, `verification`, `memory`, `events`, or
  `shared` code;
- move any code into `packages/ai`, `packages/agent`, or `packages/coding-agent`;
- copy legacy implementation, re-export legacy packages, or add a compatibility
  bridge;
- change SQLite schema, Drizzle migrations, HTTP API, SSE, or protocol semantics;
- change Run, Tool, Approval, Verification, Context, Message, or Session domain
  semantics;
- change the Web UI, the CLI UX, or model invocation logic;
- implement Agent Loop V2, AI Model Invocation V2, Tool System V2, Message
  System V2, Event System V2, Context V2, or Session System V2;
- create `experimental/orchestrator`;
- reduce the number of legacy violations by refactoring business code.

The baseline count is real data about the current architecture. It is not a
Phase 1A failure.

## 9. Migration rule for removing baseline entries

When a migration phase removes a violation:

1. Remove the violating import or manifest dependency in that migration phase.
2. Run `node scripts/architecture/check-boundaries.mjs --write-baseline` locally.
3. Confirm the diff **only removes** entries. Any added entry is a new
   Architecture V2 violation and must be fixed, not baselined.
4. Commit the shrunken baseline together with the migration that caused it.
5. Never add an entry to the baseline to make a check pass.

The migration phases keep their own `AGENTS.md` boundaries. This document only
guarantees that the final package graph cannot be violated while they run.
