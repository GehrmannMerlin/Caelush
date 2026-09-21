import type {
  ExecOperations,
  FindFilesOperations,
  GitOperations,
  ListDirectoryOperations,
  PatchOperations,
  ProcessOperations,
  ReadFileOperations,
  SearchTextOperations,
} from "../operations.js";

/**
 * The Runtime Operations adapters.
 *
 * ```text
 * RuntimeResolver  →  one adapter per capability family  →  the eight narrow Operations ports
 *
 *   read-only family   ReadFileOperations · ListDirectoryOperations · FindFilesOperations
 *                      · SearchTextOperations
 *   patch family       PatchOperations
 *   process family     ExecOperations · ProcessOperations
 *   git family         GitOperations
 * ```
 *
 * ## This is the only directory allowed to know the Runtime
 *
 * `RuntimeResolver`, `Runtime`, `RuntimeWorkspaceScope`, `RuntimeFileSystem`, `RuntimeGitService` and
 * `RuntimeExecService` may be imported **here and nowhere else** in `@caelush/coding-agent`. A Coding
 * builtin imports a narrow port and a locator; it cannot resolve a runtime, open a workspace, or reach a
 * capability it was not handed. The architecture guard enforces the boundary structurally, so the
 * discipline does not depend on review.
 *
 * ## Why the factory is per Tool, not a bundle
 *
 * Each builtin factory takes the one port it needs. A bundle handed to every Tool would make the narrow
 * interfaces decorative, because the object a Tool actually held would carry all eight. Passing
 * `ReadFileOperations` to `createReadFileTool` means a `read_file` implementation that tried to call
 * `execute()` would not compile.
 */

export { createRuntimeGitOperations } from "./runtime-git-operations.js";
export { createRuntimePatchOperations } from "./runtime-patch-operations.js";
export { createRuntimeProcessOperations } from "./runtime-process-operations.js";
export {
  createRuntimeReadOnlyOperations,
  READ_FILE_MAX_BYTES,
} from "./runtime-read-only-operations.js";
export { resolveRuntimeWorkspace } from "./resolve-runtime-workspace.js";
export type { RuntimeReadOnlyOperations } from "./runtime-read-only-operations.js";

/** The read-only family, named so a consumer can type the shared adapter's return. */
export interface RuntimeOperationsReadOnly
  extends ReadFileOperations, ListDirectoryOperations, FindFilesOperations, SearchTextOperations {}

/** The process family, named for the same reason. */
export interface RuntimeOperationsProcess extends ExecOperations, ProcessOperations {}

/** Every Operations port the Runtime layer can satisfy, for a composition root that wants one object. */
export interface RuntimeOperationsAll
  extends RuntimeOperationsReadOnly, RuntimeOperationsProcess, PatchOperations, GitOperations {}
