# Caelush Architecture V2 — Phase 4E Coding Tools, Operations Ports & Runtime Adapters Acceptance Map

> Round: **Phase 4E** — the fifth and only fifth round of Phase 4.
> Phase 4 is permanently frozen at exactly six rounds: `4A`, `4B`, `4C`, `4D`, `4E`, `4F`.
>
> Base commit: `d21595f14fd18d66369aec4f1a090b8cc459656e` (Phase 4D final tip)
> Branch: `deepseek/architecture-v2-phase-4e-coding-tools-operations-runtime`
>
> **Round outcome: `Phase 4E BLOCKED`.**
> The blocker is a source-verified contradiction between two frozen Operations contracts and the
> current production behaviour of two of the nine builtins. It is recorded in §F and §G. No builtin
> was migrated, and no file outside this document and its sibling report was changed.

---

## A. Why this map exists before any code change

The authorising prompt fixes Milestone A as _"source/freeze reconciliation + Acceptance Map"_ and makes
the two reconciliation gates the round's first decision point:

> 如果扫描源码后无法证明存在合法实现：必须 `BLOCKED`
> 如果没有解决方案：不要先迁一半其他 Tool 再回来。应尽早决定：`implementable` or `BLOCKED`

Milestones B–J were therefore **not started**. This map records the Current → Target analysis that was
completed, the seven builtins that do map cleanly, and the two that do not.

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

---

## C. Frozen contracts this round implements

Reproduced verbatim from the _Current → Target Interface Freeze_ as supplied to this round. The
documents are not in the repository tree; they were read in full from their authorising copies
(`git ls-files` finds neither). No clause number here is fabricated.

### C.1 `ReadFileOperations` (§162) — maps cleanly

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

### C.2 `ListDirectoryOperations` (§163) — maps cleanly, with a documented `offset` treatment

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

### C.3 `FindFilesOperations` (§164) — maps cleanly

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

### C.4 `SearchTextOperations` (§165) — **RECONCILIATION GATE: FAILED**

```ts
export interface SearchTextOperations {
  search(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly pattern: string;
    readonly path?: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly matches: readonly JsonObject[]; readonly truncated: boolean }>;
}
```

### C.5 `PatchOperations` (§166) — maps cleanly

```ts
export interface PatchOperations {
  apply(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly patch: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly changeCount: number; readonly changes: readonly JsonObject[] }>;
}
```

Runtime uncertain patch must not be swallowed into an ordinary failure (§166).

### C.6 `ExecOperations` (§167) — maps cleanly

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

§167 authorises the first Runtime adapter to have **no live `onOutput` implementation**: the interface
reserves realtime capability, the adapter returns the current Runtime result.

### C.7 `ProcessOperations` (§168) — maps cleanly

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

### C.8 `GitOperations` (§169) — `diff` maps cleanly, **`status` RECONCILIATION GATE: FAILED**

```ts
export interface GitOperations {
  status(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly signal: AbortSignal;
  }): Promise<JsonObject>;

  diff(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly args: JsonObject;
    readonly signal: AbortSignal;
  }): Promise<JsonObject>;
}
```

### C.9 Why `JsonObject` returns are legitimate (§170)

```text
the current Runtime result schema is still evolving
what this round freezes is the minimal capability boundary,
not a promotion of every Runtime internal result type into an Agent public contract
a concrete Coding Tool may define a typed result internally
```

### C.10 Operations principles (§160, §161, §171, §172)

```text
a Coding Tool depends on a minimal Operations port, never on RuntimeResolver or RuntimeWorkspaceScope
every Operation receives ToolExecutionEnvironment and AbortSignal,
  or holds a resolver at adapter construction time
an Operation returns a Tool business-friendly result, not a whole Runtime scope
Runtime adapters are mockable: no builtin unit test needs a real filesystem, shell or Git repo
```

### C.11 Prompt rules (§74, §182 of the round) — target ownership

