# Phase 1B — Dependency and Migration Report

Architecture V2 Phase 1B. Every number in this document comes from the real scan
by `scripts/architecture/scan-workspace.mjs` and
`scripts/architecture/check-boundaries.mjs`. No value is estimated.

## Provenance

```text
Scan scope:              packages/* and apps/* — <project>/src/** (authoritative)
Diagnostic scope:        <project>/test/** (reported separately, never baselined)
Generated from commit:   2e0befea64e303374c59dfd873188b95b0f484d4   (Phase 1A final)
Baseline generated at:   2026-09-12T16:49:36+08:00
Rule set version:        2  (Phase 1A shipped version 1)
origin/master:           c5489f75a243193c9832a9f15875d9e41d8b6810
```

## 1. Rule model

```text
rule set version                       2
total rules                          274
  forbidden target -> target edges     31   x2 layers =  62
  forbidden target -> legacy edges     70   x2 layers = 140
  forbidden target -> host edges       28   x2 layers =  56
  forbidden host -> target edges        8   x2 layers =  16
Phase 1A rules                         80
Phase 1B expansion rules              194
```

The forbidden target graph is **derived**, not hand-listed:

```text
V2_ALLOWED_DEPENDENCIES
        ↓ deriveForbiddenTargetEdges()
   31 forbidden target edges      (32 after the Phase 1C allowlist fix)

V2_TARGET_PACKAGES x V2_LEGACY_PACKAGES
        ↓ deriveForbiddenTargetToLegacyEdges()
   70 forbidden target -> legacy edges

V2_TARGET_PACKAGES x V2_FORBIDDEN_TARGET_TO_HOST
        ↓ deriveForbiddenTargetToHostEdges()
   28 forbidden target -> host edges

V2_FORBIDDEN_HOST_TO_TARGET + V2_HOST_APPS
        ↓ deriveForbiddenHostEdges()
    8 forbidden host -> target edges
```

A future target package added to `V2_TARGET_PACKAGES` is automatically forbidden
in every direction that is not explicitly allowed.

## 2. Why the Phase 1A baseline was 0

Phase 1A's baseline was empty **within the rule coverage of rule set version 1**,
and that coverage had a specific shape. Classifying every real edge by endpoint
kind shows exactly what was and was not modelled:

| Edge class           | Modelled by Phase 1A?                      | Why                                                        |
| -------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| A `target -> target` | Yes — via a hand-written forbidden list    | The only class Phase 1A expressed directly                 |
| B `target -> legacy` | **No — completely uncovered**              | All 7 victims carried no rule; targets were assumed empty  |
| C `legacy -> legacy` | No — intentionally out of scope            | Mid-migration; Phase 1A's prose allowed it                 |
| D `host -> target`   | Partially — `web`/`cli` only, hand-written | `daemon` and `launcher` are unrestricted composition roots |

Class A produced 0 violations because the four pre-existing target packages
(`protocol`, `runtime`, `storage`, `client`) genuinely satisfied every allowed
direction. Class B produced 0 violations **because no rule could report one**:
`storage -> core`, `storage -> llm`, and `runtime -> shared` were real
Architecture V2 violations of the frozen principle that a target must not depend
on a package being deleted, and Phase 1A had no rule that said so.

So the correct statement is:

```text
Phase 1A baseline = 0 was accurate for rule set version 1.
It was not evidence that migration debt was absent.
Phase 1B expands rule coverage to class B and the debt becomes visible:
33 violations.
```

This is rule-set hardening, not a correction of a Phase 1A error, and the 33
violations are **not** new debt. They are edges that already existed at commit
`2e0befea`, demonstrated by the audited expansion protocol in §5.

## 3. Edge inventory by class

### 3.1 Source edges (`src/**`)

```text
target -> target                 3 distinct pairs
    client  -> protocol   6 files
    runtime -> protocol   7 files
    storage -> protocol  19 files

legacy -> target                 8 distinct pairs
    context      -> protocol   3 files
    core         -> protocol  34 files
    events       -> protocol   4 files
    llm          -> protocol  13 files
    security     -> protocol  12 files
    tools        -> protocol  45 files
    tools        -> runtime   16 files
    verification -> protocol  16 files

target -> legacy                 7 distinct pairs   ← the Phase 1B debt
    runtime -> shared        3 files
    storage -> core          5 files
    storage -> events        5 files
    storage -> llm           2 files
    storage -> memory        3 files
    storage -> tools         4 files
    storage -> verification  3 files

legacy -> legacy                 8 distinct pairs
    context -> llm           6 files
    context -> security      2 files
    context -> shared        2 files
    core    -> context      10 files
    core    -> llm          23 files
    core    -> tools         5 files
    core    -> verification  4 files
    security -> tools        5 files

host -> target                   9 distinct pairs
    cli      -> client  10 files        web      -> client   8 files
    cli      -> protocol 7 files        web      -> protocol 12 files
    daemon   -> protocol 20 files       launcher -> client   3 files
    daemon   -> runtime  2 files        launcher -> protocol 2 files
    daemon   -> storage 11 files

host -> legacy                   8 distinct pairs
    daemon -> context 1, core 3, events 4, llm 3, memory 2,
              security 1, tools 2, verification 2

host -> host                     2 distinct pairs
    launcher -> cli 1 file, launcher -> daemon 2 files
```

