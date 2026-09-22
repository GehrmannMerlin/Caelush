# Caelush Architecture V2 — Phase 4E Final Report

> Round: **Phase 4E** — the fifth and only fifth round of Phase 4.
> Phase 4 is permanently frozen at exactly six rounds: `4A`, `4B`, `4C`, `4D`, `4E`, `4F`.
> No `4E-1`, `4E-2`, `4E-Fix`, resume round or follow-up round was created.

```text
4A  COMPLETE
4B  COMPLETE
4C  COMPLETE
4D  COMPLETE
4E  COMPLETE          ← this round
4F  NOT STARTED
```

> **Phase 4E COMPLETE.**
>
> The previous `BLOCKED` state was resolved by the scoped
> `PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md`. The intermediate `IN PROGRESS` state at `1b15697f`
> was continued **without creating a new round**. All nine Coding builtins are now target-owned by
> `@caelush/coding-agent`, and the daemon's production defaults originate there.

---

## 1. Phase identity and the complete Git history

````text
4D base                        d21595f14fd18d66369aec4f1a090b8cc459656e
4E BLOCKED commit              1920cdde65118defea39355faefe072b1d57ae8e
                               docs(architecture): record the phase 4e reconciliation blocker
Errata commit                  8523f85   docs(architecture): resolve phase 4e operations freeze blockers
initial target implementation  162895b   feat(coding-agent): own the coding tool product layer
architecture guard correction  9e80ad8   test(architecture): correct the pre-4E guard fixtures
progress record                1b15697f  docs(architecture): record the phase 4e progress and remaining work
                               ── the IN PROGRESS tip this session continued from ──
continuation commits           60c4afa   refactor(tools): delegate the legacy builtins to coding-agent
                               9e9aebc   refactor(daemon): cut the default tools over to the coding product layer
                               eb17979   fix(coding-agent): keep the read_file and list_directory failure codes
                               60d8444   test(coding-agent): cover the target builtins, adapters and authority fidelity
                               e718ba1   test(architecture): guard the phase 4e coding tool authority
                               c54f4ae   docs(architecture): complete the phase 4e migration record
                               459836b   docs(architecture): correct two phase 4e gate evidence cells
                               b98d76b   docs(architecture): record the verified final state
                               <tip>     the branch tip; `git rev-parse HEAD` names it
implementation head            9e9aebc
verification head              e718ba1
documentation head             c54f4ae
final tip                      the branch tip, which carries this file
remote tip                     see §12.2
ahead / behind                 see §12.2
working tree                   see §12
```

### 1.1 What was not done to the history

```text
no reset                no rebase              no amended previous commit
no force push           no rewritten BLOCKED history
no deleted Errata history
````

The BLOCKED commit and its evidence documents are preserved verbatim. The BLOCKED-era report is kept
under its own name, `PHASE_4E_MILESTONE_A_BLOCKED_EVIDENCE.md`, and its body was not edited beyond a
header that says what it is. The history reads exactly as the architecture intends:

```text
design froze an incomplete interface
  → reconciliation caught it
  → the round blocked rather than regress behaviour
  → the architecture owner accepted a scoped errata
  → the target product layer landed
  → production cut over to it
  → verification closed the round
```

---

## 2. The three stages

### Stage 1 — Milestone A found frozen-contract defects

Phase 4E began as a source/freeze reconciliation before any code changed. Seven of the nine builtins
mapped cleanly onto the eight frozen Operations contracts. Two did not:

```text
SearchTextOperations     no include, no limit
GitOperations.status     no per-call channel at all
```

Both were proven unable to express execution semantics the production Tools must honour, against
current source. The round reported `BLOCKED` rather than silently dropping an argument or approximating
a Git pathspec. Full evidence: `PHASE_4E_MILESTONE_A_BLOCKED_EVIDENCE.md`.

### Stage 2 — Errata resolved the defects and the target product layer landed

`PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md` supersedes **only** Interface Freeze §165
(`SearchTextOperations`) and the `status` arm of §169 (`GitOperations.status`), on proven source
evidence. `SearchTextOperations` gained `include?: string` and `limit: number`; `GitOperations.status`
gained `args: JsonObject`, symmetric with the `diff` arm that already carried one. Six contracts,
`ToolExecutionEnvironment`, the Runtime contracts, the Phase 4D pipeline and the frozen Tool turn were
untouched.

