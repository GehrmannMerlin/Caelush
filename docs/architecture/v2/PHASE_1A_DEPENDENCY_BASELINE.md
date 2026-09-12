# Phase 1A — Current Dependency Baseline

Architecture V2 Phase 1A. This report is the **real** scanned dependency state of
the repository at the moment the Architecture V2 guardrail was installed. No
number in this document is estimated; every value comes from
`scripts/architecture/scan-workspace.mjs` and
`scripts/architecture/check-boundaries.mjs`.

## Provenance

```text
Scan scope:            packages/* and apps/* — <project>/src/** (authoritative)
Test scope:            <project>/test/** (diagnostic only, never baselined)
Scan timestamp (UTC):  2026-09-12T08:35:11Z
Generated from HEAD:   1988487af82da03de46b9e24448977a936cb2ea5
Baseline commit date:  2026-09-06T15:13:29+08:00
origin/master:         c5489f75a243193c9832a9f15875d9e41d8b6810
```

HEAD is **not** `c5489f75a243193c9832a9f15875d9e41d8b6810`. See
§11 "Delta from the stated analysis baseline".

## 1. Package inventory

Workspace package count (after Phase 1A scaffolding): **21 projects**
(17 packages + 4 apps).

### Architecture V2 target packages

| Report identity | Directory               | Phase 1A state               | Source files | Source imports |
| --------------- | ----------------------- | ---------------------------- | ------------ | -------------- |
| `ai`            | `packages/ai`           | **created** — empty skeleton | 1            | 0              |
| `agent`         | `packages/agent`        | **created** — empty skeleton | 1            | 0              |
| `coding-agent`  | `packages/coding-agent` | **created** — empty skeleton | 1            | 0              |
| `protocol`      | `packages/protocol`     | pre-existing, unchanged      | 50           | 72             |
| `runtime`       | `packages/runtime`      | pre-existing, unchanged      | 42           | 58             |
| `storage`       | `packages/storage`      | pre-existing, unchanged      | 31           | 78             |
| `client`        | `packages/client`       | pre-existing, unchanged      | 11           | 26             |

### Legacy packages retained unchanged

`llm`, `core`, `context`, `tools`, `security`, `verification`, `memory`,
`events`, `shared`, `observability` — all remain in place with their current
identities, contents, and dependency graphs. None was renamed, deleted, emptied,
or re-exported.

### Hosts

| Host       | Directory       | Manifest internal dependencies                                                                                                     |
| ---------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `daemon`   | `apps/daemon`   | `client`(dev), `context`, `core`, `events`, `llm`, `memory`, `protocol`, `runtime`, `security`, `storage`, `tools`, `verification` |
| `cli`      | `apps/cli`      | `client`, `protocol`                                                                                                               |
| `web`      | `apps/web`      | `client`, `protocol`                                                                                                               |
| `launcher` | `apps/launcher` | `cli`, `client`, `daemon`, `protocol`                                                                                              |

## 2. Dependency edge counts

```text
workspace source edges (project -> target package within one src file)   353
workspace manifest edges (@caelush/* across all four dependency fields)   48
parsed module specifiers in src/**                                      2105
scanned src files                                                        440
unknown @caelush/* specifiers that resolve to no workspace project          0
diagnostic test-scope source edges (never baselined)                     351
```

## 3. Package dependency adjacency list

Both views are listed because they disagree, and the disagreement is the point of
scanning manifests as well as source.

### 3.1 Manifest adjacency (`package.json`)

```text
client        -> protocol
context       -> llm, protocol, security, shared
core          -> context, llm, protocol, tools, verification
events        -> protocol
llm           -> protocol
memory        -> (none)
observability -> (none)
protocol      -> (none)
runtime       -> protocol, shared
security      -> protocol, runtime, tools
shared        -> (none)
storage       -> core, events, llm, memory, protocol, tools, verification
                 + runtime (devDependencies)
tools         -> protocol, runtime
verification  -> protocol
ai            -> (none)
agent         -> (none)
coding-agent  -> (none)

daemon        -> client(dev), context, core, events, llm, memory, protocol,
                 runtime, security, storage, tools, verification
cli           -> client, protocol
web           -> client, protocol
launcher      -> cli, client, daemon, protocol
```

### 3.2 Source adjacency (`src/**`, distinct target packages per importing project)

