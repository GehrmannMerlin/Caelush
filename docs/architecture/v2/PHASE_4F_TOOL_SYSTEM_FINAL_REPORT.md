# Caelush Architecture V2 — Phase 4F Final Report

> Round: **Phase 4F** — the sixth and final round of Phase 4.
> Phase 4 is permanently frozen at exactly six rounds: `4A`, `4B`, `4C`, `4D`, `4E`, `4F`.
> No `4F-1`, `4F-2`, `4F-A`, `4F-B`, `4F-Fix`, `4F-Cleanup`, `4G`, or post-Phase-4 cleanup round was
> created. Every piece of work in this round is an internal milestone of 4F.

```text
4A  COMPLETE
4B  COMPLETE
4C  COMPLETE
4D  COMPLETE
4E  COMPLETE
4F  COMPLETE          ← this round

PHASE 4 COMPLETE
```

> **Phase 4F COMPLETE.**
>
> **Phase 4 Tool System V2 migration is COMPLETE.**
>
> All migration-era Tool compatibility surfaces have been retired from active source.
>
> The legacy `@caelush/tools` package has been removed.
>
> The legacy `protocol.ToolDefinition` contract has been retired.
>
> Production now depends only on the canonical Tool System V2 authorities established by Phases 4A
> through 4E.
>
> **No Phase 5 work has started.**

---

## 1. Phase identity and the complete Git history

```text
Phase 4E base SHA      7d0700ae2849378324398770df533fae45f39b3e
Phase 4F branch        deepseek/architecture-v2-phase-4f-tool-system-final-assembly

implementation commits
  6b601f9   refactor(tool-system): move the remaining compatibility surfaces to canonical owners
  9a5abeb   refactor(daemon): compose the canonical Tool pipeline directly
  6f2b57a   test(architecture): guard the final tool system ownership
  ca0b54c   refactor(protocol): retire the legacy tool definition contract
  3f55470   docs(architecture): close phase 4 tool system migration

verification head      ca0b54c0d6690a669a58330adb9f6a9980ad3fd4
                       build · typecheck · lint · architecture · full suite · clean checkout,
                       all measured at that tip
documentation head     3f55470c8c14ecc8859cc94a07487c4bdf3ed692
final branch tip       3f55470c8c14ecc8859cc94a07487c4bdf3ed692
remote branch tip      3f55470c8c14ecc8859cc94a07487c4bdf3ed692
ahead / behind         0 / 0
working tree           clean
```

The gate sets were re-run at the final tip after the documentation commit and every one of them passes
there too: that commit changes only Markdown, and the architecture guards which read those documents are
asserted against the closed state.

### 1.1 What was not done to the history

```text
no reset            no rebase             no amended previous commit
no force push       no rewritten 4A-4E history
no branch created from master or 4D
no merge of an unrelated branch        0 merge commits between the 4E tip and the final tip
```

The branch was created from `7d0700a` and only ever moved forward. `git merge-base --is-ancestor
7d0700ae2849378324398770df533fae45f39b3e HEAD` was run before any work began and holds at the final tip.
The five commits form a linear sequence from the Phase 4E tip with no graph divergence.

### 1.2 Production output

```text
101 files deleted          the whole of packages/tools
 14 files added or moved   the canonical owners that received its responsibilities
 97 files formatted        every changed file, against this checkout's line endings
```

### 1.3 Publishing

The machine's connection to `github.com` was intermittent during this session, as it was during Phase
4E. The branch was published once the connection returned; no force push was used and the push created
the remote branch rather than rewriting anything:

```text
git push -u origin deepseek/architecture-v2-phase-4f-tool-system-final-assembly
To https://github.com/GehrmannMerlin/Caelush.git
 * [new branch]  deepseek/architecture-v2-phase-4f-tool-system-final-assembly
                 -> deepseek/architecture-v2-phase-4f-tool-system-final-assembly
```

The four parity checks, after a fresh fetch:

```text
git status --short                            empty — working tree clean
git rev-parse HEAD                            3f55470c8c14ecc8859cc94a07487c4bdf3ed692
git rev-parse origin/<branch>                 3f55470c8c14ecc8859cc94a07487c4bdf3ed692
git ls-remote origin refs/heads/<branch>      3f55470c8c14ecc8859cc94a07487c4bdf3ed692
git rev-list --left-right --count HEAD...origin/<branch>     0   0
```