```text
CodingToolDefinition.promptSnippet is NOT appended to AIToolSpec.description
CodingToolCatalog → ToolPromptContextProvider → ContextEngine → Prepared Model Context
```

---

## D. Current → Target ownership map

Legend: **MAPS** = faithful mapping proven; **GATE** = reconciliation gate failed (§F/§G).

| #   | Responsibility                        | Current owner                                                     | Target owner                                       | Migration type                            | Compatibility bridge                  | 4E completion requirement                                    | 4F exit requirement             |
| --- | ------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------- | ------------------------------------- | ------------------------------------------------------------ | ------------------------------- |
| 1   | `read_file` implementation            | `tools/builtins/read-file.ts`                                     | `coding-agent/tools/builtins/read-file.ts`         | move + re-shape to `CodingToolDefinition` | `tools` wrapper delegating via bridge | **MAPS** — `ReadFileOperations`                              | delete legacy wrapper           |
| 2   | `list_directory` implementation       | `tools/builtins/list-directory.ts`                                | `coding-agent`                                     | move + re-shape                           | `tools` wrapper                       | **MAPS** — `offset` applied tool-side over `limit` requests  | delete                          |
| 3   | `find_files` implementation           | `tools/builtins/find-files.ts`                                    | `coding-agent`                                     | move + re-shape                           | `tools` wrapper                       | **MAPS** — `FindFilesOperations`                             | delete                          |
| 4   | `search_text` implementation          | `tools/builtins/search-text.ts`                                   | `coding-agent`                                     | move + re-shape                           | `tools` wrapper                       | **GATE FAILED** — `include` + `limit` unrepresentable        | —                               |
| 5   | `apply_patch` implementation          | `tools/builtins/apply-patch.ts`                                   | `coding-agent`                                     | move + re-shape                           | `tools` wrapper                       | **MAPS** — `PatchOperations` + uncertain mapping             | delete                          |
| 6   | `exec_command` implementation         | `tools/builtins/exec-command.ts`                                  | `coding-agent`                                     | move + re-shape                           | `tools` wrapper                       | **MAPS** — `ExecOperations`                                  | delete                          |
| 7   | `write_stdin` implementation          | `tools/builtins/write-stdin.ts`                                   | `coding-agent`                                     | move + re-shape                           | `tools` wrapper                       | **MAPS** — `ProcessOperations`                               | delete                          |
| 8   | `git_status` implementation           | `tools/builtins/git-status.ts`                                    | `coding-agent`                                     | move + re-shape                           | `tools` wrapper                       | **GATE FAILED** — `path` + `limit` unrepresentable           | —                               |
| 9   | `git_diff` implementation             | `tools/builtins/git-diff.ts`                                      | `coding-agent`                                     | move + re-shape                           | `tools` wrapper                       | **MAPS** — `GitOperations.diff({ args })`                    | delete                          |
| 10  | default builtin composition + order   | `tools/builtins/default-tools.ts`                                 | `coding-agent/tools/builtins/default-tools.ts`     | move                                      | re-export                             | one declaration, frozen order                                | delete                          |
| 11  | result helpers                        | `tools/builtins/result.ts`                                        | `coding-agent/tools/builtins/result.ts`            | split                                     | —                                     | helpers only, no Runtime                                     | delete                          |
| 12  | security facts vocabulary             | `tools/security-facts.ts`                                         | `coding-agent/tools/security/security-facts.ts`    | move                                      | `tools` re-export                     | one declaration                                              | delete                          |
| 13  | per-tool security fact projectors     | `tools/builtins/security-facts.ts`                                | `coding-agent/tools/security/`                     | move                                      | `tools` re-export                     | nine projectors, structure-equivalent                        | delete                          |
| 14  | approval identity                     | `tools/approval-key.ts`                                           | `coding-agent/tools/security/approval-identity.ts` | move                                      | `tools` re-export                     | byte-identical keys for all nine                             | delete                          |
| 15  | Coding durable metadata (`riskLevel`) | legacy `ToolDefinition`                                           | `CodingToolCatalog`                                | re-point                                  | `ToolDurableMetadataPort` seam        | catalog is the source                                        | seam retained until Protocol V2 |
| 16  | Coding effect vocabulary              | `tools/tool-effects.ts`                                           | `coding-agent/tools/effects/effects.ts`            | split                                     | `tools` re-export                     | facts only                                                   | delete                          |
| 17  | effect → Tool result projection       | `tools/tool-effects.ts`                                           | `coding-agent/tools/effects/effect-projectors.ts`  | split                                     | `tools` re-export                     | four projectors identical                                    | delete                          |
| 18  | effect → AgentState projection        | `tools/tool-effects.ts`                                           | `coding-agent/tools/effects/state-projector.ts`    | split                                     | `tools` re-export                     | `changedFiles` / `activeProcesses` unchanged                 | delete                          |
| 19  | effect → durable event projection     | `tools/tool-effects.ts`                                           | `coding-agent/tools/effects/event-projector.ts`    | split                                     | `tools` re-export                     | nine discriminants unchanged                                 | delete                          |
| 20  | settlement-extension encoding         | `tools/tool-effects.ts`                                           | `coding-agent/tools/effects/`                      | move                                      | —                                     | `caelush.coding.effects.v1` unchanged                        | delete                          |
| 21  | settlement-extension decoding         | `tools/settlement-extension-bridge.ts`                            | `coding-agent/tools/effects/`                      | move                                      | `tools` delegate                      | one decoder                                                  | delete                          |
| 22  | presentation                          | `tools/presentation.ts`                                           | `coding-agent/tools/presentation/`                 | move                                      | `tools` re-export                     | safe label unchanged                                         | delete                          |
| 23  | prompt / model guidance               | `tools/model-guidance.ts` + `registry-builder` description append | `coding-agent/tools/prompt/`                       | **semantic cutover**                      | none                                  | guidance leaves `description`, enters Context once, budgeted | delete                          |
| 24  | runtime resolution                    | per-builtin `withRuntimeScope`                                    | `coding-agent/tools/operations/runtime-adapters/`  | move                                      | —                                     | builtins never see `RuntimeResolver`                         | —                               |
| 25  | filesystem operations                 | none (broad scope)                                                | `operations/read-file-operations.ts` etc.          | new narrow ports                          | —                                     | eight frozen interfaces                                      | —                               |
| 26  | file discovery                        | `scope.discovery`                                                 | `FindFilesOperations`                              | narrow                                    | —                                     | **MAPS**                                                     | —                               |
| 27  | text search                           | `scope.textSearch`                                                | `SearchTextOperations`                             | narrow                                    | —                                     | **GATE FAILED**                                              | —                               |
| 28  | patch                                 | `scope.patch`                                                     | `PatchOperations`                                  | narrow                                    | —                                     | **MAPS**                                                     | —                               |
| 29  | exec                                  | `scope.exec.execute`                                              | `ExecOperations`                                   | narrow                                    | —                                     | **MAPS**                                                     | —                               |
| 30  | process interaction                   | `scope.exec.interact`                                             | `ProcessOperations`                                | narrow                                    | —                                     | **MAPS**                                                     | —                               |
| 31  | git                                   | `scope.git`                                                       | `GitOperations`                                    | narrow                                    | —                                     | `diff` **MAPS**, `status` **GATE FAILED**                    | —                               |
| 32  | daemon default registration           | `createDefaultBuiltinToolRegistrations(runtimeResolver)`          | `createDefaultCodingTools(operations)`             | cutover                                   | legacy builder retained as adapter    | defaults originate from `coding-agent`                       | delete legacy builder           |