```text
cli          -> client (10 files), protocol (7)
client       -> protocol (6)
context      -> llm (6), protocol (3), security (2), shared (2)
core         -> context (10), llm (23), protocol (34), tools (5), verification (4)
daemon       -> context (1), core (3), events (4), llm (3), memory (2),
                protocol (20), runtime (2), security (1), storage (11),
                tools (2), verification (2)
events       -> protocol (4)
launcher     -> cli (1), client (3), daemon (2), protocol (2)
llm          -> protocol (13)
runtime      -> protocol (7), shared (3)
security     -> protocol (12), tools (5)
storage      -> core (5), events (5), llm (2), memory (3), protocol (19),
                tools (4), verification (3)
tools        -> protocol (45), runtime (16)
verification -> protocol (16)
web          -> client (8), protocol (12)
ai           -> (none)
agent        -> (none)
coding-agent -> (none)
```

### 3.3 Manifest edges without a matching source edge

These manifest edges exist in the graph but have no corresponding `src/**`
import. They are still real architecture edges, which is exactly why the checker
scans manifests:

```text
storage -> runtime     declared in devDependencies only
daemon  -> client      declared in devDependencies only (test/ integration use)
```

## 4. Current Architecture V2 forbidden edges

```text
Architecture V2 rule count (both kinds)    80
   source-import rules                     40
   package-manifest rules                  40
evaluated source edges exceeding V2 rules   0
evaluated manifest edges exceeding V2 rules 0
TOTAL ARCHITECTURE V2 VIOLATIONS            0
```

### Grouped by rule

```text
(none)
```

### Grouped by source package

```text
(none)
```

### Why the count is zero

Every package that already carries an Architecture V2 identity — `protocol`,
`runtime`, `storage`, `client` — happens to satisfy all of its V2 rules today,
and the three packages that could violate most rules (`ai`, `agent`,
`coding-agent`) did not exist before Phase 1A. Concretely:

- `@caelush/protocol` declares **no** Caelush dependency at all.
- `@caelush/runtime` → `protocol`, `shared`. Neither is forbidden for `runtime`.
- `@caelush/storage` → `core`, `events`, `llm`, `memory`, `protocol`, `tools`,
  `verification`, `runtime`(dev). None of these is in the V2 forbidden set for
  `storage`.
- `@caelush/client` → `protocol` only. Allowed.
- `apps/web` → `client`, `protocol`. Allowed.
- `apps/cli` → `client`, `protocol`. Allowed.
- `apps/daemon` → everything. Allowed; the Daemon is the composition root.

The expectation in the Phase 1A brief was that legacy code would already violate
part of the V2 matrix. Scanned reality does not support that expectation for the
V2 rule set, and this report records the scanned value rather than adjusting the
rules to manufacture violations. The ratchet semantics are unaffected: the
baseline is empty, so from this commit onward **any** forbidden edge — a new
`agent → runtime` import, a new `client → agent` dependency, an `ai → agent`
manifest entry — fails `pnpm check:architecture` immediately.

The rules do have a demonstrated teeth: the Phase 1A test suite proves that the
checker fails on `agent → runtime`, `agent → storage`, `agent → client`,
`agent → coding-agent`, `agent → daemon`, `ai → agent` (manifest),
`client → agent|runtime|storage|coding-agent` (all four manifest sections), and
all eight `web`/`cli` host edges, using throwaway fixture workspaces.

## 5. Baseline entry count

```text
scripts/architecture/legacy-import-baseline.json
  schemaVersion            1
  entryCount               0
  entries                  []
  countsByRule             {}
  countsBySourcePackage    {}
  generatedFromHead        1988487af82da03de46b9e24448977a936cb2ea5
```

An empty baseline is the strongest possible starting position for the ratchet: no
legacy debt is grandfathered, and the baseline can only ever be empty or shrink
further. The stale-entry failure path is still fully exercised by the test suite
through fixtures, so the mechanism does not depend on real debt existing.

## 6. Target Host Boundary compliance

| Host                | Requirement                                          | Current state                                                     | Verdict       |
| ------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- | ------------- |
| `@caelush/client`   | Protocol only; no agent/runtime/storage/coding-agent | `dependencies: {protocol}`; `src` imports `protocol` only         | **compliant** |
| `@caelush/web`      | No agent/runtime/storage/coding-agent                | manifest `client`, `protocol`; `src` imports `client`, `protocol` | **compliant** |
| `@caelush/cli`      | No agent/runtime/storage/coding-agent                | manifest `client`, `protocol`; `src` imports `client`, `protocol` | **compliant** |
| `@caelush/daemon`   | Composition root; may compose everything             | composes 12 internal packages                                     | **compliant** |
| `@caelush/launcher` | Product entry; no kernel                             | `cli`, `client`, `daemon`, `protocol`                             | **compliant** |