---

## 2. The retirement, stated once

```text
                              BEFORE 4F                          AFTER 4F
packages/tools                compatibility-only package         DELETED
@caelush/tools imports        13 production files                none
protocol.ToolDefinition       active mixed Tool contract         RETIRED
ToolDispatcher                legacy direct API, no prod caller  DELETED
legacy ToolBatchCoordinator   unreferenced compatibility surface DELETED
legacy registry / preflight   delegating facades                 DELETED
legacy builtin facades        nine delegating modules            DELETED
legacy execution facades      store, lifecycle, event factory    DELETED
```

Nothing was moved into another package to keep an import path alive, and no deprecated alias was left
behind. Every responsibility either moved to the layer that already owned the algorithm, or was deleted
with the surface that declared it.

---

## 3. `packages/tools` — the responsibility migration table

Every major legacy responsibility, its final owner, and the symbol that owns it now.

| Legacy responsibility                                       | Final owner             | Final target symbol                                                                                                               |
| ----------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Executable Tool contract, execution identity, mode, updates | `@caelush/agent`        | `AgentTool`, `AgentToolExecutionInput`, `ToolExecutionIdentity`, `ToolExecutionMode`                                              |
| Schema compilation and generic schema policy                | `@caelush/agent`        | `ToolSchemaRuntime`, `validateToolSchemaSemantics`, `DEFAULT_TOOL_REGISTRY_OPTIONS`                                               |
| JSON helpers                                                | `@caelush/agent`        | `canonicalJsonString`, `cloneJsonValue`, `deepFreezeJson`, `jsonUtf8ByteLength`                                                   |
| Immutable registry + builder + model-spec projection        | `@caelush/agent`        | `ImmutableAgentToolRegistry`, `DefaultAgentToolRegistryBuilder`, `modelSpecs()`                                                   |
| Argument preparation, normalization and validation          | `@caelush/agent`        | `createToolCallPreparer`, `ToolArgumentPreparationError`                                                                          |
| Argument compatibility normalization                        | `@caelush/coding-agent` | `createLegacyNumericArgumentNormalization`                                                                                        |
| Tool invocation execution                                   | `@caelush/agent`        | `createToolInvocationExecutor`, `ToolInvocationExecutor`                                                                          |
| Result validation, sanitization, bounding                   | `@caelush/agent`        | `createToolResultPipeline`, `validateToolResult`, `boundToolResultContent`                                                        |
| Output policy                                               | `@caelush/agent`        | `DEFAULT_TOOL_RESULT_LIMITS`, `ToolResultLimits`                                                                                  |
| Durable invocation and observation lifecycle                | `@caelush/agent`        | `invocation-lifecycle`, `createToolObservation`, `assertToolInvocationInvariant`                                                  |
| Durable Tool events                                         | `@caelush/agent`        | `createToolRequestedEvent`, `createToolStartedEvent`, `createToolCompletedEvent`, …                                               |
| Durable store contract                                      | `@caelush/agent`        | `ToolExecutionStorePort`, `ToolExecutionSnapshot`, `ToolExecutionCommit`                                                          |
| Durable store implementation, atomic settlement             | `@caelush/storage`      | `SqliteToolExecutionStore`, `BEGIN IMMEDIATE` terminal commit                                                                     |
| Security context                                            | `@caelush/agent`        | `ToolSecurityContext`, `assertToolSecurityContext`                                                                                |
| Gate contract                                               | `@caelush/agent`        | `ToolExecutionGatePort`, `ToolExecutionGateInput`, `ToolExecutionGateDecision`                                                    |
| Security policy Gate                                        | `@caelush/security`     | `CaelushToolExecutionGate`, `createDefaultV1ToolExecutionSecurity`                                                                |
| Admission coordinator                                       | `@caelush/agent`        | `createToolAdmissionCoordinator`, `ToolAdmissionPort`                                                                             |
| Coding admission translation and durable metadata           | `@caelush/coding-agent` | `createCodingToolAdmissionPort`, `createCodingToolDurableMetadataPort`, `createDurableInvocationGatePort`                         |
| Approval card composition                                   | `@caelush/security`     | `createV1ToolApprovalRequestFactory`, `DEFAULT_APPROVAL_TTL_MS`                                                                   |
| Approval identity                                           | `@caelush/coding-agent` | `computeCodingToolApprovalKey`                                                                                                    |
| Budget admission port                                       | `@caelush/agent`        | `ToolBudgetAdmissionPort`                                                                                                         |
| Budget ledger adapter                                       | `@caelush/storage`      | `createSqliteToolBudgetAdmission`                                                                                                 |
| Durable Tool execution coordinator                          | `@caelush/agent`        | `createDurableToolExecutionCoordinator`                                                                                           |
| Settlement coordinator                                      | `@caelush/agent`        | `createToolSettlementCoordinator`                                                                                                 |
| Failure settlement                                          | `@caelush/agent`        | `createToolFailureSettlement`                                                                                                     |
| Batch coordination, ordering, rejection and uncertainty     | `@caelush/agent`        | `createToolBatchCoordinator`, `ToolBatchRequest`, `ToolBatchOutcome`                                                              |
| Result batch normalization                                  | `@caelush/agent`        | `createToolResultBatchNormalizer`                                                                                                 |
| Model feedback projection                                   | `@caelush/agent`        | `createModelToolFeedbackProjector`                                                                                                |
| Pre-invocation rejection (no durable row)                   | `@caelush/agent`        | the batch's canonical `REJECTED` item                                                                                             |
| The nine Coding builtins                                    | `@caelush/coding-agent` | `createReadFileTool` … `createGitDiffTool`                                                                                        |
| Default Tool set and order                                  | `@caelush/coding-agent` | `createDefaultCodingTools`, `DEFAULT_CODING_TOOL_ORDER`                                                                           |
| Git exposure                                                | `@caelush/coding-agent` | `withoutGitTools`, `GIT_TOOL_NAMES`, `GitToolAvailability`                                                                        |
| Narrow Operations ports                                     | `@caelush/coding-agent` | `ReadFileOperations` … `GitOperations`                                                                                            |
| Runtime adapters                                            | `@caelush/coding-agent` | `createRuntimeReadOnlyOperations`, `createRuntimePatchOperations`, `createRuntimeProcessOperations`, `createRuntimeGitOperations` |
| Runtime implementation                                      | `@caelush/runtime`      | `LocalRuntime`, `RuntimeWorkspaceScope`                                                                                           |
| Coding security metadata and facts                          | `@caelush/coding-agent` | `CodingToolSecurityMetadata`, nine `project*SecurityFacts`                                                                        |
| Coding effects, state and event projection                  | `@caelush/coding-agent` | `ToolEffect`, `projectReadFileEffect` … `toolEffectsToEvents`, `applyToolEffectsToAgentState`                                     |
| Coding output policy                                        | `@caelush/coding-agent` | `boundToolModelContent`, `DEFAULT_TOOL_OUTPUT_POLICY`                                                                             |
| Coding prompt snippets                                      | `@caelush/coding-agent` | `CODING_TOOL_PROMPT_SNIPPETS`, `promptSnippetFor`                                                                                 |
| Prompt delivery into Context                                | `@caelush/coding-agent` | `createToolPromptContextProvider`                                                                                                 |
| Coding settlement extension encoder / decoder               | `@caelush/coding-agent` | `createCodingToolSettlementExtensionProjector`, `createCodingToolSettlementExtensionDecoder`                                      |
| Extended guidance folded into a description                 | **deleted**             | no reachable algorithm produces it                                                                                                |
| `ToolDispatcher`                                            | **deleted**             | the four canonical authorities above                                                                                              |
| `ToolPreflight`, `ToolFailureMemory`                        | **deleted**             | `ToolCallPreparer`; no V2 replacement needed                                                                                      |
| Legacy registry, exposure and registration DTOs             | **deleted**             | registry + catalog around `AgentToolRegistry`                                                                                     |
| Tool-calling debug event and env flag                       | **deleted**             | dead since Phase 4D; no replacement                                                                                               |

