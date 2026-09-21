import type { ToolName } from "@caelush/protocol";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type {
  ExecOperations,
  GitOperations,
  PatchOperations,
  ProcessOperations,
  ReadFileOperations,
} from "../operations/operations.js";
import type { CodingReadOnlyOperations } from "../operations/coding-read-only-operations.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createExecCommandTool } from "./exec-command.js";
import { createFindFilesTool } from "./find-files.js";
import { createGitDiffTool } from "./git-diff.js";
import { createGitStatusTool } from "./git-status.js";
import { createListDirectoryTool } from "./list-directory.js";
import { createReadFileTool } from "./read-file.js";
import { createSearchTextTool } from "./search-text.js";
import { createWriteStdinTool } from "./write-stdin.js";

/**
 * The default Coding Tool set.
 *
 * ```text
 * 1  read_file        2  list_directory   3  find_files     4  search_text   5  apply_patch
 * 6  exec_command     7  write_stdin       8  git_status     9  git_diff
 * ```
 *
 * ## The order is frozen
 *
 * The registry preserves registration order, and that order is what a provider sees in the tool catalog
 * and what the Context system sees in the prompt guidance block. It is therefore load-bearing for three
 * separate things:
 *
 * ```text
 * prompt-cache stability       the catalog bytes must not move between runs
 * deterministic registry       a name list is only reproducible if its order is
 * regression compatibility     the sequence models have been trained against does not change
 * ```
 *
 * `DEFAULT_CODING_TOOL_ORDER` is the single declaration of it. Nothing re-sorts, alphabetises or
 * Map-iterates this list.
 *
 * ## Facts are the only argument
 *
 * Every function here takes Operations and returns definitions. No Runtime, no registry, no store, no
 * host handle. A composition root supplies the adapters; this module supplies the product.
 */

/** The nine default Coding Tools, in their frozen order. */
export const DEFAULT_CODING_TOOL_ORDER = Object.freeze([
  "read_file",
  "list_directory",
  "find_files",
  "search_text",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "git_status",
  "git_diff",
] as const satisfies readonly ToolName[]);

/** The Operations the default nine need, one port per capability family. */
export interface DefaultCodingToolOperations {
  readonly readFile: ReadFileOperations;
  /**
   * The directory, discovery and search ports.
   *
   * Typed as `CodingReadOnlyOperations` rather than as the three frozen interfaces separately, because
   * `list_directory` needs `listWithProbe` and `find_files` / `search_text` need the resolved-root
   * variants. Those three methods are a same-package superset documented in
   * `operations/coding-read-only-operations.ts`; the frozen interfaces are untouched.
   */
  readonly readOnly: CodingReadOnlyOperations;
  readonly patch: PatchOperations;
  readonly exec: ExecOperations;
  readonly process: ProcessOperations;
  readonly git: GitOperations;
}

/**
 * Build the nine default Coding Tool definitions, in the frozen order.
 *
 * The returned array is frozen, and so is each definition and each `AgentTool` inside it: a caller that
 * kept a reference cannot reorder the catalog or mutate a schema out from under a built registry.
 */
export function createDefaultCodingTools(
  operations: DefaultCodingToolOperations,
): readonly CodingToolDefinition[] {
  return Object.freeze([
    createReadFileTool(operations.readFile),
    createListDirectoryTool(operations.readOnly),
    createFindFilesTool(operations.readOnly),
    createSearchTextTool(operations.readOnly),
    createApplyPatchTool(operations.patch),
    createExecCommandTool(operations.exec),
    createWriteStdinTool(operations.process),
    createGitStatusTool(operations.git),
    createGitDiffTool(operations.git),
  ]);
}

/** The Git Tools a host without a usable repository must not expose. */
export const GIT_TOOL_NAMES = Object.freeze(["git_status", "git_diff"] as const);

/**
 * The default nine minus the Git Tools, for a host whose Git availability is not `AVAILABLE`.
 *
 * Git exposure fails closed: `UNKNOWN` is treated exactly like `UNAVAILABLE`, because a host that cannot
 * prove Git works must not offer a model a Tool that will fail. Returning the reduced *definition* list
 * — rather than filtering a built registry — is what keeps the registry, the Coding catalog, the
 * model-visible specs and the prompt guidance block describing the same tool set.
 */
export function withoutGitTools(
  definitions: readonly CodingToolDefinition[],
): readonly CodingToolDefinition[] {
  const excluded = new Set<string>(GIT_TOOL_NAMES);
  return Object.freeze(definitions.filter((definition) => !excluded.has(definition.tool.name)));
}