`client`, `cli`, and `web` already satisfy the Target Host Boundary in both the
manifest graph and the source graph. `daemon` is correctly the composition root.

The diagnostic test scope is **not** compliant, and deliberately so: it is
outside the architecture surface. Test files import kernel packages directly (for
example `apps/web/test/*` imports `@caelush/llm`, and `apps/cli/test/*`,
`apps/daemon/test/*`, `packages/storage/test/*` import `@caelush/core`,
`@caelush/runtime`, `@caelush/tools`, `@caelush/storage`). Those 351 test-scope
edges are reported by `scanWorkspace(root, { includeTests: true })` for analysis
and are never evaluated against the rule matrix and never enter the baseline.

## 7. Answers to the Phase 1A analysis questions

### 7.1 What does `core` directly depend on?

Manifest (`packages/core/package.json` → `dependencies`):

```text
@caelush/context       workspace:*
@caelush/llm           workspace:*
@caelush/protocol      workspace:*
@caelush/tools         workspace:*
@caelush/verification  workspace:*
zod                    4.4.3
```

Source (`packages/core/src/**`, distinct targets and importing file counts):

```text
protocol      34 files
llm           23 files   (subpaths: messages, turn, request, errors)
context       10 files
tools          5 files
verification   4 files
```

`core` does **not** depend on `storage`, `runtime`, `security`, `events`,
`memory`, or the Daemon. That is significant for the Agent migration: the future
`@caelush/agent` faces no persistence or host dependency, but it faces a heavy
`llm` dependency (23 files) and a `context` dependency (10 files) that must be
split by responsibility before `core` can become `agent`.

### 7.2 What composition does `daemon` currently carry?

`apps/daemon` is the single composition root and composes **twelve** internal
packages:

```text
@caelush/client        devDependencies  (test-only integration use)
@caelush/context       dependencies     1 src file   — Workspace/Project Intelligence composition
@caelush/core          dependencies     3 src files  — RunController / AgentLoop / recovery composition
@caelush/events        dependencies     4 src files  — durable event store + EventBus wiring
@caelush/llm           dependencies     3 src files  — LLMGateway + provider selection
@caelush/memory        dependencies     2 src files  — memory worker composition
@caelush/protocol      dependencies    20 src files  — HTTP/SSE DTO contract surface
@caelush/runtime       dependencies     2 src files  — LocalRuntime construction
@caelush/security      dependencies     1 src file   — Security Gate composition
@caelush/storage       dependencies    11 src files  — SQLite lifecycle, repositories, EventStore adapter
@caelush/tools         dependencies     2 src files  — ToolRegistry / ToolDispatcher / builtin catalog wiring
@caelush/verification  dependencies     2 src files  — VerificationRunner + runtime adapter composition
```

Composition responsibility breakdown:

| Concern composed in `daemon` | Composed packages               | Architecture V2 destination of that composition                             |
| ---------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| AI / provider invocation     | `llm`                           | `ai` (+ provider selection stays in the host)                               |
| Context assembly             | `context`, `protocol`           | `agent` (generic) + `coding-agent` (workspace-specific)                     |
| Tool system                  | `tools`, `runtime`              | `agent` (framework) + `coding-agent` (coding tools) + `runtime` (execution) |
| Security / approval          | `security`, `tools` (Gate port) | `agent` (generic security) + `coding-agent` (coding policy)                 |
| Verification                 | `verification`, `runtime`       | `agent` (generic gate) + `coding-agent` (coding verification)               |
| Run lifecycle                | `core`                          | `agent`                                                                     |
| Durable storage              | `storage`, `events`, `memory`   | `storage` (unchanged identity)                                              |
| Runtime selection            | `runtime`                       | `runtime`                                                                   |
| HTTP/SSE surface             | `protocol`                      | `protocol` (unchanged identity)                                             |

Phase 1A changes none of this. It records that `daemon` is the place where
Coding-specific composition currently lives inline, which is what the later
`coding-agent` extraction phase has to relocate.

### 7.3 What legacy dependencies such as `runtime -> shared` exist?

Real legacy edges that Architecture V2 will eventually dissolve:

```text
runtime  -> shared     dependencies      packages/runtime/package.json
runtime  -> shared     3 src files       packages/runtime/src/**
runtime  -> protocol   dependencies      packages/runtime/package.json
runtime  -> protocol   7 src files       packages/runtime/src/**
security -> runtime    dependencies      packages/security/package.json
security -> runtime    (no src import)   packages/security/package.json
security -> tools      dependencies      packages/security/package.json
security -> tools      5 src files       packages/security/src/**
tools    -> runtime    dependencies      packages/tools/package.json
tools    -> runtime    16 src files      packages/tools/src/**
storage  -> runtime    devDependencies   packages/storage/package.json
storage  -> core       5 src files       packages/storage/src/**
storage  -> llm        2 src files       packages/storage/src/**
context  -> llm        6 src files       packages/context/src/**
context  -> security   2 src files       packages/context/src/**
core     -> context    10 src files      packages/core/src/**
core     -> llm        23 src files      packages/core/src/**
core     -> tools       5 src files      packages/core/src/**
core     -> verification 4 src files     packages/core/src/**
```

`runtime -> shared` and `runtime -> protocol` are not V2 violations and never
will be: `runtime` is free to use `protocol` as its contract surface and
`shared` as a neutral utility surface, and V2 only forbids `runtime` from
depending on agent, coding-agent, storage, client, or the Daemon.

## 8. High-risk migration edges

These are **not** current violations. They are the real edges that become
violations the moment their source package is re-identified to its Architecture
V2 target name, or that the V2 rules will block as soon as the target code lands.
They are ranked by how much they constrain the migration order.

### Tier 1 — blocks the `ai` migration

`packages/llm` currently depends only on `protocol`, which is allowed. But three
packages import it with 31 importing source files:

```text
core    -> llm   23 src files   (messages, turn, request, errors subpaths)
context -> llm    6 src files   (messages subpath only)
storage -> llm    2 src files   (messages, request, turn subpaths)
```

Migrating `llm` to `ai` requires these consumers to be re-pointed first, or the
subpath surface to be preserved under the `ai` identity.

### Tier 2 — blocks the `agent` migration

```text
tools     -> runtime   16 src files + 10 test files   AGENT_MUST_NOT_DEPEND_ON_RUNTIME
```

`packages/tools` is the highest-risk edge in the repository. Sixteen production
source files import `@caelush/runtime`, and `@caelush/tools` is destined for
`@caelush/agent`, which may never depend on `runtime`. The split must move
concrete runtime-backed Tool handlers into `coding-agent` (or a `coding-agent`

- `runtime` boundary) before `tools` can be re-identified as part of `agent`.

Secondary constraints on the same migration, currently allowed but load-bearing:

```text
security -> runtime       1 manifest edge, 0 src imports   becomes security -> agent + runtime
security -> tools         5 src files                      Gate port direction must invert cleanly
core     -> context      10 src files
core     -> verification  4 src files
core     -> tools         5 src files
context  -> security      2 src files (sensitive-path, redaction subpaths)
```

### Tier 3 — blocks the `coding-agent` migration

```text
storage -> core   5 src files    (storage must never depend on agent)
daemon  -> core   3 src files    (composition must move above the kernel)
daemon  -> tools  2 src files
daemon  -> context 1 src file
daemon  -> verification 2 src files
```

`@caelush/storage` must never depend on `@caelush/agent`. Its five-file `core`
import is the edge that makes `core → agent` impossible until Storage stops
importing kernel types. `storage -> llm` (2 files) has the same shape for `ai`.

### Tier 4 — not a problem

```text
protocol -> (nothing)      already V2-clean
runtime  -> protocol       allowed
runtime  -> shared         allowed
client   -> protocol       allowed
web/cli  -> client, protocol  allowed
daemon   -> everything     allowed; hosts compose
```

## 9. Recommended first cut order (analysis only — not performed in Phase 1A)

Based purely on the scanned graph:

1. **`storage -> core`** and **`storage -> llm`** (5 + 2 source files). These are
   the only edges that make two whole target packages unreachable, because
   `storage` may depend on neither `agent` nor `ai`.
2. **`tools -> runtime`** (16 source files). This is the single largest concrete
   migration blocker and determines whether `tools` can become part of `agent`.
3. **`core -> llm`** (23 source files). The largest edge count in the
   repository; it must narrow to the provider-independent message/turn surface
   before `llm` becomes `ai`.