---

## 4. `protocol.ToolDefinition` — retirement record

```text
BEFORE   protocol.ToolDefinition          seven fields: the general model-facing Tool fields
         protocol.ToolDefinitionSchema    PLUS Coding-specific policy metadata
                                          (riskLevel, requiredCapabilities, runtimeRequirements)

AFTER    RETIRED                          neither the type nor the schema is exported
```

### 4.1 Why it could be removed, with the evidence

```text
the schema was parsed in exactly two places   the legacy registry builder, and two protocol tests
no persistence                                 a ToolInvocation row stores a `toolName`, not a definition
no wire contract                               it never crossed HTTP, SSE, or a provider request
no storage or migration coupling               no migration file mentions it
every production consumer moved first          core's catalog, the Gate input, the security composition
```

It was verified against the real source, not inferred from the Phase 4E report. No live wire, network or
persistence requirement exists, so this is not a blocker.

### 4.2 Replacement roles

```text
AgentTool                   the general executable Tool contract                       @caelush/agent
AIToolSpec                  the model-facing Tool contract                             @caelush/ai
CodingToolDefinition        AgentTool + Coding security/effects/UI/prompt              @caelush/coding-agent
CodingToolSecurityMetadata  riskLevel · requiredCapabilities · runtimeRequirements     @caelush/coding-agent
```

