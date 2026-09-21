/**
 * The narrow Coding Operations ports.
 *
 * ```text
 * Coding builtin  →  narrow Operations port  →  Runtime Operations adapter  →  @caelush/runtime
 * ```
 *
 * ## Why these exist
 *
 * The obvious way for a Coding Tool to reach the machine is to hold a `RuntimeResolver` and open a
 * `RuntimeWorkspaceScope`. That works, and it is what the legacy builtins did, but it hands every Tool
 * the *entire* capability surface — filesystem, discovery, search, patch, exec, git — whether it needs
 * it or not. A `read_file` that can spawn a process is a Tool whose blast radius is decided by
 * convention rather than by its type.
 *
 * Each interface here is therefore the smallest set of capabilities one Tool actually needs:
 *
 * ```text
 * ReadFileOperations        read bounded text from one file
 * ListDirectoryOperations   list one directory's children
 * FindFilesOperations       discover files by glob
 * SearchTextOperations      search text across a tree
 * PatchOperations           apply one verified patch document
 * ExecOperations            start a process
 * ProcessOperations         interact with a running process
 * GitOperations             read Git status and diffs
 * ```
 *
 * ## The boundary rules these types encode
 *
 * ```text
 * every Operation receives ToolExecutionEnvironment and a REQUIRED AbortSignal
 * every Operation returns a Tool business result, never a Runtime object
 * no Operation input may carry a RuntimeResolver, a RuntimeWorkspaceScope, a store or an absolute path
 * ```
 *
 * A Tool therefore receives a *locator* (`ToolExecutionEnvironment` — workspace plus runtime id) and a
 * narrow port, and it can neither resolve a runtime nor enumerate capabilities it was not given. The
 * concretely resolved `RuntimeWorkspaceScope` exists only inside `operations/runtime-adapters/`, which
 * is the one place allowed to import the broad Runtime types.
 *
 * ## These are the frozen shapes
 *
 * One correction has been applied to this set since the Interface Freeze, recorded in
 * `docs/architecture/v2/PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md`: `SearchTextOperations` gained
 * `include` and `limit`, and `GitOperations.status` gained `args`. Both were proven necessary against
 * production source; nothing else here changed.
 */

export type { ReadFileOperations } from "./read-file-operations.js";
export type { ListDirectoryOperations } from "./list-directory-operations.js";
export type { FindFilesOperations } from "./find-files-operations.js";
export type { SearchTextOperations } from "./search-text-operations.js";
export type { PatchOperations } from "./patch-operations.js";
export type { ExecOperations } from "./exec-operations.js";
export type { ProcessOperations } from "./process-operations.js";
export type { GitOperations } from "./git-operations.js";

/**
 * Every Operations interface name, in canonical order.
 *
 * Used by the architecture guard to assert the frozen set is declared here and nowhere else.
 */
export const OPERATIONS_INTERFACE_NAMES = [
  "ReadFileOperations",
  "ListDirectoryOperations",
  "FindFilesOperations",
  "SearchTextOperations",
  "PatchOperations",
  "ExecOperations",
  "ProcessOperations",
  "GitOperations",
] as const;