---

## E. Authorising-prompt reconciliation gates

The prompt defines exactly two source-verified gates that must be decided before migrating anything,
and states that failure to find a faithful mapping is `BLOCKED` rather than an invitation to regress
behaviour.

### E.1 `SearchTextOperations` vs `search_text` include/limit (§31 of the prompt)

Forbidden treatments:

```text
silently ignore include                          silently ignore limit
fold include into pattern                        fix limit to its default
add a field to SearchTextOperations              pass parameters through hidden global state / AsyncLocalStorage
let the builtin reach Runtime directly
```

An implementation is legal only if it simultaneously preserves the exact frozen interface, the
provider-visible schema, `include` semantics, `limit` semantics, workspace containment, truncation
semantics, and no direct Runtime dependency in the Tool.

### E.2 `git_status` vs `GitOperations.status` path/limit (§41 of the prompt)

Forbidden treatments:

```text
add args to status()                             ignore path
ignore limit                                     simulate Git pathspec with a simple startsWith
fix a single limit                               expose the Runtime service to the Tool
```

An implementation is legal only if it simultaneously preserves the exact frozen interface, the
provider-visible schema, `path` behaviour, `limit` behaviour, Git pathspec behaviour, truncation, and
no direct Runtime dependency in the Tool.

---

## F. Reconciliation result — `SearchTextOperations`: FAILED