### 4.3 What was not removed with it

```text
ToolNameSchema / ToolName                    a durable identity primitive
ToolInvocationSchema / ToolInvocation        the persisted invocation row
ToolInvocationStatusSchema / statuses        the six lifecycle statuses
```

`ToolInvocation` is unchanged field for field. Its six statuses are unchanged. The `ToolObservation`
shape, the persisted `ApprovalRequest` shape and the persisted `AgentRun`/`AgentState` shapes are
unchanged. There is **no database migration and no Protocol persistence change** in this round.

---

## 5. What production composes now

```text
AI ToolCall
   ↓
ToolCallPreparer                      @caelush/agent            resolve · normalize · validate
   ↓
PreparedToolCall
   ↓
ToolBatchCoordinator                  @caelush/agent            sequential schedule, whole-segment preflight
   ↓
DurableToolExecutionCoordinator       @caelush/agent            THE Tool Invocation Lifecycle Authority
   ↓
REQUESTED                             durable, before any admission side effect
   ↓
ToolAdmissionCoordinator              @caelush/agent
   ↓
Coding/Security admission             @caelush/coding-agent → @caelush/security
   ↓
approval / budget                     WAITING_APPROVAL parks here; budget blocks before the handler
   ↓
RUNNING                               durable, before the handler begins
   ↓
ToolInvocationExecutor                @caelush/agent
   ↓
Coding AgentTool                      @caelush/coding-agent     the registered executable
   ↓
Narrow Operations port                @caelush/coding-agent
   ↓
Runtime adapter                       @caelush/coding-agent     the only layer holding a RuntimeResolver
   ↓
Runtime                               @caelush/runtime
   ↓
ToolResultPipeline                    @caelush/agent            validate → sanitize → revalidate → bound
   ↓
Coding settlement extension           caelush.coding.effects.v1  built by @caelush/coding-agent
   ↓
ToolSettlementCoordinator             @caelush/agent
   ↓
atomic durable settlement             invocation + observation + budget + Coding state/effects/events,
                                      ONE SQLite transaction
   ↓
ToolObservation
   ↓
ModelToolFeedbackProjector            @caelush/agent
   ↓
AIToolResultMessage
   ↓
AgentLoop
```

Every arrow is a real source dependency; none is aspirational. The composition root
(`apps/daemon/src/daemon-composition.ts`) builds exactly this chain and nothing beside it.

---

## 6. Authority table

```text
General Tool contract        @caelush/agent
Coding Tool product          @caelush/coding-agent
Runtime                      @caelush/runtime
Security policy              @caelush/security
Durable storage              @caelush/storage
Run lifecycle                @caelush/core
```

```text
@caelush/tools               no longer exists
```

Every one of these has exactly one authority. Where a contract crosses a layer boundary — the Gate
contract, the admission translation, the settlement extension — it is an explicit port/implementation
pair and is recorded as such in the acceptance map; it is never two owners of one responsibility.

---

## 7. No hidden legacy path — repo-wide evidence

```text
@caelush/tools imports                            0
ToolDispatcher active definitions                 0
legacy ToolBatchCoordinator active definitions    0
legacy Tool business implementations              0
legacy ToolDefinition consumers                   0
packages/tools directory                          absent
node_modules/@caelush/tools                       absent
workspace manifest declarations                   absent
tsconfig references to it                         absent
pnpm-lock workspace entry                         absent
architecture baseline entry for it                retired (27 → 26)
```

