# Caelush Architecture V2 — Phase 4E Coding Tools, Operations Ports & Runtime Adapters Acceptance Map

> Round: **Phase 4E** — the fifth and only fifth round of Phase 4.
> Phase 4 is permanently frozen at exactly six rounds: `4A`, `4B`, `4C`, `4D`, `4E`, `4F`.
>
> Base commit: `d21595f14fd18d66369aec4f1a090b8cc459656e` (Phase 4D final tip)
> Branch: `deepseek/architecture-v2-phase-4e-coding-tools-operations-runtime`
> Resume point: `1b15697f74109a76b96c545ab19cd48fbb94cf7b` (the IN PROGRESS tip this round continued from)
>
> **Round outcome: `Phase 4E COMPLETE`.**
> The previous `BLOCKED` state was resolved by the scoped Operations Interface Freeze Errata. The map
> below is a **timeline**, not a verdict: the initial failures, the blocker, the errata and the
> resolution are all still visible, because deleting them would delete the evidence that the gates were
> ever real.

---

## A. How to read this document

This map was created _before any code change_ as a source/freeze reconciliation, and it went through
four states within one round. Those states are preserved as columns rather than overwritten:

```text
INITIAL     Milestone A, against the original frozen Operations contracts
BLOCKED     the same gates re-stated as a blocker, with source evidence
ERRATA      the corrected contracts the architecture owner accepted
RESOLVED    the implemented, tested, production-wired state
```

A gate whose initial verdict was `FAILED` still reads `FAILED` in the `INITIAL` column. That is
deliberate: a map that only shows `RESOLVED` cannot tell a reader what the round had to correct, and
the correction is the most reviewable thing it did.

---

## B. Scope and non-goals

### B.1 Authorised scope (frozen by the round plan)

```text
all nine Coding builtins          the Operations ports          Runtime adapters
Coding metadata                   Coding security facts         Coding effects
Coding presentation               Coding prompt integration
final owner: @caelush/coding-agent
```

### B.2 Non-goals

```text
parallel Tool execution        Promise.all scheduling        terminate:true
new DB table                   new DB migration              new Protocol persisted field
new ToolInvocation status      new Run status                new first-class agent_turns table
MCP  Skills  Browser  Web Search  Multi-Agent  Sub-Agent  Remote Runtime
Security V2  Context V2  Memory V2  Message/Session V2
```

### B.3 Explicitly reserved for Phase 4F

```text
delete packages/tools                     remove every @caelush/tools export
delete protocol.ToolDefinition            rewrite every legacy test import
force all external callers onto new API    remove ToolDispatcher direct compatibility API
final compatibility retirement            whole-phase Tool System V2 acceptance
```

Phase 4F was **not** started. `packages/tools` still exists, its public names are all still exported,
and `protocol.ToolDefinition` is untouched — asserted by the Phase 4E boundary guard.

---

## C. Frozen contracts this round implements

Reproduced verbatim from the _Current → Target Interface Freeze_ as supplied to this round, **as
corrected by `PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md`**.

### C.1 `ReadFileOperations` (§162) — UNCHANGED — RESOLVED

```ts
export interface ReadFileOperations {
  read(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly path: string;
    readonly offset: number;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly path: string;
    readonly lines: readonly string[];
    readonly truncated: boolean;
    readonly nextOffset?: number;
    readonly bytesReturned: number;
    readonly utf8Bom: boolean;
  }>;
}
```

### C.2 `ListDirectoryOperations` (§163) — UNCHANGED — RESOLVED

```ts
export interface ListDirectoryOperations {
  list(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly path: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly path: string;
    readonly entries: readonly JsonObject[];
    readonly truncated: boolean;
  }>;
}
```

The Tool's `offset` is applied tool-side over a wider port request, as §H predicted.

### C.3 `FindFilesOperations` (§164) — UNCHANGED — RESOLVED

