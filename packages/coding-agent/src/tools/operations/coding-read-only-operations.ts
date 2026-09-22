import type { JsonObject } from "@caelush/ai";
import type { ToolExecutionEnvironment } from "@caelush/agent";

import type {
  FindFilesOperations,
  ListDirectoryOperations,
  SearchTextOperations,
} from "./operations.js";

/**
 * The three read-only ports, extended with the probes three builtins need.
 *
 * ```text
 * the frozen ports      ListDirectoryOperations · FindFilesOperations · SearchTextOperations
 * the probes            readFileWithKind · listDirectoryWithKind · listWithProbe
 *                       findWithRoot · searchWithRoot
 * ```
 *
 * ## Why a separate type instead of widening the ports
 *
 * The frozen Operations contracts are minimal capability boundaries, and this round has already
 * corrected two of them once (`PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md`). Widening a port again
 * to carry a *result detail* a Tool happens to report would repeat exactly the modelling mistake the
 * errata fixed.
 *
 * These methods are different in kind from the errata's `include`/`limit`/`args`:
 *
 * ```text
 * errata inputs      change WHAT the operation does   (which files are searched, which paths Git reports)
 * these probes       only report more about WHAT HAPPENED  (the resolved root, what was at the path,
 *                                                            one entry past a window)
 * ```
 *
 * So they are declared here, as a superset consumed by the builtins that need it, and the frozen
 * interfaces stay untouched. A host that implements only the frozen ports can still satisfy
 * `DefaultCodingToolOperations` by supplying these methods, and the architecture guard asserts the
 * frozen interfaces themselves never gained a field.
 *
 * ## Why two probes report the resolved *kind*
 *
 * `read_file` answers `NOT_A_FILE` and `list_directory` answers `NOT_A_DIRECTORY`; neither is a
 * Runtime error code. The Runtime raises one `RuntimePathTypeError` for "the thing at this path is the
 * wrong kind", and a Tool may not import the Runtime's error vocabulary to tell the two apart — that
 * boundary is the whole point of the ports.
 *
 * Reporting the kind is the honest narrow answer: the operation still performs exactly one read (or
 * one listing), and the Tool retains the model-facing decision it always owned. Asking the Tool to
 * probe separately would be a second operation with a second TOCTOU window, and widening the frozen
 * port would be the mistake the errata already corrected once.
 */
export interface CodingReadOnlyOperations
  extends ListDirectoryOperations, FindFilesOperations, SearchTextOperations {
  /**
   * Read one file and report what the path resolved to.
   *
   * `kind` is the resolved entry kind, or `MISSING` when nothing resolves at that path, and `read` is
   * present exactly when the Tool may return lines for it. A `read_file` that is handed a directory
   * therefore learns the fact instead of being handed an error it is not allowed to interpret.
   */
  readFileWithKind(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly path: string;
    readonly offset: number;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly path: string;
    readonly kind: CodingToolPathKind | "MISSING";
    readonly read?: {
      readonly lines: readonly string[];
      readonly truncated: boolean;
      readonly nextOffset?: number;
      readonly bytesReturned: number;
      readonly utf8Bom: boolean;
    };
  }>;

  /**
   * List one directory and report what the path resolved to, plus **one entry past** the window.
   *
   * It carries both pieces `list_directory` needs and cannot derive: the target kind, so
   * `NOT_A_DIRECTORY` and `PATH_NOT_FOUND` stay distinguishable without a Runtime error vocabulary, and
   * the probe entry, because the Tool paginates with an `offset` the frozen port does not carry.
   * A `list({ limit: k })` that returns exactly `k` entries cannot distinguish "exactly k remain" from
   * "more than k remain"; asking for one more and applying the offset gives a true answer.
   */
  listDirectoryWithKind(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly path: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly path: string;
    readonly kind: CodingToolPathKind | "MISSING";
    readonly entries: readonly JsonObject[];
  }>;

  /**
   * List one directory and report **one entry past** the requested window.
   *
   * The probe `list_directory` used before `listDirectoryWithKind` existed, kept because the frozen
   * `ListDirectoryOperations.list` still has no `offset`: a consumer that wants pagination without the
   * kind report can ask for the prefix it may reveal plus one entry and slice the result itself.
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

/**
 * What a path resolved to, as a Tool may see it.
 *
 * Four values rather than the Runtime's own kind enum: a Tool needs to distinguish "a file", "a
 * directory", "a link" and "something else", and it must not learn the Runtime's internal taxonomy to
 * do it. `MISSING` is the fifth value a probe reports and belongs to the probe result rather than to
 * this kind, because it describes the absence of an entry rather than an entry's type.
 */
export type CodingToolPathKind = "FILE" | "DIRECTORY" | "SYMLINK" | "OTHER";
