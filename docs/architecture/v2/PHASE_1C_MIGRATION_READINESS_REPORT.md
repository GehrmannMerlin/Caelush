# Phase 1C — Migration Readiness Report

Architecture V2 Phase 1C. This report gives an architectural judgement of the
real code at the Phase 1C base, from the real scan. Every number is computed, not
estimated.

## 1. Base and inventory

```text
Phase 1C base SHA        0e911f04c86d8fa6e521d1fd7c4d7f2959d776f7   (Phase 1B final)
Architecture rule version 2, 276 rules (rule set 2; the Phase 1C allowlist fix added 2)
Rule derivation           V2_ALLOWED_DEPENDENCIES -> deriveForbiddenTargetEdges()
                          no hand-written forbidden list
Baseline entries          33
Baseline source commit    2e0befea64e303374c59dfd873188b95b0f484d4   (Phase 1A final)
Workspace projects        21 (17 packages + 4 apps)
Scanned source files      440
Parsed module specifiers  2105
```

### Target package inventory

| Target                  | Directory               | Exports | Legacy dependencies | Role           |
| ----------------------- | ----------------------- | ------- | ------------------- | -------------- |
| `@caelush/ai`           | `packages/ai`           | `.`     | none                | empty skeleton |
| `@caelush/protocol`     | `packages/protocol`     | `.`     | none                | populated      |
| `@caelush/agent`        | `packages/agent`        | `.`     | none                | empty skeleton |
| `@caelush/runtime`      | `packages/runtime`      | `.`     | `@caelush/shared`   | populated      |
| `@caelush/coding-agent` | `packages/coding-agent` | `.`     | none                | empty skeleton |
| `@caelush/storage`      | `packages/storage`      | `.`     | 8 (see §4)          | populated      |
| `@caelush/client`       | `packages/client`       | `.`     | none                | populated      |

7 / 7 target packages exist, with `package.json` name, directory, and exports all
consistent. All three skeletons build independently and publish only `.`.

### Frozen graph verification

`ai → protocol` was **legal** at the Phase 1B base. Phase 1C closed it; see §7.
The frozen allowlist is now:

```text
ai             → none
protocol       → none
agent          → ai, protocol
runtime        → protocol
coding-agent   → ai, protocol, agent, runtime
storage        → agent, protocol
client         → protocol
```

Derived forbidden target edges: **32** (was 31). 7 × 6 = 42 ordered pairs, 10
allowed, 32 forbidden. Verified against the frozen specification edge by edge.

## 2. Frozen baseline debt

```text
entryCount            33
by class              target-to-legacy 25, package-manifest 8
by source package     storage 29, runtime 4
new violations        0
stale baseline        0
```

By legacy destination:

| Destination    | Entries | Why it is debt                                                            |
| -------------- | ------- | ------------------------------------------------------------------------- |
| `core`         | 6       | `storage → core`; storage may depend on neither `agent` nor `ai`          |
| `events`       | 6       | `storage → events`; the durable half moves to storage later               |
| `tools`        | 5       | `storage → tools`; storage uses tool contracts as a port                  |
| `memory`       | 4       | `storage → memory`; memory moves to `agent`                               |
| `shared`       | 4       | `runtime → shared`; `shared` is dissolved into runtime + coding-agent     |
| `verification` | 4       | `storage → verification`                                                  |
| `llm`          | 3       | `storage → llm`; storage may not depend on `ai`                           |
| `runtime`      | 1       | `storage → runtime` (devDependency); target-to-target under the allowlist |

Every destination is a legacy package with a migration entry. No unknown legacy
dependency exists in the baseline.

**Debt classification:** every entry is `target-to-legacy` migration debt. No
entry is a live architecture violation. This is the condition the readiness gate
enforces: if a `target-graph`, `target-to-host`, `host-boundary`,
`private-import`, or `cross-workspace-relative-import` entry ever appeared in the
baseline, readiness would fail, because those classes mean the architecture is
already broken rather than mid-migration.