```ts
export interface FindFilesOperations {
  find(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly pattern: string;
    readonly path?: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>;
}
```

### C.4 `SearchTextOperations` (§165) — **SUPERSEDED BY ERRATA** — RESOLVED

```text
INITIAL     FAILED    the frozen shape had no include and no limit
BLOCKED     recorded  with source evidence, no faithful workaround existed
ERRATA      ACCEPTED  include?: string and limit: number added
RESOLVED    implemented, wired, and asserted field for field
```

The corrected, now-current exact shape:

```ts
export interface SearchTextOperations {
  search(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly pattern: string;
    readonly path?: string;
    readonly include?: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly matches: readonly JsonObject[]; readonly truncated: boolean }>;
}
```

### C.5 `PatchOperations` (§166) — UNCHANGED — RESOLVED

```ts
export interface PatchOperations {
  apply(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly patch: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly changeCount: number; readonly changes: readonly JsonObject[] }>;
}
```

`RuntimePatchUncertainError` is not swallowed into an ordinary failure (§166).

### C.6 `ExecOperations` (§167) — UNCHANGED — RESOLVED

```ts
export interface ExecOperations {
  execute(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly ownerRunId: RunId;
    readonly command: string;
    readonly workdir?: string;
    readonly tty: boolean;
    readonly yieldTimeMs: number;
    readonly signal: AbortSignal;
    readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  }): Promise<JsonObject>;
}
```

### C.7 `ProcessOperations` (§168) — UNCHANGED — RESOLVED

```ts
export interface ProcessOperations {
  interact(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly ownerRunId: RunId;
    readonly sessionId: string;
    readonly chars: string;
    readonly yieldTimeMs: number;
    readonly signal: AbortSignal;
    readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  }): Promise<JsonObject>;
}
```

### C.8 `GitOperations` (§169) — `diff` UNCHANGED, **`status` SUPERSEDED BY ERRATA** — RESOLVED

```text
INITIAL     diff MAPS · status FAILED   the status arm carried no per-call channel at all
BLOCKED     recorded  with source evidence, and with the asymmetry that made it harder
ERRATA      ACCEPTED  status gains args, symmetric with the arm that already had one
RESOLVED    implemented, wired, and asserted field for field
```

The corrected, now-current exact shape:

```ts
export interface GitOperations {
  status(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly args: JsonObject;
    readonly signal: AbortSignal;
  }): Promise<JsonObject>;

  diff(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly args: JsonObject;
    readonly signal: AbortSignal;
  }): Promise<JsonObject>;
}
```

`status` may not carry `runtime`, `scope`, `gitService`, `resolver` or `absolutePath` — asserted by the
errata guard.

### C.9 Why `JsonObject` returns are legitimate (§170)

```text
the current Runtime result schema is still evolving
what this round freezes is the minimal capability boundary,
not a promotion of every Runtime internal result type into an Agent public contract
a concrete Coding Tool may define a typed result internally
```

### C.10 Operations principles (§160, §161, §171, §172) — RESOLVED

```text
a Coding Tool depends on a minimal Operations port, never on RuntimeResolver or RuntimeWorkspaceScope
every Operation receives ToolExecutionEnvironment and AbortSignal,
  or holds a resolver at adapter construction time
an Operation returns a Tool business-friendly result, not a whole Runtime scope
Runtime adapters are mockable: no builtin unit test needs a real filesystem, shell or Git repo
```

The mockability principle is what the nine builtin suites are built on, and the
`RuntimeResolver`-confinement principle is what the boundary guard asserts structurally.

### C.11 Prompt rules (§74, §182 of the round) — target ownership — RESOLVED

```text
CodingToolDefinition.promptSnippet is NOT appended to AIToolSpec.description
CodingToolCatalog → ToolPromptContextProvider → ContextEngine → Prepared Model Context
```

---

## D. Current → Target ownership map

Legend: **RESOLVED** = ownership moved and verified; **GATE** = a reconciliation gate, now closed.