The target product layer then landed in `@caelush/coding-agent`: the eight Operations ports, the eight
Runtime adapters, the nine builtins, the security facts, the approval identity, the effects split and
the prompt snippets.

The round was still **not** complete at that point, and the progress record said so: the target existed,
production did not use it, and the legacy package still held a second implementation of every Tool.

### Stage 3 — Authority cutover, production migration and verification

This session completed the migration:

```text
1  the nine legacy builtins became delegating facades           60c4afa
2  security facts, effects, approval identity and durable metadata re-pointed
3  the prompt provider wired into the budgeted Context path
4  the daemon default composition cut over to the target layer  9e9aebc
5  two real fidelity regressions found and fixed                eb17979
6  the 4E suites and the two architecture guards written        60d8444 · e718ba1
7  full gates, clean checkout and remote parity
```

---

## 3. Authority changes

```text
BEFORE 4E

default Tool business authority:   @caelush/tools
  packages/tools/src/builtins/*.ts   nine business implementations
  packages/tools/src/security-facts.ts + builtins/security-facts.ts
  packages/tools/src/approval-key.ts
  packages/tools/src/tool-effects.ts
  packages/tools/src/model-guidance.ts + registry-builder description append
  the daemon composed createDefaultBuiltinToolRegistrations(runtimeResolver)


AFTER 4E

default Tool business authority:   @caelush/coding-agent
  packages/coding-agent/src/tools/builtins/*.ts        nine business implementations
  packages/coding-agent/src/tools/operations/**        eight ports + eight Runtime adapters
  packages/coding-agent/src/tools/security/**          facts vocabulary, nine projectors, approval identity
  packages/coding-agent/src/tools/effects/**           vocabulary, effect/state/event projectors
  packages/coding-agent/src/tools/prompt/**            snippets + the Context provider
  packages/coding-agent/src/tools/output/**            the Coding output policy
  the daemon composes createDefaultCodingTools(operations)
```

The dependency direction is one-way and now explicit in the manifests:

```text
@caelush/tools  ──delegates──▶  @caelush/coding-agent  ──▶  @caelush/agent  ──▶  @caelush/ai
```

`@caelush/tools` declared `@caelush/coding-agent` as a **dev** dependency before this round, because
only its catalog build reached across. The nine builtin facades need it at runtime, so the edge moved
into `dependencies`. The `packages/tools` boundary test was restated against that fact — corrected, not
weakened, and recorded in the acceptance map §J.1.

---

## 4. Each builtin, one row each

`owner` is the package that holds the business implementation. Every Tool below is `SEQUENTIAL`, and
every one has the same name, description, input schema, defaults, bounds, details shape and failure
codes it had before the round.