## 3. Public boundary status

```text
private production imports                    0
cross-workspace relative production imports    0
diagnostic test-scope crossings                5 relative, 0 private
```

The production source tree is fully compliant across 440 files: no file reaches
into another package's `src`, and no file crosses a project boundary by relative
path.

The five test-scope crossings are host E2E fixtures reaching into another host's
source and are **not** gating:

```text
apps/cli/test/daemon-timeline-e2e.test.tsx      -> daemon  via ../../daemon/src/index.js
apps/cli/test/phase-12d-e2e.test.tsx            -> daemon  via ../../daemon/src/index.js
apps/daemon/test/web-session-lifecycle.test.ts  -> web     via ../../web/src/application/session-manager.js
apps/web/test/daemon-timeline-e2e.test.ts       -> daemon  via ../../daemon/src/index.js
apps/web/test/phase-13d-integration.test.ts     -> daemon  via ../../daemon/src/index.js
```

## 4. Migration debt and load-bearing edges

### 4.1 Target → legacy debt (the ratchet's subject)

```text
storage -> core           5 source files + 1 manifest     the hardest single edge
storage -> events         5 source files + 1 manifest
storage -> tools          4 source files + 1 manifest
storage -> memory         3 source files + 1 manifest
storage -> verification   3 source files + 1 manifest
runtime -> shared         3 source files + 1 manifest
storage -> llm            2 source files + 1 manifest
storage -> runtime        0 source files + 1 manifest (devDependencies, target-to-target)
```

### 4.2 Legacy → legacy load-bearing edges (the real migration complexity)

The baseline records only target → legacy. The cost of migrating each subsystem
is set by these eight edges, freshly scanned:

| Edge                  | Source files | Manifest | Crosses subsystem boundaries?            |
| --------------------- | ------------ | -------- | ---------------------------------------- |
| `core → llm`          | 23           | yes      | **yes** — agent kernel into AI           |
| `core → context`      | 10           | yes      | **yes** — kernel into context split      |
| `context → llm`       | 6            | yes      | **yes** — context into AI                |
| `core → tools`        | 5            | yes      | **yes** — kernel into tool split         |
| `security → tools`    | 5            | yes      | **yes** — security into tool split       |
| `core → verification` | 4            | yes      | **yes** — kernel into verification split |
| `context → security`  | 2            | yes      | **yes** — context into security split    |
| `context → shared`    | 2            | yes      | **yes** — context into a deleted package |

Edges that stay inside one future package:

```text
none — every legacy → legacy edge above crosses at least one planned split line
```

### 4.3 Migration dependency graph

Legacy package, what it depends on, and where each side is going:

```text
llm            ──> protocol (13)                          [self-contained → ai]
                  destinations: ai
                  consumers: core 23, storage 2, context 6, daemon 3

core           ──> llm (23) ────────────────────────────> ai
               ──> context (10) ────────────────────────> agent + coding-agent
               ──> tools (5) ──────────────────────────> agent + coding-agent
               ──> verification (4) ───────────────────> agent + coding-agent
               ──> protocol (34)
                  destinations: agent
                  consumers: storage 5, daemon 3

context        ──> llm (6) ─────────────────────────────> ai
               ──> security (2) ────────────────────────> agent + coding-agent + runtime
               ──> shared (2) ──────────────────────────> runtime + coding-agent (DELETE)
               ──> protocol (3)
                  destinations: agent + coding-agent
                  consumers: core 10, daemon 1

tools          ──> runtime (16) ────────────────────────> runtime  [target → target, LEGAL]
               ──> protocol (45)
                  destinations: agent + coding-agent
                  consumers: core 5, security 5, storage 4, daemon 2

security       ──> tools (5) ───────────────────────────> agent + coding-agent
               ──> protocol (12)
                  destinations: agent + coding-agent + runtime
                  consumers: context 2, daemon 1

verification   ──> protocol (16)                          [self-contained]
                  destinations: agent + coding-agent
                  consumers: core 4, storage 3, daemon 2

memory         ──> (nothing)                              [self-contained]
                  destinations: agent
                  consumers: storage 3, daemon 2

events         ──> protocol (4)                           [self-contained]
                  destinations: agent + storage + daemon
                  consumers: storage 5, daemon 4

shared         ──> (nothing)                              [self-contained]
                  destinations: runtime + coding-agent, then DELETE
                  consumers: context 2, runtime 3

observability  ──> (nothing)
                  destinations: none — DELETE
                  consumers: none
```