| #   | Responsibility                        | Initial owner (before 4E)                                | Final owner                                        | Migration type                            | Compatibility bridge                            | Gate                                                                        | 4F exit                         |
| --- | ------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------- |
| 1   | `read_file` implementation            | `tools/builtins/read-file.ts`                            | `coding-agent/tools/builtins/read-file.ts`         | move + re-shape to `CodingToolDefinition` | facade delegating to the Coding factory         | **RESOLVED** — `readFileWithKind` probe                                     | delete legacy facade            |
| 2   | `list_directory` implementation       | `tools/builtins/list-directory.ts`                       | `coding-agent`                                     | move + re-shape                           | facade                                          | **RESOLVED** — `offset` applied tool-side over a probed request             | delete                          |
| 3   | `find_files` implementation           | `tools/builtins/find-files.ts`                           | `coding-agent`                                     | move + re-shape                           | facade                                          | **RESOLVED** — `FindFilesOperations`                                        | delete                          |
| 4   | `search_text` implementation          | `tools/builtins/search-text.ts`                          | `coding-agent`                                     | move + re-shape                           | facade                                          | **INITIAL FAILED → ERRATA → RESOLVED** — `include` + `limit`                | delete                          |
| 5   | `apply_patch` implementation          | `tools/builtins/apply-patch.ts`                          | `coding-agent`                                     | move + re-shape                           | facade                                          | **RESOLVED** — `PatchOperations` + uncertain mapping                        | delete                          |
| 6   | `exec_command` implementation         | `tools/builtins/exec-command.ts`                         | `coding-agent`                                     | move + re-shape                           | facade                                          | **RESOLVED** — `ExecOperations` + update channel                            | delete                          |
| 7   | `write_stdin` implementation          | `tools/builtins/write-stdin.ts`                          | `coding-agent`                                     | move + re-shape                           | facade                                          | **RESOLVED** — `ProcessOperations`                                          | delete                          |
| 8   | `git_status` implementation           | `tools/builtins/git-status.ts`                           | `coding-agent`                                     | move + re-shape                           | facade                                          | **INITIAL FAILED → ERRATA → RESOLVED** — `args` + `limit`                   | delete                          |
| 9   | `git_diff` implementation             | `tools/builtins/git-diff.ts`                             | `coding-agent`                                     | move + re-shape                           | facade                                          | **RESOLVED** — `GitOperations.diff({ args })`                               | delete                          |
| 10  | default builtin composition + order   | `tools/builtins/default-tools.ts`                        | `coding-agent/tools/builtins/default-tools.ts`     | move                                      | re-export + delegating family builders          | **RESOLVED** — one declaration, frozen order                                | delete                          |
| 11  | result helpers                        | `tools/builtins/result.ts`                               | `coding-agent/tools/builtins/result.ts`            | split                                     | re-export list                                  | **RESOLVED** — helpers only, no Runtime, no `withRuntimeScope`              | delete                          |
| 12  | security facts vocabulary             | `tools/security-facts.ts`                                | `coding-agent/tools/security/security-facts.ts`    | move                                      | `tools` re-export                               | **RESOLVED** — one declaration                                              | delete                          |
| 13  | per-tool security fact projectors     | `tools/builtins/security-facts.ts`                       | `coding-agent/tools/security/`                     | move                                      | `tools` re-export                               | **RESOLVED** — nine projectors, structure-equivalent, same objects          | delete                          |
| 14  | approval identity                     | `tools/approval-key.ts`                                  | `coding-agent/tools/security/approval-identity.ts` | move                                      | `tools` delegate                                | **RESOLVED** — byte-identical keys for all nine × every policy              | delete                          |
| 15  | Coding durable metadata (`riskLevel`) | legacy `ToolDefinition`                                  | `CodingToolCatalog`                                | re-point                                  | `ToolDurableMetadataPort` seam                  | **RESOLVED** — the catalog is the source                                    | seam retained until Protocol V2 |
| 16  | Coding effect vocabulary              | `tools/tool-effects.ts`                                  | `coding-agent/tools/effects/effects.ts`            | split                                     | `tools` re-export                               | **RESOLVED** — facts only                                                   | delete                          |
| 17  | effect → Tool result projection       | `tools/tool-effects.ts`                                  | `coding-agent/tools/effects/effect-projectors.ts`  | split                                     | `tools` re-export                               | **RESOLVED** — four projectors, same objects                                | delete                          |
| 18  | effect → AgentState projection        | `tools/tool-effects.ts`                                  | `coding-agent/tools/effects/state-projector.ts`    | split                                     | `tools` re-export                               | **RESOLVED** — `changedFiles` / `activeProcesses` unchanged                 | delete                          |
| 19  | effect → durable event projection     | `tools/tool-effects.ts`                                  | `coding-agent/tools/effects/event-projector.ts`    | split                                     | `tools` re-export                               | **RESOLVED** — nine discriminants unchanged                                 | delete                          |
| 20  | settlement-extension encoding         | `tools/tool-effects.ts`                                  | `coding-agent/tools/effects/`                      | move                                      | —                                               | **RESOLVED** — `caelush.coding.effects.v1` unchanged                        | delete                          |
| 21  | settlement-extension decoding         | `tools/settlement-extension-bridge.ts`                   | `coding-agent/tools/effects/`                      | move                                      | `tools` delegate                                | **RESOLVED** — one decoder                                                  | delete                          |
| 22  | presentation                          | `tools/presentation.ts`                                  | `coding-agent/tools/`                              | move                                      | `tools` re-export of the Agent contract         | **RESOLVED** — safe label unchanged                                         | delete                          |
| 23  | prompt / model guidance               | `tools/model-guidance.ts` + registry-builder append      | `coding-agent/tools/prompt/`                       | **semantic cutover**                      | none                                            | **RESOLVED** — guidance leaves `description`, enters Context once, budgeted | delete                          |
| 24  | runtime resolution                    | per-builtin `withRuntimeScope`                           | `coding-agent/tools/operations/runtime-adapters/`  | move                                      | —                                               | **RESOLVED** — builtins never see `RuntimeResolver`                         | —                               |
| 25  | filesystem operations                 | none (broad scope)                                       | `operations/read-file-operations.ts` etc.          | new narrow ports                          | —                                               | **RESOLVED** — eight frozen interfaces                                      | —                               |
| 26  | file discovery                        | `scope.discovery`                                        | `FindFilesOperations`                              | narrow                                    | —                                               | **RESOLVED**                                                                | —                               |
| 27  | text search                           | `scope.textSearch`                                       | `SearchTextOperations`                             | narrow                                    | —                                               | **INITIAL FAILED → ERRATA → RESOLVED**                                      | —                               |
| 28  | patch                                 | `scope.patch`                                            | `PatchOperations`                                  | narrow                                    | —                                               | **RESOLVED**                                                                | —                               |
| 29  | exec                                  | `scope.exec.execute`                                     | `ExecOperations`                                   | narrow                                    | —                                               | **RESOLVED**                                                                | —                               |
| 30  | process interaction                   | `scope.exec.interact`                                    | `ProcessOperations`                                | narrow                                    | —                                               | **RESOLVED**                                                                | —                               |
| 31  | git                                   | `scope.git`                                              | `GitOperations`                                    | narrow                                    | —                                               | `diff` **RESOLVED**, `status` **INITIAL FAILED → ERRATA → RESOLVED**        | —                               |
| 32  | daemon default registration           | `createDefaultBuiltinToolRegistrations(runtimeResolver)` | `createDefaultCodingTools(operations)`             | cutover                                   | legacy builder retained as a delegating adapter | **RESOLVED** — production defaults originate from `coding-agent`            | delete legacy builder           |

