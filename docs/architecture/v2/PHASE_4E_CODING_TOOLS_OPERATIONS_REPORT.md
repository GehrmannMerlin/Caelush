# Caelush Architecture V2 — Phase 4E Coding Tools, Operations Ports & Runtime Adapters Report

> Round: **Phase 4E** — the fifth and only fifth round of Phase 4.
> Phase 4 is permanently frozen at exactly six rounds: `4A`, `4B`, `4C`, `4D`, `4E`, `4F`.
> No `4E-1`, `4E-2`, `4E-A`, `4E-B`, `4E-Fix`, `4G`, cleanup round, follow-up round or post-4E
> migration round was created.

```text
4A  COMPLETE
4B  COMPLETE
4C  COMPLETE
4D  COMPLETE
4E  BLOCKED          ← this round
4F  NOT STARTED
```

> **Phase 4E BLOCKED.**
> Two of the eight frozen Operations contracts cannot express arguments that two of the nine builtins
> are currently required to honour. The authorising prompt forbids widening those interfaces and
> forbids silently dropping the arguments, and it makes the reconciliation gates a Milestone A
> decision — `implementable` or `BLOCKED` — _before_ any Tool is migrated. Both gates failed against
> source evidence, so the round stopped at Milestone A. **No production code was changed.**

---

## 1. Phase identity and SHAs

The authorising prompt requires these concepts to be recorded separately, because the Phase 4D final
tip is a _documentation_ commit, not the implementation commit.

```text
Base SHA                     d21595f14fd18d66369aec4f1a090b8cc459656e
                             (Phase 4D final tip; commit message
                              "docs(architecture): record the phase 4d clean-checkout verification")

Implementation code head     14d7a3ca5a079e3108d1287954d868a18222f63f
                             ("docs(architecture): record phase 4d migration" is the last commit
                              that follows all 4D code; the code itself landed in
                              de03cb5, de94401, dadb1cc, 90e121d)

Verification head            the environment in which 4D's gates were run is the 4D clean checkout at
                             d21595f, recorded in PHASE_4D_BATCH_FEEDBACK_TOOLTURN_REPORT.md §14-16

Documentation/report head    d21595f14fd18d66369aec4f1a090b8cc459656e
                             (4D's final report edit; this is the 4E base)

Final branch tip             see §9 for this round's tip
Remote branch tip            see §9
Ahead/behind                 see §9
Working tree                 clean
```

For Phase 4D, the implementation head and the documentation head are **not** the same commit; the base
for Phase 4E is that documentation tip, which is recorded here rather than described as "the code
commit itself".

### 1.1 Baseline verification performed before any analysis

```text
git status --short                                       clean
git branch --show-current                                deepseek/architecture-v2-phase-4d-batch-feedback-toolturn-cutover
git rev-parse HEAD                                       d21595f14fd18d66369aec4f1a090b8cc459656e
git fetch origin                                         ok
git merge-base --is-ancestor d21595f... HEAD             exit 0
git ls-remote --heads origin <4E branch>                 empty (the 4E branch did not exist)
```

The Phase 4E branch was created **from `d21595f`**. No work started from `master`, 4A, 4B, 4C,
`14d7a3c`, `90e121d` or any earlier commit.

---

## 2. Authorising specifications read

```text
Caelush_Tool_System_V2_Refactor_Spec.md                         4016 lines, read in full
Caelush_Tool_System_V2_Current_to_Target_Interface_Freeze.md    6197 lines, read in full
```

Both were located outside the repository tree (Phase 4C and 4D already recorded that `git ls-files`
finds neither) and read from their authorising copies. The Operations freeze clauses §160–§172 and the
Refactor Spec §91–§97 were read in full for this round. **No clause number in this report or in the
Acceptance Map is fabricated, and no repository file is claimed to have been read that does not exist.**

Also read: `AGENTS.md`, `MIGRATION_EXECUTION_CONTRACT.md`, `PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md`, the
4A/4B/4C/4D acceptance maps and reports, `PHASE_3_FROZEN_CLAUSE_ACCEPTANCE_MAP.md`,
`PHASE_3F_AGENT_LOOP_CLOSURE_REPORT.md`, `scripts/architecture/v2-rules.mjs`,
`scripts/architecture/legacy-import-baseline.json`.

---

## 3. Source scanned