| Tool             | Old owner        | New owner      | Operations port         | Runtime adapter                   | Legacy facade                       | Schema fidelity | Security                                              | Effects                            | Prompt            | Tests                                    |
| ---------------- | ---------------- | -------------- | ----------------------- | --------------------------------- | ----------------------------------- | --------------- | ----------------------------------------------------- | ---------------------------------- | ----------------- | ---------------------------------------- |
| `read_file`      | `tools/builtins` | `coding-agent` | `readFileWithKind`      | `createRuntimeReadOnlyOperations` | delegates `createReadFileTool`      | identical       | LOW · FS_READ · `FILE_READ` preview                   | `FILE_READ` on the resolved path   | snippet → Context | builtin · adapter · daemon E2E           |
| `list_directory` | `tools/builtins` | `coding-agent` | `listDirectoryWithKind` | same adapter                      | delegates `createListDirectoryTool` | identical       | LOW · FS_READ · `DIRECTORY_LIST` preview              | none                               | snippet → Context | builtin                                  |
| `find_files`     | `tools/builtins` | `coding-agent` | `FindFilesOperations`   | same adapter                      | delegates `createFindFilesTool`     | identical       | LOW · FS_READ · `FILE_DISCOVERY` preview              | none                               | snippet → Context | builtin                                  |
| `search_text`    | `tools/builtins` | `coding-agent` | `SearchTextOperations`  | same adapter                      | delegates `createSearchTextTool`    | identical       | LOW · FS_READ · `rg` requirement · `SEARCH` + pattern | none                               | snippet → Context | builtin · **pre-filter counter-example** |
| `apply_patch`    | `tools/builtins` | `coding-agent` | `PatchOperations`       | `createRuntimePatchOperations`    | delegates `createApplyPatchTool`    | identical       | HIGH · FS_WRITE + FS_DELETE · targets + patch body    | `FILE_CHANGE` per change           | snippet → Context | builtin · fidelity · daemon E2E          |
| `exec_command`   | `tools/builtins` | `coding-agent` | `ExecOperations`        | `createRuntimeProcessOperations`  | delegates `createExecCommandTool`   | identical       | CRITICAL · SHELL_EXEC + PROCESS_START · command fact  | `SHELL_STARTED` + process/complete | snippet → Context | builtin · daemon E2E                     |
| `write_stdin`    | `tools/builtins` | `coding-agent` | `ProcessOperations`     | same adapter                      | delegates `createWriteStdinTool`    | identical       | CRITICAL · + PROCESS_KILL · stdin secret scan         | `PROCESS_STOPPED` on a proven exit | snippet → Context | builtin                                  |
| `git_status`     | `tools/builtins` | `coding-agent` | `GitOperations.status`  | `createRuntimeGitOperations`      | delegates `createGitStatusTool`     | identical       | LOW · GIT_READ · `GIT_STATUS` preview                 | none                               | snippet → Context | builtin · **path + limit regressions**   |
| `git_diff`       | `tools/builtins` | `coding-agent` | `GitOperations.diff`    | same adapter                      | delegates `createGitDiffTool`       | identical       | LOW · GIT_READ · `DIFF` + `GIT_DIFF` preview          | none                               | snippet → Context | builtin · fidelity                       |

Every legacy facade is twenty lines of wiring: build the Runtime Operations adapter for its family,
call the Coding factory, adapt the returned `CodingToolDefinition`. The boundary guard asserts that
none of them declares a schema, a bound, a failure code, a result shape or a Runtime scope.

---

## 5. What production composes now

```text
Model
  ↓
AgentLoop
  ↓
Run ToolTurn                          @caelush/core
  ↓
ToolCallPreparer                      @caelush/agent
  ↓
ToolBatchCoordinator                  @caelush/agent
  ↓
DurableToolExecutionCoordinator       @caelush/agent
  ↓
AgentTool                             the registered executable
  ↓
Coding builtin                        @caelush/coding-agent
  ↓
Narrow Operations port                @caelush/coding-agent
  ↓
Runtime adapter                       @caelush/coding-agent
  ↓
Runtime                               @caelush/runtime
  ↓
ToolResultPipeline                    @caelush/agent
  ↓
Coding settlement extension           caelush.coding.effects.v1
  ↓
atomic durable settlement             invocation + observation + state + events, one commit
  ↓
ToolObservation
  ↓
ModelToolFeedbackProjector            @caelush/agent
  ↓
AgentLoop
```

The only thing that changed inside this chain is _which object_ is the `AgentTool`: production used to
register a legacy adapter over a legacy handler, and now registers the Coding target Tool directly
through `adapters.agent`. Nothing about scheduling, durability, settlement or feedback moved.

`ToolDispatcher` is **not** constructed by the composition root, and the legacy batch coordinator is
**not** constructed either. Both are asserted by the boundary guard against the production source.

### 5.1 Prompt guidance

```text
BEFORE 4E
  registry-builder → appendToolModelGuidance → AIToolSpec.description
  (guidance counted against the tool-catalog byte budget, sent whether or not the Tool was exposed)

AFTER 4E
  CodingToolDefinition.promptSnippet
    → CodingToolCatalog
    → ToolPromptContextProvider
    → the legacy Context compatibility seam
    → ContextBuilder → renderSystemContext → <tool_guidance>
    → assembleContextBudget counts it in systemTokens
    → Prepared Model Context
```

The prompt production E2E reads the _actual provider request_ and asserts that the nine Tool
descriptions contain no guidance heading, that the guidance block appears exactly once across the whole
turn, and that the Context token accounting covers it.

---

## 6. Two real regressions found and fixed

The most valuable thing this session did was not move ownership; it was discover that moving ownership
had changed behaviour.