### 3.2 Manifest edges

```text
target -> target                 4 distinct pairs
    client -> protocol, runtime -> protocol, storage -> protocol,
    storage -> runtime (devDependencies)

legacy -> target                 9 distinct pairs
    context -> protocol, core -> protocol, events -> protocol, llm -> protocol,
    security -> protocol, security -> runtime, tools -> protocol,
    tools -> runtime, verification -> protocol

target -> legacy                 7 distinct pairs   ← the Phase 1B debt
    runtime -> shared; storage -> core, events, llm, memory, tools, verification
    (storage -> runtime is devDependencies)

legacy -> legacy                 8 distinct pairs
    context -> llm, security, shared; core -> context, llm, tools, verification;
    security -> tools

host -> target                  10 distinct pairs
host -> legacy                   8 distinct pairs
host -> host                     2 distinct pairs
```

### 3.3 Manifest-only edges

Two manifest edges exist with no matching source import. They are still real
architecture edges, which is why the checker scans manifests:

```text
storage -> runtime     devDependencies only
daemon  -> client      devDependencies only (test integration use)
```

### 3.4 Private and cross-workspace imports

```text
/src/ deep package imports (src scope)          0
/src/ deep package imports (test scope)         0
cross-workspace relative imports (src scope)    0
cross-workspace relative imports (test scope)   5
```

The source tree is fully compliant with the export-surface rules: no production
file imports another package through `src/`, and no production file reaches
across a project boundary by relative path.

The five test-scope crossings are diagnostic only and never baselined:

```text
apps/cli/test/daemon-timeline-e2e.test.tsx   -> daemon  via ../../daemon/src/index.js
apps/cli/test/phase-12d-e2e.test.tsx         -> daemon  via ../../daemon/src/index.js
apps/daemon/test/web-session-lifecycle.test.ts -> web   via ../../web/src/application/session-manager.js
apps/web/test/daemon-timeline-e2e.test.ts    -> daemon  via ../../daemon/src/index.js
apps/web/test/phase-13d-integration.test.ts  -> daemon  via ../../daemon/src/index.js
```

These are host-to-host integration tests reaching into another host's source
rather than through its export surface. They are recorded so a later phase can
decide whether the host E2E fixtures should consume `@caelush/daemon/entry`
instead. Phase 1B does not baseline them, because the ratchet governs the
production architecture surface, and it does not fix them, because that is host
test refactoring rather than architecture hardening.

## 4. Migration debt: the target-to-legacy edges

```text
total target-to-legacy violations     33
  source imports                      25
  manifest dependencies                8
by source package
  storage                             29
  runtime                              4
by edge class
  target-to-legacy                    25
  package-manifest                     8
```

Grouped by the legacy package being depended on:

| Legacy package | Source files | Manifest entries | Depending targets                                                 |
| -------------- | ------------ | ---------------- | ----------------------------------------------------------------- |
| `core`         | 5            | 1                | `storage`                                                         |
| `events`       | 5            | 1                | `storage`                                                         |
| `llm`          | 2            | 1                | `storage`                                                         |
| `memory`       | 3            | 1                | `storage`                                                         |
| `shared`       | 3            | 1                | `runtime`                                                         |
| `tools`        | 4            | 1                | `storage`                                                         |
| `verification` | 3            | 1                | `storage`                                                         |
| `runtime`      | 0            | 1                | `storage` (devDependencies, target-to-target under the allowlist) |

Grouped by rule:

```text
STORAGE_MUST_NOT_DEPEND_ON_CORE                 5
STORAGE_MUST_NOT_DEPEND_ON_EVENTS               5
STORAGE_MUST_NOT_DEPEND_ON_TOOLS                4
STORAGE_MUST_NOT_DEPEND_ON_MEMORY               3
STORAGE_MUST_NOT_DEPEND_ON_VERIFICATION         3
RUNTIME_MUST_NOT_DEPEND_ON_SHARED               3
STORAGE_MUST_NOT_DEPEND_ON_LLM                  2
STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_CORE     1
STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_EVENTS   1
STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_LLM      1
STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_MEMORY   1
STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_RUNTIME  1
STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_TOOLS    1
STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_VERIFICATION 1
RUNTIME_MUST_NOT_DECLARE_DEPENDENCY_ON_SHARED   1
```