Historical Markdown under `docs/` is **not** counted as active source: the Phase 4A–4E reports are the
evidence of what those rounds did, and they must keep saying it. They were not rewritten.

Machine-checked by `tests/architecture/phase-4f-tool-system-final-boundaries.test.ts`, whose scans read
comment-stripped active source rather than raw text.

---

## 8. Phase-by-phase closure

```text
4A   what became canonical
     the general Tool contract, the schema runtime and policy, the immutable AgentToolRegistry with
     its model-spec projection, and ToolCallPreparer. The legacy registry and argument validation
     became delegating adapters over them.

4B   what became canonical
     AgentTool invocation (ToolInvocationExecutor), the safe transient update lifecycle, and result
     processing (ToolResultPipeline).

4C   what became canonical
     the Tool security context, the admission ports and coordinator, budget admission, the durable
     metadata seam, the invocation and observation lifecycle, the durable store contract, the durable
     Tool events, ToolSettlementCoordinator and DurableToolExecutionCoordinator — the Tool Invocation
     Lifecycle Authority.

4D   what became canonical
     the canonical ToolBatchCoordinator, ToolResultBatchNormalizer and ModelToolFeedbackProjector, and
     the production ToolTurn wiring in Core.

4E   what became canonical
     all nine Coding builtins, the eight Operations ports and Runtime adapters, the Coding security
     metadata and facts, the approval identity, the Coding effects, and prompt snippets delivered
     through Context.

4F   what was retired
     every migration-era compatibility surface: packages/tools in full, the legacy Dispatcher, the
     legacy batch coordinator, the registry and exposure facades, preflight and failure memory, the
     execution-store and settlement compatibility modules, the legacy builtin facades, the folded
     prompt-guidance algorithm, and protocol.ToolDefinition with its schema.
```

---

## 9. Verification

Every gate, with its measured result. All were run at the final tip.

```text
pnpm build                  PASS   whole workspace
pnpm typecheck              PASS   workspace build + root tsc + every package
pnpm lint                   PASS   0 errors
pnpm check:architecture:ci  PASS   26 baseline entries · 0 new · 0 stale · READY
pnpm test                   PASS   443 files · 2985 passed · 5 skipped · 0 failed
git diff --check            PASS
prettier                    PASS   every changed file
```

### 9.1 The format-check finding

```text
pnpm format:check fails in this checkout, and it failed at the Phase 4E tip too.
```

A detached worktree of `7d0700ae` was created and checked with the same Prettier binary:

```text
baseline 7d0700ae   1 441 files flagged         playwright.config.mjs included
current tip           719 files flagged
with --end-of-line crlf
  baseline          All matched files use Prettier code style
  current tip       All matched files use Prettier code style   (every changed file)
```

The cause is the environment: this working copy carries CRLF line endings and no `.gitattributes`
normalizes them, while `.prettierrc.json` does not set `endOfLine`. Nothing in this round changed that,
and every file this round touched is Prettier-clean under the checkout's own line endings. It is
recorded as a pre-existing, environment-level condition rather than claimed as a pass.

### 9.2 Architecture baseline

```text
before 4F    27 entries · 0 new · 0 stale · READY
after 4F     26 entries · 0 new · 0 stale · READY
```

The one removed entry is `STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_TOOLS` — the storage manifest's
dependency on the retired package. It could not survive the deletion, so it was retired rather than
left as a stale entry.

```text
the entry was removed with the checker's own --write-baseline writer
nothing was added          the write could only remove entries
no entry was rewritten     entry content is unchanged for the other 26
the provenance pin was restored
                           baselineSourceCommit and generatedAt still record the last audited
                           rule-set expansion, not this shrink — the convention Phase 4C set when it
                           shrank the baseline with the same writer
no exception was added     the round reduced compatibility rather than broadening an allowlist
```

The count staying near 27 is not the completion criterion; `0 new` and `0 stale` is. The remaining 26
entries are `runtime → shared` and `storage → *` debt unrelated to the Tool System, exactly as §92 of
the authorising prompt anticipated.

### 9.3 Frozen contracts and boundaries, re-verified