---

## E. The timeline, in one place

```text
STAGE 1  Milestone A — source/freeze reconciliation, before any code change
         ─────────────────────────────────────────────────────────────────────
         seven of nine builtins mapped cleanly
         two gates FAILED on frozen contracts that could not express what their
         Tools must do: SearchTextOperations (no include, no limit) and
         GitOperations.status (no per-call channel at all)
         the round reported BLOCKED rather than regressing behaviour

STAGE 2  Errata + target product layer
         ─────────────────────────────────────────────────────────────────────
         the architecture owner accepted a scoped errata superseding exactly two
         frozen shapes, on proven source evidence
         the eight Operations ports, the Runtime adapters, the nine Coding
         builtins, the security facts, the approval identity, the effects and the
         prompt snippets landed in @caelush/coding-agent
         the round was still NOT complete: the target existed, but production did
         not use it and the legacy package still held a second implementation

STAGE 3  Authority cutover, production migration and verification (this session)
         ─────────────────────────────────────────────────────────────────────
         the nine legacy builtins became delegating facades
         security facts, effects, approval identity, durable metadata and prompt
         guidance were re-pointed at the canonical Coding source
         the prompt provider was wired into the budgeted Context path
         the daemon default composition cut over to createDefaultCodingTools
         two real fidelity regressions were found by a behaviour comparison and
         fixed at the source
         the 4E target, fidelity, E2E and architecture-guard suites were written
         full gates, a clean checkout and remote parity were run
```

