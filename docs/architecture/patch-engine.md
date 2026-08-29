# Safe File Mutation & Patch Engine

Phase 8B adds the first mutation capability to the Phase 8A local runtime. The only formal mutation Tool surface is the JSON `apply_patch` Tool; it accepts `{ "patch": string }` and applies a strict, bounded, Codex-shaped patch document to UTF-8 text files inside the active workspace.

## Ownership and pipeline

```text
ToolDispatcher
  ▼
apply_patch handler
  ▼
RuntimeResolver → LocalRuntime → RuntimeWorkspaceScope.patch
  ▼
PatchParser → PatchDocument → PatchPlanner → PreparedPatch
                                      ▼
                              all-path hash guard
                                      ▼
                              PatchCommitter
                                      ▼
                         verified PatchCommitResult
```

The parser is pure: it does not access Runtime, filesystem, Storage, Events, or Tools. The planner resolves paths through the existing Phase 8A `WorkspacePathResolver`, reads all existing sources, validates text and hunk matches, derives every final byte array in memory, and records raw-byte SHA-256/size versions. The committer is the only layer allowed to invoke patch-private mutation primitives.

The phases are intentionally distinct:

1. Parse and validate the complete envelope, directives, paths, conflicts, hunk syntax, and budgets.
2. Resolve every source and destination and prepare every change without mutation.
3. Re-check every source type/size/hash and every Add/Move destination absence immediately before the first mutation.
4. Commit the prepared changes in deterministic source order, stopping at the first failure.
5. Verify final bytes and paths. If an ordinary in-process commit fails, restore the committed prefix in reverse order and verify exact restoration.

This is transactional best effort, not an OS-level transaction. A process crash, power loss, process kill, or disk failure can leave an uncertain side effect. Phase 8B makes no crash-atomic, fully transactional filesystem, or exactly-once claim.

## Patch language

The supported strict subset uses one envelope and ordered file blocks:

```text
*** Begin Patch
*** Add File: src/new.ts
+new content
*** Update File: src/existing.ts
@@
 context
-old
+new
*** Update File: src/old.ts
*** Move to: src/new-name.ts
@@
-old
+new
*** Delete File: src/obsolete.ts
*** End Patch
```

Update blocks can contain multiple hunks, an optional `Move to` directive, or a move-only operation. Hunk matching is exact and unique: zero matches produce `PATCH_CONTEXT_MISMATCH`, more than one match produces `PATCH_CONTEXT_AMBIGUOUS`, and the engine never guesses a fuzzy insertion point. `*** End of File` requires the hunk to finish at the logical end of the file.

The parser rejects missing/extra envelope markers, empty patches, unknown or malformed directives, duplicate sources, duplicate destinations, source/destination conflicts, absolute/traversal/NUL paths, and over-budget documents. Limits are 256 KiB patch bytes, 100 file blocks, 1,000 hunks, 8 MiB per target file, and 32 MiB aggregate prepared before/after bytes. The existing Tool Dispatcher argument budget still applies to the JSON call.

## Mutation path policy

Phase 8A read semantics permit some internal symlinks after realpath containment checks. Mutation is intentionally stricter: no source, destination, or existing ancestor may be a symlink. Existing ancestors must remain inside the real workspace; absent destination parents may be created only under already validated ancestors. Add and Move destinations must be absent and are never overwritten. Update, Delete, and Move sources must be regular files.

Parent directories created by one patch are tracked and are removed in reverse order during rollback only when they are still empty. Directory cleanup never removes pre-existing directories.

## Text and byte preservation

Existing sources are read as raw bytes, rejected when binary or invalid UTF-8, and retained in the prepared change for exact rollback. Update preserves BOM presence and final-newline state. The preferred newline for inserted lines is the dominant source newline; ties use the first encountered newline style. Untouched line endings are preserved where their original line remains in the same position. New files are UTF-8, LF, and no BOM. Move-only changes retain exact source bytes.

The context matcher operates on normalized logical lines, but commit and rollback operate on raw byte arrays. Tool details contain only bounded change metadata (`kind`, workspace-relative paths, additions/deletions, and hashes); they never duplicate full source, result, or patch text.

## Failure and recovery semantics

Expected patch failures are model-recoverable Tool results with a safe code such as `PATH_OUTSIDE_WORKSPACE`, `BINARY_FILE`, `PATCH_STALE`, or `PATCH_COMMIT_FAILED_ROLLED_BACK`. The handler never exposes host paths, raw filesystem errors, source content, raw patch text, or internal IDs.

If rollback itself fails or exact baseline verification is impossible, Runtime throws `RuntimePatchUncertainError`. The Tool handler translates that runtime-owned error to the generic Tool-owned `ToolExecutionUncertainError`; Dispatcher durably records `executionDisposition: "UNCERTAIN_SIDE_EFFECT"`. Batch coordination returns the uncertain Tool result and skips all trailing calls. A durable `RUNNING` invocation recovered after process interruption remains fail-closed and is never automatically replayed.

Risk and capability fields (`HIGH`, `FS_WRITE`, `FS_DELETE`) are metadata in Phase 8B. Permission evaluation and approval enforcement remain Phase 9 responsibilities. Phase 8B does not add shell/process/Git execution, watcher events, Runtime persistence, a migration, or a final default Tool catalog.

## Architecture references and deliberate differences

The design borrows the handler/runtime separation, pure verified patch representation, Add/Update/Delete/Move model, and line-ending concerns from [Codex apply_patch](https://github.com/openai/codex/tree/main/codex-rs/apply-patch) and the precomputed BOM-aware structured changes from [OpenCode apply_patch](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/apply_patch.ts). Caelush deliberately excludes their sandbox/permission profiles, LSP/formatter/watcher side channels, remote environments, and host-specific orchestration. Caelush additionally requires all-file precommit SHA guards and verified best-effort rollback so a stale or partially failed local mutation fails closed.