```text
Phase 3 frozen contracts unchanged
  AgentLoop · AgentLoopAdvanceResult · ModelTurnExecutor · RunExecutionCoordinator ·
  RunExecutionDirective · RunExecutionDriver(+Dependencies) · RunExecutionEffect* ·
  RunTransitionPlanner · RunContinuationCheckpoint · ToolTurnCoordinator · ToolTurnRequest ·
  ToolTurnResult · CompletionGate(+Input/Decision)
  → each still declared in its frozen file, by its frozen declaration

no parallel execution              PARALLEL_SAFE is a declaration; no call site branches on it;
                                   no Promise.all / allSettled / worker in any Tool execution path
no terminate: true                 no Tool decides a Run's outcome
no Tool → Run terminal write       no Tool-system file names a Run terminal writer
one durable authority              createDurableToolExecutionCoordinator, single declaration
one batch authority                createToolBatchCoordinator, single declaration
one model feedback authority       createModelToolFeedbackProjector, single declaration
one atomic settlement              one BEGIN IMMEDIATE … COMMIT / ROLLBACK path in the Tool store
```

### 9.4 Phase 4 targeted suites

```text
packages/coding-agent/test (all)                              the nine builtins, Operations, adapters,
                                                              Coding catalog, authority fidelity
apps/daemon/test (all)                                        production composition, prompt E2E,
                                                              target-tool E2E, wire round trip
tests/architecture (all 27 files)                             the whole-phase guards and every round guard
tests/integration                                             the real OpenAI-shaped wire contract
                                              47 files · 635 tests   PASS
```

### 9.5 Behavioural fidelity

Phase 4E's 32-scenario comparison ran the legacy and target Tool sets over the same real workspace and
found two genuine regressions, which 4E fixed (`read_file` on a directory → `NOT_A_FILE`,
`list_directory` on a file → `NOT_A_DIRECTORY`, via the same-package `readFileWithKind` /
`listDirectoryWithKind` probes).

Phase 4F does **not** recreate a legacy implementation to keep that comparison alive. The expected
behaviour the comparison used is now asserted directly by the re-authored fidelity suite:

```text
32-scenario behavioural fixtures        preserved as expected values
legacy implementation as an oracle      dropped
read_file directory → NOT_A_FILE        covered by the builtin suite
list_directory file → NOT_A_DIRECTORY   covered by the builtin suite
search_text include + truncation        covered by the adapter/runtime suite
git_status path and 250/200/1000 limits covered by the runtime git suite
approval identity                       covered by the fidelity suite (81 canonical keys)
Coding effects                          covered by the fidelity suite
```

No behavioural fixture, bound, default, error code, effect, security fact or prompt snippet was
weakened to make the retirement pass.

### 9.6 Clean checkout — verified

```text
git worktree add --detach <clean> ca0b54c0d6690a669a58330adb9f6a9980ad3fd4

pnpm install --frozen-lockfile      PASS   the committed lockfile matches the committed manifests
pnpm build                          PASS   from a checkout with no dist and no tsbuildinfo
pnpm typecheck                      PASS
pnpm lint                           PASS
pnpm check:architecture:ci          PASS   26 entries · 0 new · 0 stale · READY
pnpm test                           PASS   443 files · 2985 passed · 5 skipped · 0 failed
targeted Phase 4 suites             PASS   47 files · 635 tests
working tree after all of it        clean
```

```text
packages/tools present             false
node_modules/@caelush/tools        false
```

The build therefore does **not** depend on a stale `dist`, a `node_modules` junction, or a leftover
build artifact. Note that a `node_modules/@caelush/tools` junction _does_ exist in the session's own
working copy — pnpm leaves it behind after a workspace package is deleted. It is not a source
dependency and not a build input, every gate above passes without it in a fresh install, and it is
gitignored. It is recorded here rather than quietly ignored.

---

## 10. Defects found and fixed

A migration that only moves files finds nothing. These were found by migrating and re-reading.