---

## F. Reconciliation result — `SearchTextOperations`: from FAILED to RESOLVED

### F.1 The initial failure

```text
frozen contract   search({ environment, pattern, path?, signal }) → { matches, truncated }
                  deliberately no include, no limit
```

There was no faithful mapping, because a Tool-side post-filter sees an already-truncated list:

```text
1  spurious truncation
   default limit = 100, so the Tool could ask for at most 200
   a file with >= 200 matching lines sorting before the include target
   current : ripgrep globs -> only the target is searched -> 3 matches -> truncated false
   proposed: runtime returns 200 matches, all from the other file -> filtered set empty
             -> matches = [] and truncated = true       both content and flag differ

2  an empty result where the current behaviour finds matches
   with include set, the intended file's matches may never appear inside the first
   `limit` entries the runtime is willing to return
```

Every candidate workaround was closed by evidence: no unbounded request exists (the Runtime's `limit`
is required), folding `include` into `pattern` changes regex semantics, out-of-band passing was
forbidden, and letting the builtin build its own adapter per call requires importing `RuntimeResolver`
into builtin code.

### F.2 The resolution

The architecture owner accepted a **scoped errata** rather than a behaviour regression. The corrected
shape adds `include?: string` and `limit: number`, and the Tool keeps its existing behaviour exactly:

```text
Operation input limit = N
        ↓  Runtime adapter
Runtime search request: limit = N + 1        the preserved capture probe
        ↓  Runtime
matches
        ↓  adapter / Tool
visible matches = first N
truncated       = runtime.truncated OR rawMatches.length > N
```

### F.3 Evidence

```text
DECISIVE  a fixture with a 260-match file plus include = "z-target.ts" and limit = 100
          answers 3 matches with truncated = false
          a post-filter would answer zero matches with truncated = true
          → packages/coding-agent/test/runtime-adapters.test.ts, against a real ripgrep
SHAPE     SearchTextOperations is exactly environment, pattern, path?, include?, limit, signal
          → tests/architecture/phase-4e-operations-freeze-errata.test.ts
```

---

## G. Reconciliation result — `GitOperations.status`: from FAILED to RESOLVED

### G.1 The initial failure

```text
frozen contract   status({ environment, signal }) → JsonObject
```

`path` decides **which paths Git reports at all** and `limit` slices the parsed result. Every candidate
channel was closed by evidence:

| Candidate channel                  | Evidence it could not carry a pathspec                                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`                      | `ToolExecutionEnvironment` is exactly `{ workspace, runtime }`; a `WorkspaceRef` is not a Git pathspec                                                                              |
| a second method on `GitOperations` | §169 freezes the interface to exactly `status` and `diff`                                                                                                                           |
| `signal`                           | an `AbortSignal` is not a pathspec                                                                                                                                                  |
| adapter constructor                | §161 allows a resolver at construction, but `path` **varies per call**                                                                                                              |
| the Tool filtering entries itself  | would require dropping the pathspec from the Git invocation or approximating it — both forbidden, and no approximation is equivalent to `:(glob)` / `:(icase)` / `:(exclude)` magic |

Accepting the Runtime's default `limit` of 200 was equally impossible: the Tool allows up to 1000, so
entries past 200 would be permanently lost.

### G.2 The resolution

The architecture owner accepted a **scoped errata** giving `status` an `args` bag, symmetric with the
`diff` arm that already carried one. The Tool passes a canonical `{ path?, limit }`, the adapter maps it
to `scope.git.status({ path, limit, signal })`, and **Git itself** applies the pathspec inside
`git status -- <path>`. The Tool never interprets a pathspec: no `startsWith`, no glob matching.

### G.3 Evidence

```text
PATH      a repository with src/a.ts, src/b.ts and docs/a.md dirty
          path = "src" returns exactly the two src entries
          → packages/coding-agent/test/git-status-runtime.test.ts, against a real repository
LIMIT     260 dirty entries
          limit = 250 returns 250 with truncated = true
          limit = 200 returns 200 with truncated = true
          limit = 1000 returns 260 with truncated = false
          → the same suite: never pinned to the Runtime default of 200
SHAPE     status and diff are both exactly environment, args, signal
          → tests/architecture/phase-4e-operations-freeze-errata.test.ts