### F.1 Frozen contract

```text
SearchTextOperations.search({ environment, pattern, path?, signal })
    → { matches, truncated }
```

There is deliberately **no `include` and no `limit`** (§30 of the prompt: "Frozen interface **没有**
`include` / `limit`. 绝对不能直接加进去").

### F.2 Current source evidence

`packages/tools/src/builtins/search-text.ts`:

```text
line  40     inputSchema.properties.include  { type: "string", minLength: 1, ... }
line  41-47  inputSchema.properties.limit    { integer, minimum 1, maximum 200, default 100 }
line 116     limit = positiveBoundedInteger(args.limit, SEARCH_TEXT_DEFAULT_LIMIT /*100*/, SEARCH_TEXT_MAX_LIMIT /*200*/)
line 133-139 scope.textSearch.search({ cwd, pattern, include?, limit: limit + 1 })
line 149     for (const match of result.matches.slice(0, limit))
line 168     truncated = result.truncated || result.matches.length > limit
```

`packages/runtime/src/search/ripgrep-runner.ts`:

```text
line  30     if (request.include !== undefined) args.push("--glob", request.include)
line 103-104 resolve({ matches: parsed.slice(0, request.limit), truncated: parsed.length > request.limit })
line  78     (capped path) resolve({ matches: parsed.slice(0, request.limit), truncated: true })
line  56-59  stdout is killed once MAX_RG_STDOUT_BYTES (1 MiB) is exceeded
```

`include` becomes ripgrep's `--glob`, a **path-level pre-filter**, and `limit` truncates the match
list **before** the Tool ever sees it. `RuntimeTextSearchRequest.limit` is **required**:

```text
packages/runtime/src/search/text-search.ts:6   readonly limit: number;
```

### F.3 The exact conflict

The only treatment the prompt permits is _pure Tool-side deterministic post-processing_, which in this
case would mean:

```text
operations.search({ environment, pattern, path, signal })       // no include
    → runtime returns at most `request.limit` matches, globally ordered
    → the Tool filters those matches by the include glob itself
```

This cannot be shown equivalent, because **the pre-filter and the post-filter see different inputs**.
ripgrep applies `--glob` _before_ it stops collecting; the Tool applies the glob _after_ the runtime has
already discarded everything past `limit`. The runtime's own ceiling is the frozen interface's own
parameter, so the Operations port cannot ask for more, and the ripgrep adapter additionally caps stdout
at 1 MiB before either limit applies.

The two divergences are reachable with ordinary inputs:

```text
1. spurious truncation
   default limit = 100, the Tool must request at most 200
   a monorepo where some file has >= 200 matching lines, and the include-glob target sorts after it
   current : ripgrep globs -> only the target file is searched -> 3 matches -> truncated = false
   proposed: runtime returns 200 matches, all from the other file -> filtered set is empty
             -> matches = [] and truncated = true            ← both content and flag differ

2. an empty result where the current behaviour finds matches
   with `include` set, the intended file's matches may simply never appear inside the first `limit`
   entries the runtime is willing to return, so the Tool reports "No matches found." for a file that
   demonstrably contains the pattern
```

### F.4 Legal mappings attempted and why each fails

| Attempt                                                                  | Why it fails                                                                                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| tool-side include filter over an unbounded runtime result                | `RuntimeTextSearchRequest.limit` is required and the ripgrep adapter slices at it; no unbounded request exists                                  |
| request the maximum (`SEARCH_TEXT_MAX_LIMIT = 200`) and filter           | still a hard ceiling; divergence 1 and 2 above remain reachable                                                                                 |
| request `Number.MAX_SAFE_INTEGER`                                        | the adapter kills ripgrep at 1 MiB stdout and resolves with `truncated: true` and a partial list, so the result is still not the true match set |
| fold `include` into `pattern`                                            | explicitly forbidden; also changes regex semantics                                                                                              |
| ignore `include`                                                         | explicitly forbidden; a silent behaviour regression                                                                                             |
| ignore `limit`                                                           | explicitly forbidden; changes the provider-visible result size                                                                                  |
| widen `SearchTextOperations` with `include`/`limit`                      | explicitly forbidden, and the §197 BLOCKED gate lists it                                                                                        |
| carry the parameters out of band (AsyncLocalStorage / module state)      | explicitly forbidden                                                                                                                            |
| let the builtin build its own Runtime adapter per call to bind `include` | requires the builtin to import `RuntimeResolver` / `RuntimeWorkspaceScope`, which §20 and §118 forbid                                           |

### F.5 Outcome

```text
no faithful mapping exists under the frozen SearchTextOperations contract
```

---

## G. Reconciliation result — `GitOperations.status`: FAILED

### G.1 Frozen contract

```text
GitOperations.status({ environment, signal }) → JsonObject
```

§41 of the prompt states plainly that the frozen `status()` has **no `path` and no `limit`**, and that
the result must be a source-verified reconciliation. Note the asymmetry that makes this gate harder
than the `search_text` one: `GitOperations.diff` _does_ carry `args` (§42 explicitly allows both `scope`
and `path` through), so the freeze demonstrably knows how to carry per-call arguments when it means to.

### G.2 Current source evidence

`packages/tools/src/builtins/git-status.ts`:

```text
line 19     inputSchema.properties.path   { type: "string", minLength: 1, "Workspace-relative pathspec." }
line 20-26  inputSchema.properties.limit  { integer, minimum 1, maximum 1000, default 200 }
line 78-82  scope.git.status({ path?, limit, signal? })
```

`packages/runtime/src/git/service.ts`:

```text
line  49     const path = this.resolvePath(input.path ?? ".")          // resolved lexically
line  55-71  git status --porcelain=v2 -z --branch --untracked-files=all ... -- <path>
line  74     const parsed = parseGitStatus(decodeStrict(result.stdout), limit)
line  76-79  entries mapped back to workspace-relative form, then returned
```

`packages/runtime/src/git/status-parser.ts`:

```text
line  65     const sorted = entries.sort((l, r) => l.path.localeCompare(r.path, "en"))
line  72-73  entries: sorted.slice(0, limit), truncated: sorted.length > limit
```

So **`path` is a real Git pathspec passed to the `git status` invocation**, and it decides which paths
Git itself reports. `limit` then truncates the sorted result.

### G.3 The exact conflict

`GitOperations.status({ environment, signal })` has **no channel** through which a per-call pathspec
can reach `RuntimeGitService.status({ path })`.

Every candidate channel is closed by evidence:

| Candidate channel                   | Evidence it cannot carry a pathspec                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`                       | `packages/agent/src/tools/types/execution-environment.ts:21-24` — `ToolExecutionEnvironment` is exactly `{ workspace, runtime }`, and `WorkspaceRef` is `{ id, path }`; neither is a Git pathspec |
| a second method on `GitOperations`  | §169 freezes the interface to exactly `status` and `diff`; adding a method widens it                                                                                                              |
| `signal`                            | an `AbortSignal` is not a pathspec                                                                                                                                                                |
| adapter constructor                 | §161 allows a resolver at construction, but `path` **varies per call**; a closure bound at construction cannot see the call's argument                                                            |
| the Tool doing the filtering itself | would require either dropping the pathspec from the Git invocation or approximating it — both forbidden                                                                                           |

Approximating the pathspec is not merely forbidden, it is **not implementable**: Git pathspecs support
globs, `:(glob)`, `:(icase)`, `:(exclude)` and other magic. §41 forbids a `startsWith` simulation, and no
such simulation could be equivalent even if it were allowed.

### G.4 Legal mappings attempted and why each fails

| Attempt                                                            | Why it fails                                                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| call `status()` with no pathspec and filter entries tool-side      | changes _which paths Git reports at all_; Git's pathspec semantics (globs and magic) cannot be reproduced by string filtering |
| call `status()` with no pathspec and return everything             | removes `path` support entirely; explicitly forbidden                                                                         |
| call `status()` and ignore the returned entries' path relationship | ignores `path`; explicitly forbidden                                                                                          |
| accept the runtime's default `limit` of 200                        | the Tool allows up to 1000; entries past 200 would be permanently lost, so the visible `entries` and `truncated` both change  |
| add `args` or `path`/`limit` to `status()`                         | explicitly forbidden; also listed in the §197 BLOCKED gate                                                                    |
| expose `RuntimeGitService` to the Tool                             | explicitly forbidden                                                                                                          |

### G.5 Outcome

```text
no faithful mapping exists under the frozen GitOperations.status contract
```

---

## H. What the seven reconcilable builtins would need (not executed)

Recorded so a future round does not have to redo the analysis:

| Builtin          | Frozen Operation               | Fidelity note                                                                                                                                                                                                     |
| ---------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`      | `ReadFileOperations.read`      | direct: `path`/`offset`/`limit` all present; `offset` outside file stays a safe `INVALID_RANGE`                                                                                                                   |
| `list_directory` | `ListDirectoryOperations.list` | the interface has no `offset`; the Tool requests `offset - 1 + limit` entries and slices tool-side. Visible entries, ordering, `nextOffset`, bounds and truncation all remain derivable from the same sorted list |
| `find_files`     | `FindFilesOperations.find`     | direct: `pattern`/`path?`/`limit` all present                                                                                                                                                                     |
| `apply_patch`    | `PatchOperations.apply`        | direct; `RuntimePatchUncertainError` must map to the canonical uncertain vocabulary, never to a safe error                                                                                                        |
| `exec_command`   | `ExecOperations.execute`       | direct: `command`/`workdir?`/`tty`/`yieldTimeMs`/`onOutput?` all present; `onOutput` has no live Runtime source (§36, §167)                                                                                       |
| `write_stdin`    | `ProcessOperations.interact`   | direct: `sessionId`/`chars`/`yieldTimeMs`/`onOutput?` all present                                                                                                                                                 |
| `git_diff`       | `GitOperations.diff({ args })` | direct: `args` carries `scope` and `path`, matching `RuntimeGitService.diff` exactly                                                                                                                              |

---

## I. BLOCKED gate

Per §197 of the authorising prompt, the round stops when completion would require any of:

```text
widen SearchTextOperations                      ✔ REQUIRED
widen GitOperations.status                      ✔ REQUIRED
```

Both are required, so:

```text
Phase 4E BLOCKED
```

The minimum architecture decision each gate needs is recorded in the sibling report
`PHASE_4E_CODING_TOOLS_OPERATIONS_REPORT.md` §7. Neither is a Phase 4F concern, and no `4E-2` is
invented: the freeze itself has to state how a Tool's per-call search/filter arguments reach its
narrow Operations port.

---

## J. Verification state of this round

```text
code changed                none
tests changed                none
baseline changed            none
architecture baseline       27 entries, 0 new, 0 stale, READY (unchanged; no code was touched)
documents produced          this map, the sibling report, and the round-plan status note
```