4. **`core -> context`, `core -> tools`, `core -> verification`,
   `context -> security`** — the remaining kernel-internal edges, split by
   responsibility as `context`, `tools`, `security`, and `verification` dissolve
   into `agent`.
5. **`daemon` coding composition** — relocation of the inline coding-specific
   wiring into `coding-agent`, after the kernel split removes the reason it lives
   in the host.

Phase 1A performs none of these.

## 10. Rules that fired

Grouped by rule over the real repository:

```text
every one of the 80 frozen Architecture V2 rules: 0 matching violations
```

Grouped by source package over the real repository:

```text
ai, agent, coding-agent, protocol, runtime, storage, client,
web, cli, daemon, launcher, and every legacy package: 0 matching violations
```

## 11. Delta from the stated analysis baseline

The Phase 1A brief listed `master` at
`c5489f75a243193c9832a9f15875d9e41d8b6810`. The executed scan found a different
state, which is recorded here as required.

```text
checked-out branch at scan time   codex/phase-13f-tool-contract-hardening
HEAD at scan time                 1988487af82da03de46b9e24448977a936cb2ea5
origin/master                     c5489f75a243193c9832a9f15875d9e41d8b6810
merge-base(HEAD, origin/master)   c5489f75a243193c9832a9f15875d9e41d8b6810
working tree at scan time         clean (nothing to commit)
```

HEAD is 21 commits ahead of `origin/master`. The delta was **not** reverted: no
`git reset --hard`, `git stash`, `git checkout -- .`, or `git clean -fd` was run,
and no existing user work was overwritten. The work was branched from the real
HEAD, so the Phase 1A guardrail protects the latest source.

The delta commits since the stated baseline:

```text
1988487 feat: harden tool contract reliability
90cb652 test: run real deepseek product entry audit
c8d11bf docs: record verified delivery sha
0190dcb docs: clean audit report whitespace
4ab8f66 docs: record agent loop tool contract audit
28aa0b4 test: add real deepseek agent loop audit
af78a7b feat: add safe model wire diagnostics
aac3e4f test: correct tool round trip fixtures
9ec0657 feat: add tool guidance and environment exposure
974c868 test: prove provider tool round trip
cb78d6e test: keep wire contract evidence on public APIs
6bc3978 test: harden wire contract characterization
17243f9 test: characterize openai compatible tool wire contract
3722ca9 docs: correct audit baseline commit provenance
e082504 docs: characterize agent loop tool audit baseline
5d7ff69 docs: plan agent loop tool contract audit
118c380 docs: specify agent loop tool contract audit
df3f70f fix(context): close V2 runtime correctness gaps
31835fb feat(storage): persist context runtime telemetry
00bb266 fix(context): repair profile arithmetic and recovery
```

Delta in file terms: `108 files changed, 7818 insertions(+), 267 deletions(-)`,
concentrated in `packages/tools` (`dispatcher.ts`, `preflight.ts`,
`model-guidance.ts`, `tool-exposure.ts`, `tool-failure-memory.ts`, plus 10 test
files), the LLM provider wire-contract tests in `tests/integration/`, and two
`scripts/*.mjs` audit drivers.

Architecture-relevant consequences of using the real HEAD:

- `packages/tools/package.json` still declares exactly
  `@caelush/protocol`, `@caelush/runtime`, `ajv` — the `tools -> runtime` edge is
  unchanged by the delta.
- No new `@caelush/*` dependency edge was introduced by the delta in any
  manifest.
- No new forbidden source edge was introduced: the delta contains no import of
  a package that is forbidden for the importing project.
- The `tools` source file count grew (54 source files) and its production import
  count grew accordingly, but every one of its Caelush imports still points at
  `protocol` or `runtime`.

## 12. Reproducing this report

```bash
# baseline check (no NEW violation, no STALE baseline entry)
pnpm check:architecture

# stricter: the checked-in baseline must equal the deterministic scan
pnpm check:architecture:verify

# machine-readable summary of the same scan
node scripts/architecture/check-boundaries.mjs --json

# explicit, manual, CI-refused baseline regeneration
node scripts/architecture/check-boundaries.mjs --write-baseline

# diagnostic only: include <project>/test/** edges (never baselined)
node -e "import('./scripts/architecture/scan-workspace.mjs').then(async (m) => { const s = await m.scanWorkspace(process.cwd(), { includeTests: true }); console.log(s.testSourceEdges.length); })"
```
