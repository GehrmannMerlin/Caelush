# Phase 4E — Operations Freeze Errata Resolution & Product Layer Progress

> Round: **Phase 4E** — same round, resumed after the Milestone A blocker. **Not** a new round.
> Status at the end of this session: **IN PROGRESS — NOT COMPLETE.**
>
> This document records exactly what landed, what did not, and therefore why the round may not yet be
> called complete. It is deliberately not a completion report.

---

## 1. Git record

```text
Base SHA                     d21595f14fd18d66369aec4f1a090b8cc459656e   (4D final tip)
Blocked commit               1920cdde65118defea39355faefe072b1d57ae8e   preserved unchanged
Errata commit                8523f85   docs(architecture): resolve phase 4e operations freeze blockers
Implementation commit        162895b   feat(coding-agent): own the coding tool product layer
Guard-correction commit      9e80ad8   test(architecture): correct the pre-4E guard fixtures
Branch                       deepseek/architecture-v2-phase-4e-coding-tools-operations-runtime
Remote branch tip            identical to the local tip; verified with git ls-remote
Working tree                 clean
```

The blocked commit was **not** reset, rebased, amended or force-pushed, and its evidence documents were
not deleted. The errata is a separate commit, so the history reads as intended:

```text
design froze an incomplete interface
  → reconciliation caught it
  → the round blocked rather than regress behaviour
  → the architecture owner accepted a scoped errata
  → implementation resumed
```

---

## 2. What the errata changed

`docs/architecture/v2/PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md` supersedes **only** Interface
Freeze §165 (`SearchTextOperations`) and the `status` arm of §169 (`GitOperations.status`), both proven
against production source to be unable to express execution semantics their Tools must honour.

```text
SearchTextOperations   gains include?: string and limit: number
GitOperations.status   gains args: JsonObject, symmetric with the diff arm that already had one
```

The six other Operations contracts, `ToolExecutionEnvironment`, the Runtime contracts, the Phase 4D
canonical Tool pipeline and the frozen Tool-turn contract are unchanged. No Tool schema, default, bound
or error code changes.

---

## 3. What landed

### 3.1 Milestone B — the eight frozen Operations ports

`packages/coding-agent/src/tools/operations/`. Every port takes `ToolExecutionEnvironment` and a
**required** `AbortSignal` and returns a Tool business result, never a Runtime object.

### 3.2 Milestone C — the Runtime Operations adapters

`packages/coding-agent/src/tools/operations/runtime-adapters/` — the only directory in the package that
imports `RuntimeResolver` or `RuntimeWorkspaceScope`. Each port has a real Runtime implementation.

Fidelity points that were deliberate, not incidental:

```text
include                  reaches ripgrep as a path-level --glob BEFORE truncation
limit                    keeps the N + 1 capture probe the legacy Tool relied on
git status path          is forwarded to RuntimeGitService, so Git applies the real pathspec
git status limit         is forwarded, so a request for 250 entries is not pinned to the runtime default of 200
failures                 are the Runtime's own error types, so a Tool maps the same codes the legacy did
```

Three same-package supersets were added rather than widening a frozen port:
`listWithProbe` (offset pagination over a port without `offset`), `findWithRoot` and `searchWithRoot`
(the resolved root, which `details.path` reports).

### 3.3 Milestone F — the nine builtins

`packages/coding-agent/src/tools/builtins/` — `read_file`, `list_directory`, `find_files`, `search_text`,
`apply_patch`, `exec_command`, `write_stdin`, `git_status`, `git_diff`, each a factory taking its
Operations port and returning a `CodingToolDefinition` whose `tool` field is the canonical `AgentTool`.

Names, descriptions, input schemas, defaults, bounds, details shapes and failure codes are unchanged.
All nine are `SEQUENTIAL`. `DEFAULT_CODING_TOOL_ORDER` declares the frozen order once.

Operations are injected by **closure**, not by a definition field — `CodingToolDefinition` still has no
`operations` member, exactly as the freeze requires.

### 3.4 Milestone D/E/G — partial

```text
security facts vocabulary + nine per-Tool projectors   moved to coding-agent (canonical)
Coding approval identity                               moved to coding-agent (canonical)
Coding effect vocabulary                               split into effects / effect-projectors /
                                                       state-projector / event-projector
Coding output policy                                   moved, delegating to the canonical bounder
prompt snippets + ToolPromptContextProvider            built
```

### 3.5 Two 4A-era constraint relaxations, recorded

`CodingToolSecurityFactsProjector<TFacts>` and `CodingToolEffectProjector<TRequest, TResultDetails,
TEffect>` were declared in Phase 4A with `extends JsonObject` constraints while no concrete projector
existed. The real Coding vocabularies cannot satisfy them: `ToolSecurityFacts` and `ToolEffect` are
named-field interfaces, and TypeScript does not consider an interface without an index signature
assignable to `JsonObject` — an index signature the _nested_ types cannot carry either.

