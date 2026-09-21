# Phase 4E — Operations Interface Freeze Errata

> Document type: **Interface Freeze Errata** (corrective, minimal, scoped)
> Round: **Phase 4E** — same round, resumed. This is **not** a new round.
> Supersedes: `Caelush_Tool_System_V2_Current_to_Target_Interface_Freeze.md` §165 and the `status` arm
> of §169 **only**.
>
> ```text
> This errata supersedes only:
>
>   Interface Freeze §165   SearchTextOperations
>   Interface Freeze §169   GitOperations.status
>
> All other frozen Tool System V2 interfaces remain unchanged.
> ```

---

## 1. Reason

Phase 4E Milestone A performed a source-verified reconciliation of the eight frozen Operations contracts
against the nine production Coding builtins. Two contracts were proven **unable to express execution
semantics the current production Tools are required to honour**. The round correctly reported
`Phase 4E BLOCKED` rather than regressing behaviour; that record is preserved in
`PHASE_4E_CODING_TOOLS_OPERATIONS_REPORT.md` and is not deleted, amended or rewritten by this errata.

This errata exists because the defect is in the **freeze**, not in the implementation plan:

```text
the frozen interface cannot express a capability input that the Tool genuinely owns
```

It is explicitly **not**:

```text
widening an interface because an implementation found it convenient
relaxing a boundary so a migration is easier
a general un-freeze of the Tool System V2 contracts
```

Four inputs are missing, and each is an **operation semantic input** — it changes what the operation
does, not how the result is presented:

```text
search_text.include   must reach ripgrep as a path-level glob and take effect BEFORE truncation
search_text.limit     is the business-visible maximum match count, and it determines the underlying
                      capture strategy (the runtime is asked for limit + 1 so truncation is provable)
git_status.path       must reach a real `git status -- <path>` invocation
git_status.limit      must reach runtime status parsing / truncation
```

None of the four is presentation metadata, Tool UI metadata, or a post-processing-only argument. Each
alters which bytes the operation reads.

---

## 2. Source evidence

### 2.1 `search_text` — `include` is a pre-filter, `limit` sets the capture strategy

`packages/tools/src/builtins/search-text.ts` (current production, unmodified):

```text
line  40      inputSchema.properties.include  { type: "string", minLength: 1, "Optional file glob to include." }
line  41-47   inputSchema.properties.limit    { integer, minimum 1, maximum 200, default 100 }
line 116      limit = positiveBoundedInteger(args.limit, SEARCH_TEXT_DEFAULT_LIMIT /*100*/, SEARCH_TEXT_MAX_LIMIT /*200*/)
line 133-139  scope.textSearch.search({ cwd, pattern, include?, limit: limit + 1 })
line 149      for (const match of result.matches.slice(0, limit))
line 168      truncated = result.truncated || result.matches.length > limit
```

`packages/runtime/src/search/ripgrep-runner.ts`:

```text
line  30      if (request.include !== undefined) args.push("--glob", request.include)
line 103-104  resolve({ matches: parsed.slice(0, request.limit), truncated: parsed.length > request.limit })
line  78      (capped path) resolve({ matches: parsed.slice(0, request.limit), truncated: true })
line  56-59   ripgrep is killed once MAX_RG_STDOUT_BYTES (1 MiB) is exceeded
```

`packages/runtime/src/search/text-search.ts`:

```text
line 6        readonly limit: number;      // required, not optional
```

`include` becomes ripgrep's `--glob`, i.e. a **path-level pre-filter applied before ripgrep stops
collecting**. The old frozen `SearchTextOperations` carried no `include` and no `limit`, so a Runtime
Operations adapter could not pass either through. The only treatment the old freeze permitted was
tool-side post-filtering, which cannot be equivalent: the port's own `limit` is the ceiling the Tool can
request, so a result truncated at the port can yield a spurious `truncated: true`, or an empty match set
for a file that demonstrably contains the pattern.

### 2.2 `git_status` — `path` is a real Git pathspec, `limit` drives parsing

`packages/tools/src/builtins/git-status.ts`:

```text
line  19      inputSchema.properties.path   { type: "string", minLength: 1, "Workspace-relative pathspec." }
line  20-26   inputSchema.properties.limit  { integer, minimum 1, maximum 1000, default 200 }
line  78-82   scope.git.status({ path?, limit, signal? })
```

`packages/runtime/src/git/service.ts`:

```text
line  49      const path = this.resolvePath(input.path ?? ".")
line  55-71   git status --porcelain=v2 -z --branch --untracked-files=all ... -- <path>
line  74      parseGitStatus(decodeStrict(result.stdout), limit)
line  76-79   entries mapped back to workspace-relative form
```

`packages/runtime/src/git/status-parser.ts`:

```text
line  65      const sorted = entries.sort((l, r) => l.path.localeCompare(r.path, "en"))
line  72-73   entries: sorted.slice(0, limit), truncated: sorted.length > limit
```

`path` decides **which paths Git reports at all**, and `limit` slices the parsed result. The old frozen
`GitOperations.status({ environment, signal })` had no channel for either. The freeze demonstrably knows
how to carry per-call arguments — `GitOperations.diff` takes `args`, and the Interface Freeze explicitly
allows both `scope` and `path` through it — so `status` was a deliberate omission rather than a shape the
authors intended to cover another way.

### 2.3 Why no faithful workaround exists

| Attempted mapping                                                              | Why it fails                                                                                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| tool-side `include` filter over an unbounded runtime result                    | `RuntimeTextSearchRequest.limit` is required and the ripgrep adapter slices at it; no unbounded request exists              |
| request the observed maximum (200) and filter                                  | the port's own ceiling still truncates before filtering; both divergences remain reachable                                  |
| request `Number.MAX_SAFE_INTEGER`                                              | the adapter kills ripgrep at 1 MiB stdout and returns a partial list with `truncated: true`                                 |
| fold `include` into `pattern`                                                  | changes regex semantics; explicitly forbidden by the round                                                                  |
| drop `include` / drop `limit`                                                  | silent behaviour regression; explicitly forbidden                                                                           |
| call `git status` with no pathspec and filter entries tool-side                | changes which paths Git reports at all; Git pathspec glob and `:(magic)` semantics cannot be reproduced by string filtering |
| accept the runtime default `limit` of 200 for `git_status`                     | the Tool allows 1000; entries past 200 would be permanently lost, changing `entries` and `truncated`                        |
| let a builtin construct its own Runtime adapter per call to bind the arguments | requires importing `RuntimeResolver` / `RuntimeWorkspaceScope` into builtin code, which the round forbids                   |

The round therefore reported `BLOCKED` with the analysis above, and the architecture owner accepted a
corrected freeze rather than a behaviour regression.

---

## 3. Affected contracts

```text
SUPERSEDED   Interface Freeze §165   SearchTextOperations               (entire interface input shape)
SUPERSEDED   Interface Freeze §169   GitOperations.status               (status arm only)

UNCHANGED    Interface Freeze §169   GitOperations.diff                 (already carries args)
UNCHANGED    Interface Freeze §162   ReadFileOperations
UNCHANGED    Interface Freeze §163   ListDirectoryOperations
UNCHANGED    Interface Freeze §164   FindFilesOperations
UNCHANGED    Interface Freeze §166   PatchOperations
UNCHANGED    Interface Freeze §167   ExecOperations
UNCHANGED    Interface Freeze §168   ProcessOperations
UNCHANGED    Interface Freeze §160-161, §170-172   Operations principles, JsonObject returns, adapters, mockability
UNCHANGED    packages/agent/src/tools/types/execution-environment.ts   ToolExecutionEnvironment
UNCHANGED    packages/agent/src/tools/batch/**            canonical Tool batch (Phase 4D)
UNCHANGED    packages/agent/src/tools/observation/**      canonical feedback + normalization (Phase 4D)
UNCHANGED    packages/agent/src/run/ports/tool-turn.ts    frozen Tool turn contract (Phase 3)
UNCHANGED    packages/runtime/src/search/text-search.ts   RuntimeTextSearchRequest
UNCHANGED    packages/runtime/src/git/contracts.ts        RuntimeGitService
```

---

## 4. Old contract

### 4.1 `SearchTextOperations` (Interface Freeze §165) — SUPERSEDED