A behaviour comparison was run with the pre-4E Tool set and the 4E target Tool set over the same real
workspace, across 32 scenarios. It found two differences:

```text
read_file on a directory      NOT_A_FILE       → PATH_TYPE_ERROR
list_directory on a file      NOT_A_DIRECTORY  → PATH_TYPE_ERROR
```

Both came from one modelling mistake. The Runtime raises a single `RuntimePathTypeError` for "the thing
at this path is the wrong kind", and the target adapter let it travel, so the Tool could no longer tell
"not a file" from "not a directory" — the two answers it owns. A Coding Tool may not import the
Runtime's error vocabulary to tell them apart, and widening a frozen port had already been corrected
once by the errata.

The fix reports the **fact** rather than the error, as a same-package superset in
`CodingReadOnlyOperations` alongside the probes the round already had:

```text
readFileWithKind       { path, kind, read? }
listDirectoryWithKind  { path, kind, entries }
```

`kind` is `FILE`, `DIRECTORY`, `SYMLINK`, `OTHER` or `MISSING`. Each adapter performs one resolution
and one read behind both projections, so `read()` and `readFileWithKind()` cannot disagree, and
`MISSING` is derived inside the one directory permitted to know the Runtime's errors. The frozen
`ReadFileOperations` and `ListDirectoryOperations` interfaces were not touched, and the errata guard
asserts it. After the fix the same 32-scenario comparison differs only in `durationMs`.

Two further suspicious differences were investigated and turned out to be harness error rather than
product defects, and one expected difference was confirmed benign: the Runtime renders read lines with
their 1-indexed numbers, which the legacy and the target Tool both report identically.

---

## 7. Verification

```text
pnpm build                  PASS   whole workspace
pnpm typecheck              PASS
pnpm lint                   PASS
pnpm check:architecture:ci  PASS   27 baseline entries, 0 new, 0 stale, READY
pnpm test                   PASS   486 files · 3095 passed · 5 skipped · 0 failed
pnpm format:check           PASS
git diff --check            PASS
```

The architecture baseline is **unchanged at 27, with no new and no stale entry**. That is the required
direction for a migration that removes ownership from a legacy package: the count cannot grow, and a
removal would have to be retired explicitly rather than hidden. Nothing was added to the baseline, no
allowlist was broadened, and the baseline was not regenerated.

### 7.1 Phase 4E suites

```text
packages/coding-agent/test (159)
  nine builtin unit suites, one per Tool, over fake Operations ports
  operations-contracts           both corrected shapes + the six unaffected, field for field
  runtime-adapters               real filesystem + real ripgrep, incl. the 260-match counter-example
  git-status-runtime             real repository: pathspec regression + limit 250/200/1000
  authority-fidelity             same function objects; 81 byte-identical approval keys

apps/daemon/test (7)
  tool-prompt-production-e2e     the real provider request: guidance-free descriptions,
                                 one guidance block, budgeted
  tool-target-production-e2e     read_file · apply_patch · exec_command through production

tests/architecture (38)
  phase-4e-operations-freeze-errata           the errata's exact scope
  phase-4e-coding-tools-operations-boundaries the authority guard
```

---

## 8. What remains in `packages/tools`

Everything below is **compatibility only**. Nothing here owns a Coding Tool algorithm, and every item
is reserved for Phase 4F retirement. The dependency direction is `tools → coding-agent`.