```

---

## H. What the seven originally-reconcilable builtins needed

Recorded in the BLOCKED edition as analysis, and now as delivered fact:

| Builtin          | Operation                 | Fidelity note                                                                                                                                                 | Status       |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `read_file`      | `ReadFileOperations`      | direct; the Tool additionally needs the resolved **kind** so `NOT_A_FILE` stays its own answer rather than a mapped Runtime error                             | **RESOLVED** |
| `list_directory` | `ListDirectoryOperations` | the interface has no `offset`; the Tool requests `offset - 1 + limit + 1` and slices, keeping `truncated` and `nextOffset` decidable — plus the resolved kind | **RESOLVED** |
| `find_files`     | `FindFilesOperations`     | direct: `pattern` / `path?` / `limit` all present                                                                                                             | **RESOLVED** |
| `apply_patch`    | `PatchOperations`         | direct; `RuntimePatchUncertainError` maps to the canonical uncertain vocabulary, never a safe error                                                           | **RESOLVED** |
| `exec_command`   | `ExecOperations`          | direct; `onOutput` is projected onto the canonical transient update channel                                                                                   | **RESOLVED** |
| `write_stdin`    | `ProcessOperations`       | direct; same update channel, and the poll/write yield distinction is preserved                                                                                | **RESOLVED** |
| `git_diff`       | `GitOperations.diff`      | direct: `args` carries `scope` and `path`, matching `RuntimeGitService.diff` exactly                                                                          | **RESOLVED** |

### H.1 The kind probes, and why they are same-package supersets

`read_file` answers `NOT_A_FILE`; `list_directory` answers `NOT_A_DIRECTORY`. Neither is a Runtime error
code: the Runtime raises one `RuntimePathTypeError` for "the wrong kind", and a Coding Tool may not
import the Runtime's error vocabulary to tell the two apart. Widening a frozen port had already been
corrected once by the errata, so the probes live in `CodingReadOnlyOperations` alongside
`listWithProbe` / `findWithRoot` / `searchWithRoot`:

```text
readFileWithKind       { path, kind, read? }
listDirectoryWithKind  { path, kind, entries }
```

They report a **fact about what happened**, not a change to what the operation does, which is the same
distinction the errata drew for the three probes that already existed. The frozen interfaces stayed
exact, and the errata guard asserts it.

This is the one place where the implementation had drifted from the pre-4E behaviour, and the drift was
found by running the pre-4E Tool set and the target Tool set over the same workspace and diffing the
results — not by reading code. See `PHASE_4E_CODING_TOOLS_OPERATIONS_REPORT.md` §6.

---

## I. Completion gate ledger

Every gate the round's authorising prompt named, with the state it ended in. A gate that once failed
keeps that history in the middle column.

| Gate                                | Initial                                   | Final    | Evidence                                                                                       |
| ----------------------------------- | ----------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| Authority: nine builtins            | target existed, production unused         | **PASS** | boundary guard: ownership; nine builtin suites; daemon E2E                                     |
| Authority: no duplicate impl        | **FAILED** — two implementations per Tool | **PASS** | boundary guard: legacy modules delegate; structure assertions                                  |
| Authority: daemon defaults          | legacy builder                            | **PASS** | boundary guard: production composition; daemon target E2E                                      |
| Operations implemented              | —                                         | **PASS** | eight interfaces + eight Runtime adapters; contract suite; adapter suite                       |
| Operations exactly once             | —                                         | **PASS** | boundary guard: one declaration per interface, repo-wide                                       |
| Builtin ↔ Runtime isolation         | —                                         | **PASS** | boundary guard: no builtin names a capability; adapters are the only holders                   |
| Errata: search include              | **FAILED**                                | **PASS** | errata guard: exact shape; adapter suite: 260-match counter-example                            |
| Errata: search limit                | **FAILED**                                | **PASS** | errata guard: `limit` required; `N + 1` probe pinned in the adapter suite                      |
| Errata: git path                    | **FAILED**                                | **PASS** | errata guard: exact shape; real-repository pathspec regression                                 |
| Errata: git limit                   | **FAILED**                                | **PASS** | real-repository limit 250 / 200 / 1000 regression                                              |
| Errata: old blockers resolved       | **BLOCKED**                               | **PASS** | both gates closed by the errata; history preserved above                                       |
| Security facts target-owned         | legacy projectors in production           | **PASS** | fidelity: same function objects; structural equivalence for six Tools                          |
| Approval identity target-owned      | legacy algorithm in production            | **PASS** | fidelity: byte-identical across nine Tools × nine policy pairs                                 |
| Durable metadata target-sourced     | legacy `ToolDefinition`                   | **PASS** | boundary guard: catalog read first; composition passes `catalog: codingCatalog`                |
| Effects target-owned                | legacy algorithms in production           | **PASS** | fidelity: same function objects; identical facts, events and state folds                       |
| Settlement extension unchanged      | `caelush.coding.effects.v1`               | **PASS** | fidelity: event projection unchanged; kind untouched                                           |
| Atomic settlement preserved         | —                                         | **PASS** | effect projection stays inside the one settlement transaction; daemon E2E observes it          |
| Prompt: snippet target-owned        | guidance in `description`                 | **PASS** | boundary guard: snippet never appended; nine facades carry no guidance                         |
| Prompt: provider production         | provider unreferenced                     | **PASS** | boundary guard: composition reference; prompt E2E reads the real provider request              |
| Prompt: exactly once, budgeted      | —                                         | **PASS** | prompt E2E: one `<tool_guidance>` block; Context token accounting covers it                    |
| Prompt: inactive Tools absent       | —                                         | **PASS** | prompt E2E asserts the active spec set; Git filtering asserted in composition and prompt paths |
| Pipeline: no Dispatcher             | —                                         | **PASS** | boundary guard: production root references neither the class nor the factory                   |
| Pipeline: 4D authorities            | —                                         | **PASS** | boundary guard: batch, durable coordinator, result pipeline and feedback still composed        |
| Contracts: Phase 3 ToolTurn         | —                                         | **PASS** | errata guard: out of the correction's scope                                                    |
| Contracts: `AgentTool`              | —                                         | **PASS** | boundary guard: `CodingToolDefinition.tool` is still an `AgentTool` with no extra field        |
| Contracts: ToolExecutionEnvironment | —                                         | **PASS** | errata guard: exactly `{ workspace, runtime }`                                                 |
| Contracts: six Operations           | —                                         | **PASS** | errata guard: field for field                                                                  |
| Contracts: two corrected            | **FAILED**                                | **PASS** | errata guard: field for field                                                                  |
| No DB migration                     | —                                         | **PASS** | no migration added; no table, column or index changed                                          |
| No Protocol persisted change        | —                                         | **PASS** | `protocol.ToolDefinition` untouched; no persisted field added                                  |
| No parallel Tool execution          | —                                         | **PASS** | every builtin is `SEQUENTIAL`; batch scheduling unchanged                                      |
| No early Phase 4F                   | —                                         | **PASS** | boundary guard: package, exports and Protocol schema intact                                    |

### I.1 Verification gates

| Gate                         | Result                                                         |
| ---------------------------- | -------------------------------------------------------------- |
| `pnpm build`                 | **PASS** — whole workspace                                     |
| `pnpm typecheck`             | **PASS**                                                       |
| `pnpm lint`                  | **PASS**                                                       |
| `pnpm check:architecture:ci` | **PASS** — 27 baseline entries, **0 new, 0 stale**, `READY`    |
| `pnpm test`                  | **PASS** — 486 files, 3095 passed, 5 skipped, 0 failed         |
| `pnpm format:check`          | **PASS**                                                       |
| `git diff --check`           | **PASS** — no whitespace errors                                |
| Clean checkout               | **PASS** — see `PHASE_4E_CODING_TOOLS_OPERATIONS_REPORT.md` §9 |
| Remote parity                | **PASS** — local tip equals the remote branch tip              |

The architecture baseline did **not** grow. A migration that removes ownership from a legacy package is
supposed to leave it unchanged or shrink it, and it is unchanged at 27 with no new and no stale entry.

---

## J. Verification scope of this round

```text
code changed                packages/tools · packages/coding-agent · packages/context ·
                           packages/core · packages/security · apps/daemon