```ts
export interface SearchTextOperations {
  search(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly pattern: string;
    readonly path?: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly matches: readonly JsonObject[];
    readonly truncated: boolean;
  }>;
}
```

### 4.2 `GitOperations.status` (Interface Freeze §169, status arm) — SUPERSEDED

```ts
status(input: {
  readonly environment: ToolExecutionEnvironment;
  readonly signal: AbortSignal;
}): Promise<JsonObject>;
```

---

## 5. Corrected contract

### 5.1 `SearchTextOperations` — NEW EXACT FREEZE

```ts
export interface SearchTextOperations {
  search(input: {
    readonly environment: ToolExecutionEnvironment;

    readonly pattern: string;

    readonly path?: string;

    readonly include?: string;

    readonly limit: number;

    readonly signal: AbortSignal;
  }): Promise<{
    readonly matches: readonly JsonObject[];

    readonly truncated: boolean;
  }>;
}
```

No further field may be added. This is the exact frozen shape.

### 5.2 `GitOperations` — NEW EXACT FREEZE

The `status` arm gains `args`, which makes it symmetric with the arm that already had one:

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

`status` may not be widened to carry `runtime`, `scope`, `gitService`, `resolver` or `absolutePath`.

---

## 6. Behaviour preserved

### 6.1 Input semantics

```text
SearchTextOperations
  pattern   ripgrep-compatible regular expression
  path      workspace-relative search root
  include   ripgrep-compatible include glob, applied by the Runtime search implementation BEFORE
            result truncation
  limit     maximum number of Tool-business-visible matches
  signal    required AbortSignal

GitOperations.status
  args.path   optional workspace-relative Git pathspec, interpreted and sanitised by RuntimeGitService
  args.limit  maximum number of status entries
  signal      required AbortSignal
```

### 6.2 `SearchTextOperations.limit` is a business bound, not a capture bound

This is the load-bearing point of the correction. The Operation's `limit` is the **business-visible
maximum**, while `RuntimeTextSearchRequest.limit` is a **capture bound**. The adapter therefore keeps the
current production probe strategy exactly:

```text
Operation input limit = N
        ↓  Runtime adapter
Runtime search request: limit = N + 1
        ↓  Runtime
matches
        ↓  adapter / Tool
visible matches = first N
truncated       = runtime.truncated OR rawMatches.length > N
```

The existing `N + 1` probe is preserved, not replaced by the new port.

### 6.3 The include glob must reach Runtime

The Runtime Operations adapter must call the Runtime search with `include`, so the final effect remains
`ripgrep --glob <include>`. Tool-side filtering may not be reintroduced as the primary semantics.

### 6.4 Git path stays Runtime-owned

`GitOperations.status` receives a canonical `{ path?, limit }` shape that the **Coding builtin** has
already validated and defaulted from prepared args. The adapter maps it to
`scope.git.status({ path?, limit, signal })`, and `RuntimeGitService` continues to interpret and sanitise
the pathspec. A Coding builtin must never interpret a Git pathspec itself.

### 6.5 Unchanged by this errata

```text
Tool names                       provider-visible input schemas        default tool order
result / output schemas          risk levels, capabilities, runtime requirements
safe failure codes               uncertain-side-effect semantics       approval identity inputs
Security Gate behaviour          budget semantics                      durable ToolInvocation rows
ToolObservation schema           effect semantics                      AgentState effect semantics
Run lifecycle authority          Completion authority                  model feedback authority
```

---

## 7. Non-goals

```text
no general un-freeze of the Interface Freeze
no change to any of the six other Operations contracts
no change to ToolExecutionEnvironment
no change to the Runtime contracts (RuntimeTextSearchRequest and RuntimeGitService are already correct)
no new Git capability (:(glob), :(icase) and other pathspec magic are NOT added by this round)
no new or widened provider-visible Tool schema
no Context V2, Security V2, Memory V2 or Message V2
no parallel Tool execution, no DB migration, no new Protocol persisted field
no Phase 4F work: packages/tools deletion, protocol.ToolDefinition retirement, compatibility retirement
```

---

## 8. Authority scope

Revised authority order for the remainder of Phase 4E:

```text
1. the Phase 4E resume prompt
2. this errata — covering ONLY SearchTextOperations and GitOperations.status
3. Current → Target Interface Freeze — fully in force except where this errata supersedes it
4. Tool System V2 Refactor Spec
5. PHASE_4_TOOL_SYSTEM_ROUND_PLAN
6. Phase 3 frozen contracts
7. MIGRATION_EXECUTION_CONTRACT
8. current Phase 4D/4E source
```

After the corrected contracts are implemented and their tests pass, the freeze re-enters strict mode:

```text
SearchTextOperations exact shape    = the errata shape
GitOperations.status exact shape    = the errata shape
all other Operations                = the original Interface Freeze shape
```

---

## 9. Required tests

### 9.1 Contract / type tests (`tests/architecture/phase-4e-operations-freeze-errata.test.ts`)

```text
SearchTextOperations has exactly: environment, pattern, path?, include?, limit, signal
GitOperations.status has exactly: environment, args, signal
GitOperations.diff has exactly:   environment, args, signal
ToolExecutionEnvironment is unchanged at { workspace, runtime }
no Runtime capability name (RuntimeResolver, RuntimeWorkspaceScope, RuntimeFileSystem,
  RuntimeGitService, RuntimeExecService, LocalRuntime) appears in any Operations public input
the six unrelated Operations contracts still match the original Interface Freeze
```

### 9.2 Search text Runtime adapter tests

```text
include undefined · include exact file glob · include nested glob
limit 1 · limit 100 · limit 200 · more matches than limit · runtime truncated · stdout cap
invalid regex · abort
```

### 9.3 Search text pre-filter counter-example (the decisive fidelity test)

```text
fixture:  a-many.ts with > 200 pattern matches
          z-target.ts with 3 pattern matches
call:     include = "z-target.ts", limit = 100
expect:   matches = 3, truncated = false
```

This proves `include` is a Runtime **pre**-filter. A post-filter implementation returns
`matches = [], truncated = true`, which is exactly what made the old freeze unusable.

### 9.4 Git status Runtime adapter tests

```text
default path · explicit path · limit 1 · limit 200 · limit 1000
clean · dirty · branch · detached · ahead · behind · truncated
invalid path · not a git repository · abort
```

### 9.5 Git status limit-above-runtime-default regression

```text
fixture: more than 200 dirty entries
call:    limit = 250
expect:  250 visible entries (never silently pinned to the runtime default of 200)
```

### 9.6 Git status path regression

```text
fixture: src/a.ts, src/b.ts, docs/a.md all dirty
call:    path = "src"
expect:  only src-related status, equivalent to the current legacy behaviour
```

### 9.7 Fidelity comparisons

Characterization tests are written against the **current legacy implementation first**, then the new
Coding implementation must pass the same tests, and only then is the legacy implementation reduced to a
wrapper:

```text
search_text:  pattern, path, include, limit  → content, details.path, details.pattern,
                                                details.count, details.truncated, details.matches
git_status:   path, limit                    → content, branch, detached, ahead, behind, clean,
                                                entries, truncated
```

Coverage spans `default`, `custom`, boundary minimum and boundary maximum — explicitly including
`search_text limit = 200` and `git_status limit = 1000`.

### 9.8 Existing guard expectations corrected, not weakened

Any earlier test that pinned the defective shape is corrected to the errata shape. This is an authority
correction, not a weakened assertion, and it is recorded as such in the Phase 4E report.

---

## 10. Record

```text
Phase 4E status at time of errata     BLOCKED (Milestone A)
Blocked commit                        1920cdde65118defea39355faefe072b1d57ae8e
                                        "docs(architecture): record the phase 4e reconciliation blocker"
Blocked commit disposition            preserved unchanged; not reset, not rebased, not amended, not
                                      force-pushed, and its evidence documents are not deleted
Errata authority                      architecture owner decision, accepted in the Phase 4E resume prompt
Scope of supersession                 Interface Freeze §165 and the §169 status arm, and nothing else
Resume plan                           Milestones B–J continue inside the same Phase 4E
Final phase count                     unchanged: 4A, 4B, 4C, 4D, 4E, 4F
```