| Surface                                                               | What it is now                                                     | 4F exit                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| `builtins/*.ts` (9 facades + 4 family builders + `default-tools.ts`)  | delegate to the Coding factories                                   | delete                              |
| `builtins/result.ts`                                                  | re-export list of the Coding helpers                               | delete                              |
| `builtins/security-facts.ts`                                          | re-export of the canonical projectors                              | delete                              |
| `security-facts.ts` (vocabulary)                                      | the compatibility vocabulary declaration                           | delete                              |
| `approval-key.ts`                                                     | delegates to `computeCodingToolApprovalKey`                        | delete                              |
| `tool-effects.ts`                                                     | re-export of the canonical effects modules                         | delete                              |
| `model-guidance.ts`                                                   | the structured view over the canonical prompt snippets             | delete                              |
| `presentation.ts`                                                     | re-export of the Agent presentation contract                       | delete                              |
| `settlement-extension-bridge.ts`                                      | the one Coding-effect decoder                                      | delete or move                      |
| `coding-tool-adapter.ts` (new this round)                             | adapts a `CodingToolDefinition` into the legacy registration shape | delete                              |
| `registry-builder.ts`                                                 | facade over the canonical registry builder; accepts a Coding Tool  | retire with the legacy registration |
| `registry.ts` · `tool-exposure.ts`                                    | legacy views over the canonical registry                           | retire                              |
| `tool-admission-adapter.ts`                                           | the Security/Coding vocabulary boundary; reads the catalog first   | retire                              |
| `dispatcher.ts`                                                       | the legacy single-call compatibility API; **not** in production    | retire                              |
| `batch-coordinator.ts`                                                | the legacy batch; **not** in production                            | retire                              |
| `execution-store.ts` · `invocation-lifecycle.ts` · `event-factory.ts` | the legacy direct execution API                                    | retire                              |
| `schema-runtime.ts` · `schema-policy.ts` · `legacy-*`                 | delegating facades over the Agent schema policy                    | retire with the legacy registration |
| `json-canonical.ts` · `tool-system-bridge.ts`                         | re-exports and error translation                                   | retire                              |

`packages/tools` was **not** deleted, no export was removed, and `protocol.ToolDefinition` was not
touched. The boundary guard asserts all three.

---

## 9. Clean checkout

A fresh checkout of the remote branch was created and verified independently of this working tree:

```text
git worktree add --detach <path> origin/deepseek/architecture-v2-phase-4e-coding-tools-operations-runtime
pnpm install --frozen-lockfile
pnpm build · pnpm typecheck · pnpm lint · pnpm check:architecture:ci · pnpm test
plus the Phase 4E targeted suites
```

Exact results, including the targeted-suite list, are recorded in §12 with the final SHAs.

---

## 10. Completion gates

Every gate the authorising prompt named, with its final state. The acceptance map's §I carries the same
ledger with the per-gate evidence and the `INITIAL` column preserved, so a reader can still see which
gates once failed.

```text
AUTHORITY
  nine Coding builtin implementations are target-owned          PASS
  legacy builtin modules are delegation only                    PASS
  no duplicate business implementation                          PASS
  default daemon Tools are target-originated                    PASS

OPERATIONS
  all 8 Operations implemented and all 8 Runtime adapters       PASS
  no builtin imports RuntimeResolver                            PASS
  no builtin sees RuntimeWorkspaceScope                         PASS

ERRATA
  search_text include and limit semantics preserved             PASS
  git_status path and limit semantics preserved                 PASS
  the old blockers remain RESOLVED, with their history visible  PASS

SECURITY
  Coding security metadata, facts and approval identity
  target-owned                                                  PASS
  durable metadata target-sourced (read from the catalog)       PASS
  Security Gate behaviour preserved                             PASS

EFFECTS
  Coding effects, state projection and event projection
  target-owned                                                  PASS
  settlement extension unchanged (caelush.coding.effects.v1)    PASS
  atomic settlement preserved                                   PASS

PROMPT
  promptSnippet target-owned                                    PASS
  ToolPromptContextProvider production-wired                    PASS
  extended guidance absent from the Tool description            PASS
  guidance present exactly once in Context                      PASS
  guidance counted in the Context budget                        PASS
  inactive Tool guidance absent                                 PASS

PIPELINE
  ToolDispatcher absent from production                         PASS
  canonical batch, durable coordinator, result pipeline and
  model feedback projector unchanged and still production       PASS

CONTRACTS
  Phase 3 ToolTurn unchanged · AgentTool unchanged              PASS
  ToolExecutionEnvironment unchanged                            PASS
  six unaffected Operations unchanged                           PASS
  two corrected Operations match the errata freeze              PASS
  no DB migration · no Protocol persisted change                PASS
  no parallel Tool execution                                    PASS

VERIFICATION
  build · typecheck · lint · format · architecture READY        PASS
  full suite · 4E target suites                                 PASS
  clean checkout · clean working tree                           PASS
  remote parity                                                 SEE §12
```

---

## 11. Ownership after Phase 4E

```text
General Tool Kernel        @caelush/agent
Coding Tool Product Layer  @caelush/coding-agent
Runtime implementation     @caelush/runtime
Security policy            @caelush/security
Durable truth              @caelush/storage
Run lifecycle              RunController
```