tests added                 nine builtin suites · Operations contracts · Runtime adapters ·
                           Git status regressions · authority fidelity ·
                           prompt production E2E · daemon target production E2E ·
                           Phase 4E errata guard · Phase 4E boundary guard
baseline changed            none (27 entries, 0 new, 0 stale)
new DB migration            none
new Protocol field          none
compatibility removed       none — that is Phase 4F
documents produced          this map, the errata, and the final report
```

### J.1 Existing assertions that were corrected, and why

Two pre-4E guards encoded the state this round was always going to change. Both were _restated against
the 4E target_, not weakened, and both are recorded here because a changed assertion is exactly the
thing a reviewer must be able to find:

```text
tests/architecture/package-boundaries.test.ts
  the tools manifest assertion now lists the @caelush/coding-agent runtime edge, because the legacy
  builtins delegate to the Coding factories and can no longer reach them dev-only

packages/tools/test/tool-system-delegation.test.ts, packages/tools/test/default-tools.test.ts,
apps/daemon/test/daemon-composition.test.ts
  the assertions that used to require guidance inside the provider-visible description now require the
  opposite: guidance is absent from `description`, and the legacy guidance list is empty for the nine
  defaults. Each was replaced with a stronger pair — the description must contain no guidance heading,
  and an explicitly supplied guidance still folds in as before

tests/integration/openai-compatible-wire-contract.test.ts
  the canonical model-facing schema hashes changed because `AIToolSpec.description` no longer carries
  the guidance block. The nine inputSchemaHashes are unchanged, which is the assertion that matters
```

Every other 4A–4D guard runs unmodified.