Those constraints were never what made the boundary safe. The value is opaque to `@caelush/agent`, which
carries it inside a `{ kind, payload }` settlement extension and never reads a field; the Coding overlay
is statically typed against its own vocabulary, which is a stronger guarantee. The JSON obligation is
enforced where it matters, at the boundary that writes into anything persisted or emitted, and the casts
are confined to that boundary.

---

## 4. What did NOT land — and therefore why the round is not complete

```text
legacy delegation        packages/tools/src/builtins/*.ts still contain their own business
                         implementations. The nine authoritative implementations exist in
                         coding-agent, but the legacy package has not yet been reduced to
                         delegating facades, so there are currently two implementations of each
                         Tool. That is exactly the "no duplicate business implementation" state
                         the round forbids at completion.

daemon cutover           the daemon still composes the legacy default registrations. Production
                         defaults do not yet originate from @caelush/coding-agent.

prompt integration       the prompt snippets and provider exist, but the integration that stops
                         guidance being appended into AIToolSpec.description and delivers it
                         through Context instead has not been wired into production.

security facts wiring    the legacy projectors are still what the registry adapters use; the
                         canonical ones are not yet the source the admission path reads.

approval identity wiring the legacy computeToolApprovalKey is still what the gate calls; the
                         canonical Coding implementation is not yet wired, so the required
                         byte-identical compatibility test has not been written.

effects wiring           the legacy tool-effects.ts still owns the algorithms the registry and the
                         settlement bridge call; the split canonical modules are not yet the
                         source.

4E tests                 no builtin unit suites, no Operations contract tests, no Runtime adapter
                         tests, no search_text pre-filter counter-example, no git_status
                         path/limit regressions, no fidelity comparisons.

4E architecture guard    tests/architecture/phase-4e-coding-tools-operations-boundaries.test.ts
                         does not exist.

acceptance map           docs/architecture/v2/PHASE_4E_CODING_TOOLS_OPERATIONS_ACCEPTANCE_MAP.md
                         is still the BLOCKED edition; its gate tables have not been updated to
                         RESOLVED, and no final report has been written.

verification gates       build, typecheck and the full suite pass (see §5), but the round's own
                         targeted suites, the guard, the clean checkout and the completion report
                         do not exist yet.
```

Because each of the first six items is a required condition of the round's own completion gate —
notably _"9 Coding builtins target-owned"_ alongside _"no second business implementation"_ — the round
**cannot** be marked `Phase 4E COMPLETE`.

---

## 5. Verification state of the landed work

```text
pnpm build                  PASS  (whole workspace)
pnpm typecheck              PASS
pnpm test                   PASS — 469 files, 2904 passed, 5 skipped, 0 failed
pnpm check:architecture:ci  PASS — 27 baseline entries, 0 new, 0 stale, READY
```

Three guards were corrected, not weakened, because they encoded the state this round was always going
to change:

```text
phase-4b   the transient-update allowlist gains the Coding builtins directory, because exec_command
           and write_stdin publish updates through the Operations onOutput callback — the
           integration Phase 4B's infrastructure was built for
phase-4d   assertions 27 and 28 restated against 4E's target: the nine builtins are composed by the
           Coding default set, and all eight Operations interfaces exist exactly once in Coding
```

The architecture baseline is unchanged at 27 with no new violation, which is the required direction for a
migration that removes ownership from a legacy package.

---

## 6. What remains, in dependency order

```text
1  reduce packages/tools/src/builtins/*.ts to delegating facades over the Coding factories
2  re-point the registry adapters (security facts, effects, approval identity, durable metadata) at
   the canonical Coding implementations
3  wire the prompt provider into the Context path and stop appending guidance to the description
4  cut the daemon default composition over to createDefaultCodingTools + the Runtime adapters
5  write the 4E suites: nine builtin unit suites, Operations contract tests, Runtime adapter tests,
   the search_text pre-filter counter-example, the git_status path and limit>200 regressions, the
   fidelity comparisons, the approve-restart and uncertain E2E
6  add tests/architecture/phase-4e-coding-tools-operations-boundaries.test.ts and the errata guard
7  update the acceptance map to RESOLVED and write the final report
8  run the full gates, the clean checkout and the remote-parity check
```

---

## 7. Status

```text
Phase 4E    IN PROGRESS — errata resolved, product layer landed, migration and verification incomplete
Phase 4F    NOT STARTED
```

No Phase 4F work was performed: `packages/tools` was not deleted, no legacy export was removed,
`protocol.ToolDefinition` was not touched, and no compatibility surface was retired.