Reading the graph for migration order: `llm`, `memory`, `events`, `shared`, and
`observability` depend on **no legacy package at all**. `verification` depends
only on `protocol`. `core` depends on five legacy packages, so it must migrate
last among the kernel subsystems.

### 4.4 Highest-risk edges

Ranked by how much they constrain the order:

```text
1. core → llm          23 files  the largest edge in the repository; four subpaths
2. tools → runtime     16 files  tools is destined for agent, which may not use runtime
3. core → context      10 files  needs the context split to land first
4. storage → core       5 files  blocks storage AND agent from being re-identified
5. context → llm        6 files  context depends on AI message contracts
6. core → tools         5 files
7. security → tools     5 files
8. core → verification  4 files
```

## 5. CI architecture gate

```text
architecture job        dedicated, runs first, ubuntu-latest
                        checkout -> node 24 -> corepack -> frozen install
                        -> pnpm check:architecture:ci
                        -> vitest run tests/architecture
                        no Chromium, no Playwright, no release artifact,
                        no business test suite

check job               needs: [architecture]
release-smoke job       needs: [architecture], 4-OS matrix
release-smoke steps     pnpm check:architecture now runs first in the source
                        verification step, so path normalization, workspace
                        boundary and specifier scanning are exercised on
                        Windows, Linux, macOS arm64 and macOS x64

checkout depth          default (shallow) is sufficient
```

**Checkout depth rationale, from source.** The architecture scripts shell out to
git for exactly three read-only, checkout-local queries: `rev-parse HEAD`,
`log -1 --format=%cI`, and `status --porcelain -- packages apps`. Nothing calls
`git show`, `git cat-file`, `git merge-base`, or any command that dereferences a
historical object. `--verify-baseline` compares the recorded
`baselineSourceCommit` string against the metadata of the checked-in file; it
never reads that commit's tree. The pinned value is metadata for audit, not a
lookup key. Shallow checkout is therefore correct, and full history is
unnecessary.

## 6. Readiness gate result

```text
Caelush Architecture V2 Migration Readiness

Base commit:                        fad87b4f3e9e1e7adf4e823b1348f69d4602f134
Rule set version:                   2 (276 rules)

Target packages:                    7 / 7
Legacy migration mappings:         10 / 10
Frozen migration debt:              33
Debt classes:                       package-manifest, target-to-legacy
Debt by source package:             runtime=4, storage=29
Debt by legacy destination:         core=6, events=6, llm=3, memory=4,
                                    runtime=1, shared=4, tools=5, verification=4
Private production imports:          0
Cross-workspace private imports:     0
Diagnostic test-scope crossings:     5 relative, 0 private

Readiness:
READY
```

The gate validates eleven conditions: target package inventory (7/7 with
name/directory/exports agreement), legacy migration map coverage (10/10 with
valid destinations), baseline debt class (migration debt only), debt mappability
(every `target-to-legacy` entry names a legacy package with a destination),
no new violation, no stale baseline entry, public boundary health (production
scope only), V2 skeleton boundary (root-only exports, no legacy dependency),
frozen allowlist integrity, architecture script health (6 entry points, 4 root
scripts, CI wiring), and architecture CLI health (both gate commands execute and
exit 0).