```text
1  the Coding admission port hard-coded `riskLevel: "LOW"` on the synthetic invocation it handed the
   Security gate, while passing the catalog's real risk as the definition. The gate's first invariant
   is that the two agree, so a bare `CaelushToolExecutionGate` threw a policy invariant for every
   non-LOW Tool. Production was safe only because the durable-invocation wrapper replaced the
   projection. The value now agrees with the metadata in the same call, so both wirings decide
   identically. Found by a test migration, reproduced directly, fixed in the owner.

2  the Security gate accepted a seven-field legacy `ToolDefinition` as a second arm of its metadata
   check — a live reference to a contract this round retires. With that contract gone the arm is
   unreachable, so the check narrows to the canonical four policy fields. The four fields it reads are
   the ones it always read, so no policy behaviour changed.

3  the daemon's Git exposure was internally inconsistent: it filtered a *built* registry while the
   Coding catalog had been built from the *unfiltered* one, so for a non-Git workspace the overlay
   described Tools the registry could not execute. The reduced definition list now builds all three
   views, so the executable set, the overlay, the model specs and the prompt guidance describe one
   active set.

4  `CAELUSH_DEBUG_TOOL_CALLING` and `ToolCallingDebugEvent` were dead: the option was accepted by the
   composition and never consumed by any live pipeline after Phase 4D removed the Dispatcher. They were
   removed rather than translated.

5  the extension kind `caelush.coding.effects.v1` is declared in both `@caelush/agent` (as the generic
   policy constant) and `@caelush/coding-agent` (as the overlay payload kind). Both were kept and the
   guard asserts the two spellings are byte-identical.
```

---

## 11. Completion gates

```text
LEGACY RETIREMENT
  packages/tools removed                                    PASS
  @caelush/tools imports = 0                                PASS
  ToolDispatcher removed                                    PASS
  legacy batch removed                                      PASS
  legacy registry removed                                   PASS
  legacy builtin facades removed                            PASS
  legacy execution compatibility removed                    PASS

PROTOCOL
  ToolDefinitionSchema retired                              PASS
  ToolDefinition retired                                    PASS
  ToolInvocation unchanged, field for field                 PASS
  ToolName retained                                         PASS
  no Protocol persistence change                            PASS
  no DB migration                                           PASS

TARGET AUTHORITY
  Agent Tool Kernel = agent                                 PASS
  Coding Tool Product = coding-agent                        PASS
  Runtime access = coding-agent runtime adapters            PASS
  Security policy = security                                PASS
  Durability = storage + agent coordinator                  PASS
  Run terminal authority = RunController / CompletionGate   PASS

SINGLE AUTHORITY
  one schema compiler · one argument preparer               PASS
  one invocation executor · one result pipeline             PASS
  one durable coordinator · one batch coordinator           PASS
  one model feedback projector                              PASS
  one Coding builtin implementation set                     PASS
  one Coding security-facts declaration                     PASS
  one Coding approval identity                              PASS
  one Coding effect vocabulary                              PASS

BEHAVIOUR
  Phase 4E fidelity preserved, asserted directly            PASS
  names · schemas · defaults · bounds unchanged             PASS
  error codes · effects · security · prompt unchanged       PASS

GATES
  build PASS · typecheck PASS · lint PASS                   PASS
  architecture PASS (0 new, 0 stale, READY)                 PASS
  full tests PASS (2985 passed)                             PASS
  format PASS on every changed file                         PASS
  git diff --check PASS                                     PASS
  clean checkout PASS                                       PASS

ARCHITECTURE
  Phase 3 frozen contracts unchanged                        PASS
  no parallel Tool execution                                PASS
  no terminate: true                                        PASS
  no Tool Run-terminal authority                            PASS
  atomic settlement preserved                               PASS
```

---

## 12. Final state

```text
Phase 4F status            COMPLETE
Phase 4 status             COMPLETE

branch                     deepseek/architecture-v2-phase-4f-tool-system-final-assembly
Phase 4E base SHA          7d0700ae2849378324398770df533fae45f39b3e
verification head          ca0b54c0d6690a669a58330adb9f6a9980ad3fd4
final tip                  3f55470c8c14ecc8859cc94a07487c4bdf3ed692
remote tip                 3f55470c8c14ecc8859cc94a07487c4bdf3ed692
local working tree         clean
local == remote            verified at the final tip
ahead / behind             0 / 0

baseline                   26 entries · 0 new · 0 stale · READY
tests                      443 files · 2985 passed · 5 skipped · 0 failed
```

### 12.1 Closing statement

```text
Phase 4F COMPLETE.

Phase 4 Tool System V2 migration is COMPLETE.

All migration-era Tool compatibility surfaces have been
retired from active source.

The legacy @caelush/tools package has been removed.

The legacy protocol.ToolDefinition contract has been retired.

Production now depends only on the canonical Tool System V2
authorities established by Phases 4A through 4E.

No Phase 5 work has started.
```