```text
packages/coding-agent/src/tools/**          coding-tool-definition.ts, coding-tool-catalog.ts,
                                            coding-tool-catalog-builder.ts, security-metadata.ts,
                                            legacy-argument-normalization.ts, index.ts
packages/coding-agent/package.json          dependencies: agent, ai, protocol, runtime
packages/coding-agent/tsconfig.json

packages/tools/src/builtins/**              all nine builtins + default-tools, result, security-facts,
                                            and the four grouping modules
packages/tools/src/security-facts.ts        packages/tools/src/tool-effects.ts
packages/tools/src/model-guidance.ts        packages/tools/src/presentation.ts
packages/tools/src/output-policy.ts         packages/tools/src/approval-key.ts
packages/tools/src/tool-admission-adapter.ts
packages/tools/src/settlement-extension-bridge.ts
packages/tools/src/registration.ts          packages/tools/src/registry.ts
packages/tools/src/registry-builder.ts      packages/tools/src/tool-adapters.ts
packages/tools/src/tool-exposure.ts         packages/tools/src/tool-system-bridge.ts
packages/tools/src/index.ts                 packages/tools/package.json

packages/runtime/src/runtime.ts             packages/runtime/src/runtime-ref.ts
packages/runtime/src/workspace-scope.ts     packages/runtime/src/workspace-path.ts
packages/runtime/src/search/text-search.ts  packages/runtime/src/search/ripgrep-runner.ts
packages/runtime/src/git/contracts.ts       packages/runtime/src/git/service.ts
packages/runtime/src/git/status-parser.ts   packages/runtime/src/filesystem/**
packages/runtime/src/discovery/**           packages/runtime/src/patch/**  packages/runtime/src/exec/**

packages/security/src/tool-gate.ts
packages/security/src/tool-result-sanitizer.ts
packages/security/src/tool-update-sanitizer.ts

packages/agent/src/tools/**                 packages/agent/src/loop/types.ts
packages/agent/src/index.ts

packages/core/src/legacy-context-runtime-adapter.ts
packages/core/src/run-tool-turn-coordinator.ts
packages/context/src/index.ts and the builder/renderer/item/budget modules

apps/daemon/src/daemon-composition.ts
apps/daemon/test/daemon-composition.test.ts (the toolRegistry.modelGuidance() assertion)

packages/tools/test/**  (44 files, enumerated)
```

### 3.1 Phase 4D source state verified

```text
canonical ToolBatchCoordinator / ToolResultBatchNormalizer / ModelToolFeedbackProjector exist in agent
RunController.toolTurn is a ToolTurnPipeline
daemon composes createToolBatchCoordinator + createModelToolFeedbackProjector +
  createToolResultBatchNormalizer, and constructs no legacy ToolBatchCoordinator and no ToolDispatcher
architecture baseline: 27 entries, 0 new violations, 0 stale, READY
```

---

## 4. The blocking condition

The round has a documented _decision point_ before implementation. It states that if the scan cannot
prove a legal implementation exists, the round must report `BLOCKED`, and that it must not migrate half
the Tools and come back later. Both required reconciliation gates failed.

### 4.1 Blocker 1 — `GitOperations.status` cannot express `git_status.path`

**Frozen contract** (Interface Freeze §169, restated verbatim in the prompt §40):

```ts
status(input: {
  readonly environment: ToolExecutionEnvironment;
  readonly signal: AbortSignal;
}): Promise<JsonObject>;
```

**Current source** (`packages/tools/src/builtins/git-status.ts`):

```text
line 19     inputSchema.properties.path   { type: "string", "Workspace-relative pathspec." }
line 20-26  inputSchema.properties.limit  { integer, minimum 1, maximum 1000, default 200 }
line 78-82  scope.git.status({ path?, limit, signal? })
```

**Runtime evidence** (`packages/runtime/src/git/service.ts`, `status-parser.ts`):

```text
service.ts:49      const path = this.resolvePath(input.path ?? ".")
service.ts:55-71   git status --porcelain=v2 -z --branch --untracked-files=all ... -- <path>
service.ts:74      parseGitStatus(decodeStrict(result.stdout), limit)
status-parser.ts:65  entries.sort((l, r) => l.path.localeCompare(r.path, "en"))
status-parser.ts:72  entries: sorted.slice(0, limit), truncated: sorted.length > limit
```

`path` is a **real Git pathspec handed to the `git status` invocation**: it decides which paths Git
reports at all. `limit` then truncates the sorted result.