Every count is computed from the live scan. Nothing is pinned to 33, so the gate
keeps working as migration shrinks the baseline to 20 to 0 — it asserts that the
remaining debt is legitimate migration debt, not that the debt has a size.

## 7. Dependency graph correction

`ai → protocol` was accidentally legal at the Phase 1B base. Phase 1B modelled
`protocol` in a `V2_UNIVERSAL_TARGETS` list that granted every target an implicit
dependency on it, which contradicts the frozen statement that `@caelush/ai` is an
independent AI root package.

The over-abstraction is removed and every edge now appears explicitly in
`V2_ALLOWED_DEPENDENCIES`. The forbidden graph is still derived, so the fix does
not reintroduce a hand-written forbidden list. Forbidden target edges went 31 →
32 and rules 274 → 276.

The baseline did **not** grow: 33 entries before and after, 0 new violations, 0
stale entries. `RULE_SET_VERSION` stays 2 and no expansion flag was used, because
this is a defect fix rather than a rule-set expansion. `@caelush/ai` is an empty
skeleton, so the base tree contains no `ai → protocol` edge for the new rule to
discover.

Regression coverage: `ai → protocol`, `ai → agent` and `ai → runtime` all fail
from source; `ai → protocol` in `package.json` fails as a manifest violation;
`agent`, `runtime`, `coding-agent`, `storage` and `client` each still pass
`→ protocol` in both layers; `protocol` fails against all six targets in both
layers; exactly five targets may depend on `protocol`, asserted by enumeration;
and `V2_UNIVERSAL_TARGETS` is asserted absent so the abstraction cannot return
unnoticed.

## 8. Recommended first migration candidate

No migration is executed in Phase 1C. The three plausible openings are compared
on real scan data.

### Candidate A — `@caelush/llm → @caelush/ai` (AI Model Invocation V2)

| Criterion                 | Assessment                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound dependencies     | **One legacy edge, already `protocol`.** `llm` depends on no legacy package, so moving it creates no reverse dependency and needs no other subsystem first.                                                                                       |
| Inbound dependencies      | 4 consumers, 34 source files: `core` 23, `context` 6, `daemon` 3, `storage` 2.                                                                                                                                                                    |
| Public contract           | 5 subpaths (`.`, `./errors`, `./messages`, `./request`, `./turn`), all consumed. The `ai` facade can preserve every one.                                                                                                                          |
| Reverse-dependency risk   | **None.** No other subsystem needs to move before it.                                                                                                                                                                                             |
| Destination readiness     | `@caelush/ai` is empty, has no dependencies, and already builds. It needs nothing from elsewhere.                                                                                                                                                 |
| Internal cohesion         | 30 files: 17 at the root (messages, request, turn, result, usage, tool-call, providers) plus a self-contained `providers/openai-compatible/` subtree. No cross-directory relative imports, so the move is a relocation rather than an untangling. |
| Build/test coupling       | Its tests already live in `packages/llm/test` and use subpath imports (`@caelush/llm/messages` etc.), so they move cleanly.                                                                                                                       |
| Compatibility feasibility | Ideal for the sanctioned facade: `@caelush/llm` becomes `export … from "@caelush/ai"` while four consumers keep compiling.                                                                                                                        |
| Architecture risk         | Low. The frozen V2 AI spec defines model/provider/API-adapter separation; the `ADAPT` part is real work but self-contained.                                                                                                                       |

### Candidate B — `@caelush/shared → runtime + coding-agent` (Runtime/shared first)