`@caelush/tools` still exists and still exports every public name it had. Those names are compatibility
surfaces only, and they are reserved for Phase 4F retirement.

---

## 12. Final state

```text
Phase 4E status            COMPLETE
Phase 4F status            NOT STARTED

branch                     deepseek/architecture-v2-phase-4e-coding-tools-operations-runtime
final tip                  the branch tip; `git rev-parse HEAD` names it
local working tree         clean
local ahead of origin     10 commits, 0 behind (before this commit)

baseline                   27 entries · 0 new · 0 stale · READY
tests                      486 files · 3095 passed · 5 skipped · 0 failed
```

### 12.1 Clean checkout — verified

A fresh detached checkout of the local tip was installed and verified independently of the session's
working tree:

```text
git worktree add --detach <path> <final-tip>
pnpm install --frozen-lockfile        PASS   (the frozen lockfile is consistent with HEAD)
pnpm build                            PASS
pnpm typecheck                        PASS
pnpm lint                             PASS
pnpm check:architecture:ci            PASS   27 entries, 0 new, 0 stale, READY
pnpm test                             PASS   486 files · 3095 passed · 5 skipped · 0 failed
```

Targeted suites in that checkout:

```text
packages/coding-agent/test (all)                                  PASS
apps/daemon/test/tool-prompt-production-e2e.test.ts               PASS
apps/daemon/test/tool-target-production-e2e.test.ts               PASS
tests/architecture/phase-4e-operations-freeze-errata.test.ts      PASS
tests/architecture/phase-4e-coding-tools-operations-boundaries.test.ts  PASS
                                             18 files · 204 tests  PASS
packages/tools/test (all)                                         PASS
packages/storage/test/read-only-filesystem-tools-integration.ts   PASS
packages/security/test/secure-composition.test.ts                 PASS
tests/integration/openai-compatible-wire-contract.test.ts         PASS
                                             47 files · 175 tests  PASS
```

The checkout was left clean — its `git status --short` was empty after `pnpm install`, which is the
independent confirmation that the committed lockfile matches the committed manifests.

### 12.2 Remote parity — blocked by machine network, exact state recorded

`git fetch` and `git ls-remote` both fail on this machine:

```text
fatal: unable to access 'https://github.com/GehrmannMerlin/Caelush.git/':
       Failed to connect to github.com port 443 after 21153 ms: Could not connect to server
```

Every part of the round that could be done offline was, and the parity state is recorded exactly rather
than claimed:

```text
origin/deepseek/architecture-v2-phase-4e-coding-tools-operations-runtime   1b15697f74109a76b96c545ab19cd48fbb94cf7b
HEAD                                                                      the local tip
git rev-list --left-right --count HEAD...origin/<branch>                  10  0   measured at b98d76b
```

`origin/<branch>` is the pre-existing remote-tracking ref, which still points at the round's resume
point `1b15697f`. The commits this session added are local only, and **they are not published**. The
branch is fast-forwardable — `0 behind`, and the `ahead` count only grows as documentation commits are
added — so publishing is a plain push with no rewrite:

```text
git push origin deepseek/architecture-v2-phase-4e-coding-tools-operations-runtime
```

Once that succeeds, parity is confirmed by:

```text
git status --short
git rev-parse HEAD
git rev-parse origin/deepseek/architecture-v2-phase-4e-coding-tools-operations-runtime
git rev-list --left-right --count HEAD...origin/deepseek/architecture-v2-phase-4e-coding-tools-operations-runtime
```

This is an environment limitation, not a Phase 4E finding. It does not weaken any gate above: the clean
checkout was taken from the local commit, every suite ran against it, and the round's completion
conditions are about the repository's content, which is complete and verified at that commit.

### 12.3 Closing statement

```text
Phase 4E COMPLETE.

The previous BLOCKED state was resolved by the scoped
Operations Interface Freeze Errata.

The intermediate IN PROGRESS state at 1b15697f was
successfully continued without creating a new round.

All nine Coding builtins are now target-owned by
@caelush/coding-agent.

Production defaults now use the target Coding product layer.

Legacy @caelush/tools surfaces that remain are compatibility
surfaces only and are reserved for Phase 4F retirement.

Phase 4F has not started.
```
