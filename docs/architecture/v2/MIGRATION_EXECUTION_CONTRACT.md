# Caelush Architecture V2 — Migration Execution Contract

This is the binding contract for every real subsystem migration that follows
Architecture V2 Phase 1. It is the handover from architecture preparation to
subsystem migration.

Phase 1 built the guardrails; this document states what a migration unit must do
to use them correctly. It is not a plan for any specific subsystem — no subsystem
migration starts in Phase 1C.

---

## 1. The twelve rules

Every migration unit obeys all twelve. They are ordered so that reading them top
to bottom describes the migration itself.

### Rule 1 — Target package becomes canonical owner

The target package (`@caelush/ai`, `@caelush/agent`, `@caelush/runtime`,
`@caelush/coding-agent`, `@caelush/storage`, `@caelush/protocol`,
`@caelush/client`) becomes the single canonical home for the migrated
responsibility. After the unit lands, exactly one implementation of the
responsibility exists, and it lives in the target.

Two live implementations of the same responsibility are the failure mode this
rule prevents. A migration that adds target code while leaving the legacy code
authoritative has not started.

### Rule 2 — Target package must never import legacy implementation

```ts
// FORBIDDEN, always
packages/ai/src/foo.ts           import … from "@caelush/llm"
packages/agent/src/foo.ts        import … from "@caelush/core"
packages/coding-agent/src/foo.ts import … from "@caelush/tools"
```

Enforced by 70 forbidden target-to-legacy edges, each checked in source and in
`package.json`. This is the compatibility direction lock and it has no
exception, temporary or otherwise.

### Rule 3 — Legacy compatibility may point legacy → target

```ts
// ALLOWED, and only after the symbol really moved
packages/llm/src/index.ts   export { complete } from "@caelush/ai";
packages/core/src/index.ts  export { AgentLoop } from "@caelush/agent";
```

The legacy package becomes a re-export facade so existing import paths keep
working while the implementation has one home.

A facade may only be created when the symbol already exists in the target. A
facade created before the move is not compatibility, it is a rename of the
problem.

### Rule 4 — Consumers may migrate incrementally

Not every consumer must switch in one commit. A facade lets consumers keep
compiling while they are re-pointed one at a time.

Incremental does not mean indefinite: the unit records which consumers were
re-pointed and which remain, so the next unit can finish the job instead of
rediscovering it.

### Rule 5 — Existing public contract remains until the explicit deletion stage

A public entry point stays available until the deletion stage for that subsystem
declares otherwise:

```text
existing subpaths, DTOs, error codes, and function signatures remain stable
```

Migration changes where code lives, not what callers observe. Breaking a public
contract is a deliberate, separately reviewed act with its own unit — never a
side effect of relocating files.

### Rule 6 — Baseline may only shrink

```text
before the unit      33 entries
after the unit       ≤ 33 entries
```

The baseline has exactly one sanctioned way to grow, the audited rule-set
expansion protocol, and Phase 1B used it once. It is not available to a migration
unit.

### Rule 7 — A resolved baseline entry must be removed

When a unit removes a violation, the baseline entry must be deleted in the same
unit:

```bash
node scripts/architecture/check-boundaries.mjs --write-baseline
```

The write only removes entries, so it needs no expansion flags. Leaving a
resolved entry behind fails the gate as `STALE_BASELINE_ENTRY`, which is the
ratchet doing its job: the baseline is a truthful record of remaining debt, not a
historical log.

### Rule 8 — New architecture violation must never enter baseline

If a unit introduces a violation, the gate fails and the unit fixes the code. A
migration is when the architecture is being improved; it is the worst possible
moment to grandfather new debt.

The temptation is real: a half-finished split often leaves a target importing a
legacy package "just for now". That is exactly the shape Rule 2 forbids, and the
correct response is to finish the split or shrink the unit — never to regenerate
the baseline.

### Rule 9 — Tests move with their canonical implementation

A test for a migrated behaviour moves to the target package with the code. A test
that stays behind tests the facade, not the implementation.

Tests that exercise the real behaviour through the legacy import path should be
re-pointed at the target, keeping the coverage attached to the canonical owner.
Architecture tests are unaffected: they already describe the final graph.

### Rule 10 — Runtime behavior must stay compatible

