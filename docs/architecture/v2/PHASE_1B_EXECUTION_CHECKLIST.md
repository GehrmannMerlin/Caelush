# Phase 1B Execution Checklist

Working document for Architecture V2 Phase 1B — Public Boundary & Migration
Direction Hardening. It records the task list, the files this round touches, the
execution order, the verification commands, and the stop boundary. It is not an
architecture specification; the frozen specification lives in
`docs/architecture/v2/DEPENDENCY_BOUNDARIES.md` and the Phase 1B policy document.

## Round identity

```text
Phase            Architecture V2 Phase 1B
Base commit      2e0befea64e303374c59dfd873188b95b0f484d4   (Phase 1A final)
Base branch      origin/codex/architecture-v2-phase-1a-foundation
Work branch      deepseek/architecture-v2-phase-1b-public-boundaries
Rule set         1 -> 2  (one-time, audited expansion)
Phase 1 rounds   1A, 1B, 1C only — this round is 1B and does not start 1C
```

## Tasks

```text
 1  Preflight: verify git state, Phase 1A remote SHA, environment versions
 2  Audit Phase 1A rule coverage; classify A/B/C/D edge classes; explain baseline = 0
 3  Write this checklist
 4  Freeze the machine-readable legacy migration map + its tests
 5  Refactor the target graph: single allowlist -> derived forbidden target edges
 6  Add Target -> Legacy prohibition (source import + manifest dependency)
 7  Implement the controlled rule-set expansion baseline protocol
 8  Implement the public import boundary guard (exports validation, /src/ deep
    import, cross-workspace relative private import)
 9  Extend the architecture test suite for all of the above
10  Generate the expanded baseline from the frozen Phase 1A source
11  Write docs/architecture/v2/PUBLIC_API_AND_MIGRATION_POLICY.md
12  Write docs/architecture/v2/PHASE_1B_PUBLIC_BOUNDARY_INVENTORY.md
13  Write docs/architecture/v2/PHASE_1B_DEPENDENCY_AND_MIGRATION_REPORT.md
14  Repository architecture integration validation
15  Full typecheck / lint / build / test validation
16  Changed-file formatting validation
17  Git diff review (no business migration)
18  Commit, push, end report
```

## Files this round creates

```text
scripts/architecture/v2-migration-map.mjs
docs/architecture/v2/PUBLIC_API_AND_MIGRATION_POLICY.md
docs/architecture/v2/PHASE_1B_EXECUTION_CHECKLIST.md
docs/architecture/v2/PHASE_1B_PUBLIC_BOUNDARY_INVENTORY.md
docs/architecture/v2/PHASE_1B_DEPENDENCY_AND_MIGRATION_REPORT.md
```

## Files this round modifies

```text
scripts/architecture/v2-rules.mjs               allowlist-derived rules, target->legacy,
                                                public boundary rules, violation kinds
scripts/architecture/scan-workspace.mjs         raw specifier capture, export map inventory,
                                                private and cross-workspace import detection
scripts/architecture/check-boundaries.mjs       violation classification, rule-set version,
                                                audited baseline expansion protocol
scripts/architecture/legacy-import-baseline.json   one-time expansion, ruleSetVersion 2
tests/architecture/architecture-boundaries.test.ts  Phase 1B coverage
tests/architecture/support/architecture-checker.ts   typed facade for the new surface
tests/architecture/support/fixture-workspace.ts      fixture exports maps
docs/architecture/v2/DEPENDENCY_BOUNDARIES.md         rule-model and ratchet description
docs/architecture/v2/PHASE_1A_DEPENDENCY_BASELINE.md  point at the Phase 1B expansion
```

## Files this round must not touch

```text
packages/{llm,core,context,tools,security,verification,memory,events,shared,observability}/**
packages/ai/src/index.ts  packages/agent/src/index.ts  packages/coding-agent/src/index.ts
apps/**
SQLite schema, Drizzle migrations
HTTP API, SSE, Protocol semantics
Web UI, CLI UX
Run / AgentLoop / model invocation / Tool lifecycle / Context / Message / Event /
Session semantics
pnpm-workspace.yaml
```

## Execution order

```text
test-first for every behavior change:
  write the failing expectation -> run it -> observe failure -> implement -> observe pass

 4 migration map model
 4 migration map tests                         (fail -> implement -> pass)
 5 allowlist-derived target rules + tests      (fail -> implement -> pass)
 6 target -> legacy rules + tests              (fail -> implement -> pass)
 7 expansion protocol + tests                  (fail -> implement -> pass)
 8 public boundary guard + tests               (fail -> implement -> pass)
10 baseline expansion from the frozen base
11-13 documentation from real scan output
14-16 verification
17 diff review
18 commit, push, report
```

## Verification commands

```bash
pnpm vitest run tests/architecture/architecture-boundaries.test.ts
pnpm vitest run tests/architecture
pnpm check:architecture
pnpm check:architecture:verify
pnpm --filter @caelush/ai build
pnpm --filter @caelush/agent build
pnpm --filter @caelush/coding-agent build
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm check
pnpm prettier --check <every file this round created or modified>
git status --short
git diff origin/codex/architecture-v2-phase-1a-foundation...HEAD
```

Expected results:

```text
pnpm check:architecture          PASS means new violations = 0 and stale entries = 0,
                                 with the expanded pre-existing debt equal to the baseline.
                                 It does not mean baseline entries = 0.
pnpm check:architecture:verify   PASS means the checked-in baseline equals the deterministic
                                 scan of the current checkout.
pnpm test                        Two RIPGREP_UNAVAILABLE failures are expected and
                                 pre-existing; they are environmental, not introduced here.
pnpm check                       Stops at `pnpm test` for the same environmental reason.
```

## Stop boundary

Phase 1B ends after the end report. It does not start Phase 1C, the
`@caelush/llm -> @caelush/ai` migration, the `@caelush/core -> @caelush/agent`
migration, or coding-agent extraction. No business code is moved, no dependency
is removed from a legacy package to shrink the baseline, no facade is created, and
no schema, API, or UI change is made.