| Criterion               | Assessment                                                                                                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound dependencies   | None. Smallest possible surface: 3 source files, 3 exports.                                                                                                                                                                                                                                                    |
| Inbound dependencies    | 2 consumers, 5 source files: `runtime` 3, `context` 2.                                                                                                                                                                                                                                                         |
| Reverse-dependency risk | None.                                                                                                                                                                                                                                                                                                          |
| Why it is not first     | It reduces the baseline by only **4** entries, and it cannot be finished in one unit: `shared` must first move into `runtime` and `coding-agent`, and the `context → shared` edges (2 files) cannot be re-pointed until the context split exists. So it either stalls half-done or pulls context work forward. |
| Verdict                 | A good **second** unit, or a companion to the AI unit. Wrong first unit because it does not clear the deepest blocker and its completion depends on a later split.                                                                                                                                             |

### Candidate C — `@caelush/core → @caelush/agent` (Agent/core first)

| Criterion               | Assessment                                                                                                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound dependencies   | **Five legacy packages**: `llm` 23 files, `context` 10, `tools` 5, `verification` 4, plus `protocol` 34.                                                                                                                                                                          |
| Inbound dependencies    | 2 consumers, 8 files: `storage` 5, `daemon` 3.                                                                                                                                                                                                                                    |
| Reverse-dependency risk | **Severe.** Moving `core` first would make `@caelush/agent` depend on `@caelush/llm`, `@caelush/context`, `@caelush/tools`, and `@caelush/verification` — all forbidden target → legacy edges. The move is literally impossible under Rule 2 until those four subsystems migrate. |
| Verdict                 | **Last**, not first. `core` is the most depended-upon and the most depending; it is the convergence point of the whole migration.                                                                                                                                                 |

### Comparison summary

```text
                       outbound legacy edges   entries cleared   reverse-dep risk
A  llm  -> ai                    0               storage->llm         none
                                                 (2 files + 1 manifest)
B  shared -> runtime+coding      0               runtime->shared      none, but
                                                 (3 files + 1 manifest)  blocked on the
                                                                      context split
C  core -> agent                 5 (llm, context,   0                severe: moving it
                                    tools, verif)                     would create 4
                                                                      forbidden edges
```

The AI unit also removes the largest consumer edge from the later `core`
migration: 23 of `core`'s 34 legacy-dependency files point at `llm`.

### Recommendation

```text
Recommended first migration candidate:

AI Model Invocation V2
@caelush/llm  ->  @caelush/ai
operation: MOVE + ADAPT + FACADE
```

Reasons, from the scan rather than from the prompt: it is the only subsystem with
zero outbound legacy dependencies, its destination is an empty skeleton that
already builds, its five public subpaths are already consumed through declared
exports so a facade preserves them all, and it clears the largest single edge in
the repository (`core → llm`, 23 files) from the path of the later `core`
migration. Starting with `core` is architecturally impossible; starting with
`shared` stalls on the context split.

This is a recommendation for the next round's design work. It is not a
commitment, and it does not fix the numbering of any later phase.

## 9. Known environmental issues

Re-verified this round, not carried over:

```text
RIPGREP_UNAVAILABLE
  Two tests in packages/storage fail because `rg` is not installed on this
  machine. `where.exe rg` reports nothing; packages/runtime spawns the fixed
  "rg" executable. Phase 1C changed no file matching ripgrep|search-text|search/,
  verified by diff. Environment-only; GitHub CI on ubuntu-latest ships ripgrep.

CRLF format noise on Windows
  `pnpm format:check` fails repo-wide on this checkout because core.autocrlf=true
  leaves committed files as CRLF in the working tree while Prettier expects LF.
  Every Phase 1C file is LF-only and passes Prettier individually. Not caused by
  and not fixable within this round without converting the whole repository,
  which is explicitly out of scope.
```

Neither was worked around by installing ripgrep, changing the search runtime, or
converting line endings.

## 10. Readiness verdict

```text
READY
```

All eleven readiness conditions pass. The repository has the preconditions for
safe subsystem migration: a derived and now-correct target graph, a ratchet that
admits only pre-existing migration debt, a public boundary that is clean in
production code, a CI gate that fails before expensive jobs run, three destination
skeletons that build, and an audited contract for how a migration unit must
proceed.