Unless the subsystem's own frozen V2 specification explicitly changes it, a
migration unit preserves observable behaviour:

```text
same Run semantics                 same Tool lifecycle
same model invocation behaviour    same approval semantics
same context assembly output       same durable event sequence
same session behaviour             same error contracts
```

This round and the rounds after it are refactors. A behaviour change smuggled
into a migration is invisible to review and breaks the guarantee the frozen
specifications provide.

### Rule 11 — Database and API changes need their own subsystem phase

Schema migrations, new tables, HTTP route changes, SSE payload changes, and UI
changes belong to the subsystem migration phase that owns them — never to
architectural cleanup.

```text
architecture cleanup      moves code, preserves contracts
subsystem migration       may change a contract, under its own frozen spec
```

If a unit cannot move code without changing a contract, that is a signal the unit
is too large, not a licence to change the contract.

### Rule 12 — Legacy package deletion conditions

A legacy package is deleted only when **all five** hold:

```text
1. no production consumer remains
2. the compatibility facade is no longer required
3. public exports have migrated to the target
4. the architecture checker confirms no dependency on it
5. every test passes
```

Partial satisfaction is not deletion. Deleting early converts a clean migration
into a broken build, and the five conditions are each mechanically checkable:
consumer count from the scan, facade presence from the legacy `src/index.ts`,
export state from both manifests, dependency state from the checker, and the test
suite from CI.

## 2. The standard migration unit loop

```text
Scan
   ↓  what depends on this subsystem today? (scan-workspace.mjs, the readiness gate)
Move / Extract / Adapt
   ↓  relocate the responsibility into the target
Target canonical implementation
   ↓  the target is now the single home (Rule 1)
Legacy → Target compatibility
   ↓  facade re-exporting the moved symbols (Rule 3)
Consumer migration where required
   ↓  re-point consumers whose edges block the next step (Rule 4)
Targeted tests
   ↓  move and re-point the coverage (Rule 9)
Architecture check
   ↓  pnpm check:architecture — no new violation, no stale entry
Baseline shrink
   ↓  pnpm check:architecture  (Rule 7)
Full validation
   ↓  pnpm typecheck && pnpm test && pnpm build
Commit / Push
```

Every step is mechanical. A unit that skips one leaves the repository in a state
the guardrails will report on the next run.

## 3. Required evidence per migration unit

A migration unit's report states, with real numbers:

```text
baseline entries before
baseline entries after
violations removed by this unit
legacy packages whose canonical home moved
consumers re-pointed
facades introduced
public contracts preserved (yes/no, and which)
rules 1-12 satisfied (each one named)
remaining blockers for the next unit
```

## 4. Forbidden shapes

```text
Reverse facade
  @caelush/ai          → @caelush/llm      ❌
  @caelush/agent       → @caelush/core     ❌
  @caelush/coding-agent → @caelush/tools   ❌

Correct direction
  @caelush/llm         → @caelush/ai       ✅
  @caelush/core        → @caelush/agent    ✅

Compatibility is always Legacy → Target. There is no reverse form.
```

```text
Baseline growth by regeneration                    ❌
Keeping a resolved baseline entry                  ❌
Two live implementations of one responsibility      ❌
Deleting a legacy package before all five conditions ❌
Behaviour change hidden inside a migration          ❌
Schema/API/UI change inside architectural cleanup   ❌
Splitting a migration unit to get under the ratchet ❌
```

## 5. Phase 1 closure

Phase 1 ends with the guardrails verified. Phase 1C adds no migration work.

The next round designs one specific subsystem migration, using
`PHASE_1C_MIGRATION_READINESS_REPORT.md` for the dependency facts. That report
recommends a first candidate; it does not authorise starting it, and it does not
fix the numbering of later rounds.

## 6. Command reference for a migration unit

```bash
# is this repository ready to migrate?
pnpm check:architecture:readiness

# does the current change introduce or leave a violation?
pnpm check:architecture

# is the checked-in baseline the deterministic scan of this checkout?
pnpm check:architecture:verify

# the whole architecture gate, as CI runs it
pnpm check:architecture:ci

# shrink the baseline after removing violations
node scripts/architecture/check-boundaries.mjs --write-baseline

# full validation
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```