### 4.1 Migration debt versus new violation

The distinction the ratchet makes:

```text
migration debt  an edge that already existed at baselineSourceCommit
                (2e0befea). Listed in the baseline. Allowed to remain until
                its migration phase removes it.
new violation   an edge that is not listed in the baseline. Fails the check
                immediately, with no exception mechanism.
```

All 33 violations above are migration debt. There are 0 new violations.

### 4.2 Files carrying the debt

```text
packages/runtime/package.json                                runtime -> shared
packages/runtime/src/discovery/file-discovery.ts             runtime -> shared
packages/runtime/src/search/ripgrep-runner.ts                runtime -> shared
packages/runtime/src/workspace-path.ts                       runtime -> shared
packages/storage/package.json                                8 target -> legacy entries
packages/storage/src/index.ts                                storage -> core, verification
packages/storage/src/events/sqlite-durable-event-store.ts    storage -> events
packages/storage/src/memory-extraction-job-repository.ts     storage -> memory
packages/storage/src/memory-repository.ts                    storage -> memory
packages/storage/src/repositories/approval-repository.ts     storage -> tools
packages/storage/src/repositories/continuation-repository.ts storage -> core
packages/storage/src/repositories/conversation-repository.ts storage -> llm
packages/storage/src/run-budget-port.ts                      storage -> core, llm, tools
packages/storage/src/run-execution-store.ts                  storage -> core, events
packages/storage/src/storage.ts                              storage -> core, events, memory, tools, verification
packages/storage/src/tool-execution-store.ts                 storage -> events, tools
packages/storage/src/verification-execution-store.ts         storage -> events, verification
```

## 5. Baseline expansion audit

### 5.1 What changed

```text
before   ruleSetVersion 1, entryCount 0
after    ruleSetVersion 2, entryCount 33
```

### 5.2 How the 33 entries were admitted

Every entry was generated by scanning the tree at commit
`2e0befea64e303374c59dfd873188b95b0f484d4` — the Phase 1A final commit — under
rule set version 2. The expansion command was:

```bash
node scripts/architecture/check-boundaries.mjs --write-baseline \
  --accept-rule-expansion \
  --baseline-source-commit 2e0befea64e303374c59dfd873188b95b0f484d4
```

At that moment HEAD was exactly that commit and `git status --porcelain -- packages
apps` was clean, so the scanned graph **is** the committed Phase 1A graph. That is
the proof: an entry can only be in this baseline if its edge existed on the Phase
1A tree.

### 5.3 Refusals observed

The protocol refused every path that would have made the baseline a hiding place:

| Attempt                                                   | Result                                    |
| --------------------------------------------------------- | ----------------------------------------- |
| `--write-baseline` alone, with 33 additions               | refused `expansion-not-accepted`          |
| `--accept-rule-expansion` without a source commit         | refused `missing-baseline-source-commit`  |
| expansion pinned to `c5489f75` while HEAD was `2e0befea`  | refused `baseline-source-commit-mismatch` |
| expansion with an uncommitted violation added to the tree | refused `scanned-paths-not-committed`     |
| `--write-baseline` in CI with additions                   | refused `ci-baseline-growth`              |
| ordinary `pnpm check:architecture`                        | never writes                              |

### 5.4 Rule attribution

```text
entries admitted by rules Phase 1A already enforced   0
entries admitted by rules Phase 1B newly enforces    33
```

Every admitted violation is reported by a rule Phase 1B introduced. That is
expected and is precisely why the baseline was empty in Phase 1A: the edges were
always there, and no Phase 1A rule could see them. `storage -> core` was an
Architecture V2 violation at `2e0befea` whether or not a rule existed to say so.

The rule-id comparison is recorded for review transparency only. It is
deliberately **not** an admission criterion — a rule invented in Phase 1B that
describes a pre-existing edge must still be able to baseline that edge.

### 5.5 Warning surfaced by the tool

```text
baseline source commit is the Phase 1A final commit
the admitted set is therefore exactly the Phase 1A tree's own debt
```

Had the pin been any other commit, the tool would have printed instead:

```text
WARNING: baseline source commit is not the Phase 1A final commit 2e0befea...
the admitted set may include debt that landed after Phase 1A; a reviewer must
confirm every added entry
```

### 5.6 How future baseline growth is blocked

