# Relevant Context Discovery

Phase 5B adds task-dependent relevant-file planning on top of the project facts produced by Phase 5A. It discovers candidate paths inside the detected project and real workspace boundaries, ranks them deterministically, and selects bounded structured file sections. It does not assemble the final model request; that belongs to Phase 5C.

## Data flow

```text
ProjectIntelligenceSnapshot
           +
          Query
           │
           ▼
 Candidate Discovery
           │
           ▼
      Ignore Policy
           │
           ▼
      Path Ranking
           │
           ▼
 Ranked Candidates
           │
           ▼
     Token Estimator
           │
           ▼
      File Budget
           │
           ▼
RelevantFileContextPlan
```

## Phase boundaries

| Phase                              | Responsibility                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5A — Project Facts                 | `ProjectInspector` resolves workspace scope, project root, environment, profile, and project instructions into `ProjectIntelligenceSnapshot`.                      |
| 5B — Task-dependent Relevant Files | `RelevantFilePlanner` discovers, filters, ranks, estimates, and budgets project-file sections for one `RelevantFileQuery`.                                         |
| 5C — Final Model Context Assembly  | The future `ContextBuilder` combines project facts, instructions, conversation, user input, relevant sections, and runtime model limits into an LLM-ready context. |

`ProjectIntelligenceSnapshot` remains a project-facts value. Relevant files are not added to it because two tasks in the same project can require different selections.

## Ignore and boundary policy

`CandidateFileDiscovery` uses the existing read-only `ContextFileSystem`; it does not call Node filesystem APIs directly. Discovery starts at `snapshot.projectRoot.projectRoot`, and every regular entry is realpath-checked against both that root and `snapshot.workspace.realRoot`. Directory and file symlinks are skipped, so discovery does not follow aliases or cycles.

The `IgnorePolicy` has four layers:

- Hard exclusions always win, including `.git`, `.hg`, `.svn`, `.worktrees`, `node_modules`, `.pnpm`, `.yarn`, `.venv`, `venv`, `__pycache__`, `target`, `dist`, `build`, `coverage`, `out`, `.next`, `.nuxt`, `.turbo`, `.cache`, and `vendor`. A `.gitignore` negation cannot re-include these paths.
- `.gitignore` files are read only from the project root and directories actually traversed below it. Each file is a layer relative to its own directory and is matched root-to-nested with slash-normalized paths. Global excludes, `.git/info/exclude`, and Git configuration are never read. Each `.gitignore` is limited to 131072 bytes; oversized, invalid, or unreadable files fail closed with `ContextIgnoreError`.
- Sensitive ambient-context exclusions block `.env`, `.env.local`, `.env.*.local`, `.npmrc`, `.pypirc`, `.netrc`, `id_rsa`, `id_ed25519`, and common private-key/certificate extensions (`.pem`, `.key`, `.p12`, `.pfx`). `.env.example`, `.env.sample`, and `.env.template` remain eligible.
- Binary extensions such as images, PDFs, archives, native binaries, fonts, media, databases, and WebAssembly are excluded. Unknown extensions are still checked when content is selected; invalid UTF-8 and NUL-containing text is skipped with a diagnostic.

`.gitignore` itself and instruction paths already represented by `ProjectIntelligenceSnapshot.instructions` are not source candidates. A sensitive explicit path is blocked and reported; explicit paths never bypass hard exclusions or the project/workspace boundary.

## Discovery limits and performance

The defaults are `maxVisitedEntries=20000`, `maxCandidateFiles=5000`, `maxDepth=32`, and at most 100 public ranked candidates. These are positive safe-integer options. Reaching a limit returns a `DISCOVERY_LIMIT_REACHED` diagnostic and a truncated result rather than scanning indefinitely or throwing.

Traversal is deterministic: directory entries are sorted and the current cwd region and active package subtree are prioritized before other lexicographic directories. Discovery stores metadata only and does not eagerly read source bodies. File content is read later, only for ranked candidates admitted by the budget selector.

## Ranking

`RelevantPathRanker` accepts a query text and optional relative or absolute explicit paths. Query tokenization lowercases text, splits whitespace, `/`, `.`, `_`, `-`, and camel-case boundaries, keeps Unicode letters/numbers, and ignores terms shorter than two characters. No NLP library, embeddings, AST graph, ripgrep, or LLM is involved.

| Signal                                    |                                 Score |
| ----------------------------------------- | ------------------------------------: |
| `EXPLICIT_PATH_EXACT`                     |                                 +1000 |
| `EXPLICIT_BASENAME`                       |                                  +300 |
| `CWD_SUBTREE`                             |                                  +140 |
| `ACTIVE_PACKAGE`                          |                                  +120 |
| `SAME_DIRECTORY_AS_CWD`                   |                                   +80 |
| `TEST_SOURCE_PAIR`                        |                                  +120 |
| `COMMON_ENTRYPOINT`                       |                                   +25 |
| `PROJECT_DOCUMENT`                        |                                   +20 |
| Exact query basename, per unique term     |                                  +220 |
| Exact query stem, per unique term         |                                  +180 |
| Exact query path segment, per unique term |                                  +100 |
| Query substring, per unique term          |                                   +30 |
| All query-term contribution combined      |                        capped at +500 |
| Depth penalty                             | `-2 * directory depth`, capped at -40 |

Scores are floored at zero. Candidates sort by score descending, active-package membership, depth ascending, and normalized relative path. Every score retains `RelevanceReason[]` so a selection can be explained without provider metadata.

## File budget and structured sections

The default relevant-file budget is 12 selected files, 12000 total estimated tokens, 4000 estimated tokens per file, and 128 minimum useful estimated tokens per file. This is a relevant-project-file planning budget, not a model context window or provider billing-token count.

`Utf8HeuristicTokenEstimator` returns `ceil(UTF-8 byte length / 3)` for non-empty text, and the estimator is injectable for a future exact implementation. The selector reads at most `min(per-file budget, remaining budget) * 3` bytes, capped at 262144 bytes. Existing `ContextFileSystem.readTextFile` provides the valid UTF-8 prefix.

If content is truncated and contains a newline, the final incomplete line is removed; if it contains no newline, the valid prefix is retained. No marker is appended in Phase 5B; the structured `truncated` flag is the rendering input for Phase 5C.

Empty and whitespace-only files do not consume budget. Ordinary read failures and non-text files become diagnostics and are skipped. Each `RelevantFileContextSection` retains `FileContextProvenance` with its absolute path, project-relative path, score, reasons, estimated tokens, included bytes, and truncation state. `RelevantFileContextPlan` is a runtime planning value, not a Protocol DTO, event, storage row, prompt, or LLM request.

## Explicit non-goals

Phase 5B does not implement `ContextBuilder`, conversation history assembly, compaction, summarization, model context-window allocation, `AgentLoop`, Tool execution, Storage, EventBus, Daemon integration, network access, or an `@caelush/llm` dependency.
