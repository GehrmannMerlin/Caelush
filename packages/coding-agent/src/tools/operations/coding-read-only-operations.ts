import type { JsonObject } from "@caelush/ai";
import type { ToolExecutionEnvironment } from "@caelush/agent";

import type {
  FindFilesOperations,
  ListDirectoryOperations,
  SearchTextOperations,
} from "./operations.js";

/**
 * The three read-only ports, extended with the two probes two builtins need.
 *
 * ```text
 * the frozen ports      ListDirectoryOperations · FindFilesOperations · SearchTextOperations
 * the probes            listWithProbe · findWithRoot · searchWithRoot
 * ```
 *
 * ## Why a separate type instead of widening the ports
 *
 * The frozen Operations contracts are minimal capability boundaries, and this round has already
 * corrected two of them once (`PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md`). Widening a port again
 * to carry a *result detail* a Tool happens to report would repeat exactly the modelling mistake the
 * errata fixed.
 *
 * These three methods are different in kind from the errata's `include`/`limit`/`args`:
 *
 * ```text
 * errata inputs      change WHAT the operation does   (which files are searched, which paths Git reports)
 * these probes       only report more about WHAT HAPPENED  (the resolved root, one entry past a window)
 * ```
 *
 * So they are declared here, as a superset consumed by the builtins that need it, and the frozen
 * interfaces stay untouched. A host that implements only the frozen ports can still satisfy
 * `DefaultCodingToolOperations` by supplying these three methods, and the architecture guard asserts the
 * frozen interfaces themselves never gained a field.
 */
export interface CodingReadOnlyOperations
  extends ListDirectoryOperations, FindFilesOperations, SearchTextOperations {
  /**
   * List one directory and report **one entry past** the requested window.
   *
   * `list_directory` paginates with an `offset` the frozen port does not carry, so the Tool slices the
   * listing itself. To decide `truncated` and `nextOffset` it must know whether anything follows its
   * window, and a `list({ limit: k })` that returns exactly `k` entries cannot distinguish "exactly k
   * remain" from "more than k remain". Asking for `offset - 1 + limit + 1` and applying the offset
   * gives a true answer.
   */
  listWithProbe(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly path: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly path: string; readonly entries: readonly JsonObject[] }>;

  /**
   * Find files and report the **resolved** search root alongside them.
   *
   * `find_files` reports `details.path` as the resolved workspace-relative directory, which is what the
   * legacy Tool reported. Re-deriving it from the caller's input would disagree whenever the input
   * needed normalising.
   */
  findWithRoot(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly pattern: string;
    readonly path?: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly path: string;
    readonly files: readonly string[];
    readonly truncated: boolean;
  }>;

  /**
   * Search text and report the **resolved** search root alongside the matches.
   *
   * Same reason as `findWithRoot`: `search_text` reports the directory the search actually ran against.
   */
  searchWithRoot(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly pattern: string;
    readonly path?: string;
    readonly include?: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly path: string;
    readonly matches: readonly JsonObject[];
    readonly truncated: boolean;
  }>;
}
