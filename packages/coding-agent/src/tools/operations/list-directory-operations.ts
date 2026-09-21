import type { JsonObject } from "@caelush/ai";
import type { ToolExecutionEnvironment } from "@caelush/agent";

/**
 * List one workspace directory's children.
 *
 * ```ts
 * export interface ListDirectoryOperations {
 *   list(input: {
 *     readonly environment: ToolExecutionEnvironment;
 *     readonly path: string;
 *     readonly limit: number;
 *     readonly signal: AbortSignal;
 *   }): Promise<{
 *     readonly path: string;
 *     readonly entries: readonly JsonObject[];
 *     readonly truncated: boolean;
 *   }>;
 * }
 * ```
 *
 * ## Why there is no `offset`
 *
 * The frozen shape has no pagination offset, and the `list_directory` Tool does. That is deliberate and
 * it is not a gap: a directory listing is a *bounded, ordered, cheaply re-derivable* set, so the Tool
 * requests `offset - 1 + limit` entries through this port and slices them itself. The visible entries,
 * their order, the `nextOffset` the Tool reports, the bounds and the truncation flag are all functions
 * of the same sorted list, so the Tool-side slice is exactly equivalent to asking the Runtime for the
 * window directly.
 *
 * Adding `offset` here would widen the port for every consumer in order to save one Tool a `slice`, and
 * the freeze exists to stop exactly that kind of accretion.
 *
 * `entries` are JSON-safe objects describing each child — name, workspace-relative path and kind —
 * never host paths and never file contents. `truncated` reports that the directory holds more children
 * than `limit`.
 */
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
