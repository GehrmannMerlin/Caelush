/**
 * `@caelush/coding-agent/tools/operations` — the narrow Operations ports and their Runtime adapters.
 *
 * ```text
 * Coding builtin  →  narrow Operations port  →  Runtime Operations adapter  →  @caelush/runtime
 * ```
 *
 * The ports are imported by every Coding builtin; the adapters are imported by the composition root. A
 * builtin never sees a `RuntimeResolver`, a `RuntimeWorkspaceScope` or any other broad Runtime type —
 * only a `ToolExecutionEnvironment` locator and the one capability interface it declared.
 */

export { OPERATIONS_INTERFACE_NAMES } from "./operations.js";
export type {
  ExecOperations,
  FindFilesOperations,
  GitOperations,
  ListDirectoryOperations,
  PatchOperations,
  ProcessOperations,
  ReadFileOperations,
  SearchTextOperations,
} from "./operations.js";

export {
  createRuntimeGitOperations,
  createRuntimePatchOperations,
  createRuntimeProcessOperations,
  createRuntimeReadOnlyOperations,
  READ_FILE_MAX_BYTES,
  resolveRuntimeWorkspace,
} from "./runtime-adapters/index.js";
export type {
  RuntimeOperationsAll,
  RuntimeOperationsProcess,
  RuntimeOperationsReadOnly,
} from "./runtime-adapters/index.js";