```text
1. An ordinary `pnpm check:architecture` NEVER writes the baseline.
2. `--write-baseline` refuses to add any entry unless the expansion protocol is
   satisfied, so the shrink-only ratchet is the default behavior.
3. The protocol requires an explicit `--accept-rule-expansion` opt-in, so growth
   cannot happen by accident.
4. The protocol requires `--baseline-source-commit <sha>` and refuses unless HEAD
   is exactly that commit.
5. The protocol refuses a dirty scanned tree, so a freshly written violation
   cannot be pinned to an older commit.
6. CI refuses any growing write regardless of flags.
7. `pnpm check:architecture:verify` fails when the checked-in baseline is not the
   deterministic scan of the checkout.
8. A stale entry fails the check and instructs the developer to remove it, so the
   baseline cannot keep a resolved violation.
```

The residual property a reviewer must understand: a developer can re-pin the
baseline to a _later_ commit, and the tool will then admit debt that landed after
Phase 1A — while printing the WARNING above and recording the new commit in
`baselineSourceCommit`. The protocol cannot make that impossible, because the
same mechanism must serve every future rule-set expansion. What it does guarantee
is that such growth is explicit, committed, reviewable in the diff, and never
silent.

### 5.7 Baseline metadata

```text
$schema                  ./legacy-import-baseline.schema.md
schemaVersion            1
ruleSetVersion           2
baselineSourceCommit     2e0befea64e303374c59dfd873188b95b0f484d4
generatedByRuleExpansion true
generatedAt              2026-09-12T16:49:36+08:00
expansionHistory         [{ fromRuleSetVersion: 1, toRuleSetVersion: 2,
                            sourceCommit: 2e0befea... }]
entryCount               33
countsBySourcePackage    { runtime: 4, storage: 29 }
countsByRule             15 entries (see §4)
entries                  33, one per line, sorted, LF-only
```

## 6. Migration destination map

```text
llm            -> [ai]                              MOVE + ADAPT + FACADE
core           -> [agent]                           MOVE + EXTRACT
context        -> [agent, coding-agent]             SPLIT
tools          -> [agent, coding-agent]             SPLIT
security       -> [agent, coding-agent, runtime]    SPLIT
verification   -> [agent, coding-agent]             SPLIT
memory         -> [agent]                           MOVE + ADAPT
events         -> [agent, storage, daemon]          SPLIT
shared         -> [runtime, coding-agent]           SPLIT + DELETE
observability  -> []                                DELETE
```

All destinations resolve to an Architecture V2 target package, the `daemon` host,
or `DELETE`. No legacy package appears as a destination, and no target package
appears on the legacy side of the map. Both properties are machine-tested.

### 6.1 Destination map versus dependency allowlist

These are different artifacts and must not be conflated:

```text
v2-rules.mjs          what a package MAY DEPEND ON today and in the final graph
v2-migration-map.mjs  WHERE a legacy package's code GOES
```

`tools -> runtime` is an existing dependency and a `legacy -> target` edge, which
is the legal compatibility direction. It does not mean `@caelush/tools` survives,
and it does not mean `runtime` becomes a package that the future agent tool
framework may depend on. The destination map splits `tools` across `agent` (tool
contracts and framework), `coding-agent` (coding tools and handlers), and
`runtime` (execution primitives the handlers call).

## 7. Recommended migration order (analysis only)

Derived from the scanned graph. Phase 1B performs none of it.

```text
1. @caelush/storage -> core (5 files) and -> llm (2 files)
   Storage may depend on neither agent nor ai, so these two edges gate both whole
   target re-identifications.

2. @caelush/tools -> runtime (16 files)
   The largest concrete blocker and the one that determines whether the tool
   framework can become part of agent.

3. @caelush/core -> llm (23 files across four subpaths)
   The largest edge count in the repository.

4. @caelush/verification split (depends only on protocol — the cheapest win)

5. @caelush/context split, then @caelush/core -> context (10 files)

6. @caelush/events split, then @caelush/storage -> events (5 files)

7. @caelush/memory move, then @caelush/storage -> memory (3 files)

8. @caelush/security split (three-way)

9. @caelush/shared dissolution (runtime -> shared, 3 files)

10. @caelush/observability deletion (no dependents, no work)

11. daemon coding-composition relocation into coding-agent
```

## 8. Reproduction

```bash
# baseline check: no new violation, no stale entry
pnpm check:architecture

# stricter: the checked-in baseline must equal the deterministic scan
pnpm check:architecture:verify

# machine-readable scan summary
node scripts/architecture/check-boundaries.mjs --json

# audited rule-set expansion (refused unless HEAD is the given commit and clean)
node scripts/architecture/check-boundaries.mjs --write-baseline \
  --accept-rule-expansion --baseline-source-commit <sha>
```