**Exact conflict.** `GitOperations.status({ environment, signal })` has no channel for a per-call
pathspec, and every candidate channel is closed by source evidence:

| Channel                            | Why it cannot carry a pathspec                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`                      | `ToolExecutionEnvironment` is exactly `{ workspace, runtime }` (`packages/agent/src/tools/types/execution-environment.ts:21-24`); `WorkspaceRef` is `{ id, path }`. Neither is a Git pathspec. |
| a second interface method          | §169 freezes `GitOperations` to exactly `status` and `diff`.                                                                                                                                   |
| `signal`                           | an `AbortSignal` is not a pathspec.                                                                                                                                                            |
| adapter construction               | §161 allows a resolver at construction time, but `path` **varies per call**; a constructor closure cannot see the call's argument.                                                             |
| Tool-side filtering after the fact | Git's pathspec semantics include globs and `:(glob)`, `:(icase)`, `:(exclude)` magic; the prompt forbids a `startsWith` simulation and no such simulation is equivalent.                       |

Note the asymmetry that makes this decisive rather than an oversight: `GitOperations.diff` **does**
carry `args` (§169), and §42 of the prompt explicitly allows both `scope` and `path` through it. The
freeze therefore knows how to carry per-call arguments — `status` deliberately does not.

### 4.2 Blocker 2 — `SearchTextOperations.search` cannot express `search_text.include` / `limit`

**Frozen contract** (Interface Freeze §165, restated verbatim in the prompt §30):

```ts
search(input: {
  readonly environment: ToolExecutionEnvironment;
  readonly pattern: string;
  readonly path?: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly matches: readonly JsonObject[]; readonly truncated: boolean }>;
```

The prompt states it explicitly: _"Frozen interface **没有** `include` / `limit`. 绝对不能直接加进去."_

**Current source** (`packages/tools/src/builtins/search-text.ts`):

```text
line 40      inputSchema.properties.include  { type: "string", minLength: 1 }
line 41-47   inputSchema.properties.limit    { integer, minimum 1, maximum 200, default 100 }
line 116     limit = positiveBoundedInteger(args.limit, 100, 200)
line 133-139 scope.textSearch.search({ cwd, pattern, include?, limit: limit + 1 })
line 149     for (const match of result.matches.slice(0, limit))
line 168     truncated = result.truncated || result.matches.length > limit
```

**Runtime evidence** (`packages/runtime/src/search/ripgrep-runner.ts`, `text-search.ts`):

```text
ripgrep-runner.ts:30     if (request.include !== undefined) args.push("--glob", request.include)
ripgrep-runner.ts:103-4  matches: parsed.slice(0, request.limit), truncated: parsed.length > request.limit
ripgrep-runner.ts:78     (capped path) matches: parsed.slice(0, request.limit), truncated: true
ripgrep-runner.ts:56-59  ripgrep is killed once MAX_RG_STDOUT_BYTES (1 MiB) is exceeded
text-search.ts:6         readonly limit: number;      ← required, not optional
```

`include` becomes ripgrep's `--glob`, a **path-level pre-filter applied before ripgrep stops
collecting**, and `limit` truncates the match list before the Tool sees it.

**Exact conflict.** The only treatment the prompt permits is pure Tool-side deterministic
post-processing:

```text
operations.search({ environment, pattern, path, signal })   // no include
   → runtime returns at most request.limit matches
   → the Tool filters them by the include glob itself
```

A pre-filter and a post-filter do not see the same input. The frozen interface's own `limit` parameter
is the ceiling the Operations port can request, and the ripgrep adapter caps stdout at 1 MiB before
either limit applies, so the Tool can never obtain the true match set. Two divergences are reachable
with ordinary inputs:

```text
1. spurious truncation
   default limit = 100, so the Tool may request at most 200
   a monorepo where one file has >= 200 matching lines and the include-glob target sorts after it
   current : ripgrep globs first -> only the target file is searched -> 3 matches -> truncated = false
   proposed: the runtime returns 200 matches, all from the other file -> the filtered set is empty
             -> matches = [] and truncated = true     ← content and flag both differ

2. an empty result where the current behaviour finds matches
   with `include` set, the intended file's matches may never appear within the first `limit`
   entries the runtime is willing to return, so the Tool reports "No matches found." for a file
   that demonstrably contains the pattern
```

### 4.3 Mappings attempted, and why each is not legal

| Attempt                                                                      | Verdict                                                                                                    |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| filter tool-side over an unbounded runtime result                            | impossible: `RuntimeTextSearchRequest.limit` is required and the adapter slices at it                      |
| request the observed maximum (200) and filter                                | divergence remains reachable                                                                               |
| request `Number.MAX_SAFE_INTEGER`                                            | the adapter kills ripgrep at 1 MiB stdout and returns a partial list with `truncated: true`                |
| fold `include` into `pattern`                                                | forbidden, and it would change regex semantics                                                             |
| drop `include` / drop `limit`                                                | forbidden: a silent behaviour regression                                                                   |
| widen `SearchTextOperations`                                                 | forbidden; also an explicit `BLOCKED` trigger                                                              |
| carry the parameters out of band                                             | forbidden (hidden global state / AsyncLocalStorage)                                                        |
| let the builtin construct its own Runtime adapter per call to bind `include` | requires importing `RuntimeResolver` / `RuntimeWorkspaceScope` into builtin code, which the prompt forbids |
| filter git entries tool-side after calling `status()` with no pathspec       | changes which paths Git reports at all; cannot reproduce pathspec globs or magic                           |
| accept the runtime's default `limit` of 200 for `git_status`                 | the Tool allows 1000; entries past 200 are permanently lost, changing `entries` and `truncated`            |
| add `args` / `path` / `limit` to `GitOperations.status`                      | forbidden; also an explicit `BLOCKED` trigger                                                              |

---

## 5. What was deliberately not done

```text
no builtin migrated to @caelush/coding-agent
no Operations interface created (Milestone B not started)
no Runtime Operations adapter created (Milestone C not started)
no security facts / approval identity / effects / presentation move (Milestones D, E, G)
no prompt-context integration (Milestone G)
no production composition change (Milestone H)
no architecture guard added (Milestone I)
no packages/tools file deleted, no export removed, no protocol.ToolDefinition touched
no test assertion deleted, weakened, or skipped
no architecture baseline regenerated
```

The round plan explicitly forbids migrating part of the Tools and returning later
(_"不要先迁一半其他 Tool 再回来"_), so the seven reconcilable builtins were **not** partially migrated.
Their fidelity analysis is preserved in the Acceptance Map §H so a future decision does not have to
repeat it.

---

## 6. Verification state

Because no code was written, the gates were run only to confirm the untouched baseline still holds.

```text
pnpm build                    PASS (unchanged tree)
pnpm typecheck                PASS
pnpm lint                     PASS
pnpm check:architecture:ci    PASS — 27 baseline entries, 0 new, 0 stale, READY
```

Architecture baseline before → after:

```text
                                  BEFORE              AFTER
baseline entries                  27                  27
new violations                    0                   0
stale baseline entries            0                   0
readiness                         READY               READY
```

The full-suite gate and the clean-checkout gate were **not** run for this round, because a round with no
code change adds no new evidence to them: the 4D clean-checkout record in
`PHASE_4D_BATCH_FEEDBACK_TOOLTURN_REPORT.md` §14–16 still describes the exact tree this round starts
from, and this round changes only two Markdown files and one status line.

---

## 7. Minimum architecture decision required

Neither blocker is a Phase 4F concern, and neither is a coding problem. Both are missing statements in
the freeze: it does not say how a Tool's per-call search/filter arguments reach its narrow Operations
port. One decision resolves each.

### 7.1 For `search_text`

Amend `SearchTextOperations` (§165) to carry the two arguments the Tool already exposes to the model:

```ts
search(input: {
  readonly environment: ToolExecutionEnvironment;
  readonly pattern: string;
  readonly path?: string;
  readonly include?: string;        // ripgrep-compatible include glob
  readonly limit: number;           // maximum matches the caller wants
  readonly signal: AbortSignal;
}): Promise<{ readonly matches: readonly JsonObject[]; readonly truncated: boolean }>;
```

This preserves everything the prompt requires — the Tool keeps its `include` and `limit`, the adapter
still owns ripgrep and the glob, workspace containment and truncation semantics are unchanged, and the
Tool still never touches `RuntimeResolver`. It removes both divergences because the glob is applied by
ripgrep _before_ truncation, exactly as today.

_Alternative, if `include` is to leave the Operations port on purpose:_ the freeze must state that
`search_text`'s `include` is a Tool-side filter with **documented, bounded divergence** — i.e. that a
result set truncated by the port's `limit` may under-report. That is a deliberate product decision, not
something a migration round may decide silently.

### 7.2 For `git_status`

Amend `GitOperations` (§169) symmetrically with the `diff` arm that already carries `args`:

```ts
status(input: {
  readonly environment: ToolExecutionEnvironment;
  readonly args: JsonObject;        // { path?, limit? } — the same per-call arguments diff already takes
  readonly signal: AbortSignal;
}): Promise<JsonObject>;
```

This keeps the Git pathspec resolved and applied by Runtime/Git itself — which is the only place it can
be applied faithfully — passes `limit` through to `RuntimeGitService.status`, keeps the Tool schema and
observable behaviour byte-identical, and keeps the Tool free of any Runtime dependency.

_Alternative:_ the freeze states that `git_status` no longer supports a pathspec and that its
provider-visible schema is reduced accordingly. That is a deliberate, recorded product decision and a
breaking change to a model-facing schema, so it cannot be made inside a migration round whose brief is
_behaviour first_.

### 7.3 What must not be the resolution

```text
dropping include / limit / path silently
approximating a Git pathspec with string matching
widening the interfaces inside a migration round without the freeze saying so
using hidden global state to smuggle per-call arguments into an adapter
letting builtin code import RuntimeResolver or RuntimeWorkspaceScope to work around the gap
```

---

## 8. Phase 4E status

```text
Milestone A  source/freeze reconciliation + Acceptance Map      COMPLETE
             — and it is the milestone that produced the BLOCKED verdict

Milestone B  Frozen Operations contracts                        NOT STARTED
Milestone C  Runtime Operations adapters                        NOT STARTED
Milestone D  Coding security metadata/facts/approval identity   NOT STARTED
Milestone E  Coding effects + atomic-settlement bridge          NOT STARTED
Milestone F  Nine builtin migration                             NOT STARTED
Milestone G  Presentation + promptSnippet + Context integration NOT STARTED
Milestone H  Production default composition cutover             NOT STARTED
Milestone I  Compatibility facades + architecture guards        NOT STARTED
Milestone J  Full verification + clean checkout + report        PARTIAL (report only; no code to verify)
```

---

## 9. Git record

```text
Base SHA                     d21595f14fd18d66369aec4f1a090b8cc459656e
Branch                       deepseek/architecture-v2-phase-4e-coding-tools-operations-runtime
Implementation code head     none — no production code was changed in this round
Verification head            d21595f (the 4D clean-checkout tree; gates re-run and still green)
Documentation head           this round's commit
Final branch tip             this round's commit (recorded on push)
Remote branch tip            identical to the final branch tip, verified with git ls-remote
Ahead/behind                 0 / 0
Working tree                 clean
```

Commits in this round:

```text
docs(architecture): record the phase 4e reconciliation blocker
```

No force push, no `merge master`, no rebase of 4A–4D, no history rewrite, no release, no deploy and no
package publish was performed.

---

## 10. Exactly what is still true after this round

```text
the production Tool chain is unchanged and still the 4D canonical one:
  AgentLoop -> Run ToolTurn -> canonical ToolBatchCoordinator -> ToolCallPreparer
    -> DurableToolExecutionCoordinator -> ToolInvocationExecutor -> AgentTool.execute()
    -> ToolResultPipeline -> atomic settlement -> Durable ToolObservation
    -> ModelToolFeedbackProjector -> AIToolResultMessage -> AgentLoop

the nine builtins are still owned by @caelush/tools
no Operations interface exists yet
prompt guidance is still appended into AIToolSpec.description by the legacy registry builder
@caelush/coding-agent still owns only the catalog, the definition contract and the argument normalization
packages/tools is intact
protocol.ToolDefinition is intact
```

---

## 11. Closing statement

Two frozen Operations contracts, §165 and §169, cannot carry arguments that the corresponding
production Tools are required to honour — `search_text`'s `include`/`limit` and `git_status`'s
`path`/`limit`. The authorising prompt forbids widening those interfaces, forbids dropping the
arguments, forbids approximating a Git pathspec, and states that a gate which cannot be proven must be
reported rather than worked around. The round therefore stops at its own decision point, with the
evidence recorded and the minimum architecture decision named, rather than regressing two Tool
behaviours or silently rewriting two model-facing schemas inside a migration round.

```text
Phase 4E BLOCKED.
Phase 4F has not started.
```
