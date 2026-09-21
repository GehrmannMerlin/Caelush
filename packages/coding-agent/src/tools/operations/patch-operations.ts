import type { JsonObject } from "@caelush/ai";
import type { ToolExecutionEnvironment } from "@caelush/agent";

/**
 * Apply one verified patch document.
 *
 * ```ts
 * export interface PatchOperations {
 *   apply(input: {
 *     readonly environment: ToolExecutionEnvironment;
 *     readonly patch: string;
 *     readonly signal: AbortSignal;
 *   }): Promise<{ readonly changeCount: number; readonly changes: readonly JsonObject[] }>;
 * }
 * ```
 *
 * The whole patch document goes in; a count and a per-change summary come out. The parsing, planning,
 * guard-all, sequential commit and verification pipeline belongs entirely to the Runtime, and the Tool
 * contributes nothing to it but the text.
 *
 * ## Uncertainty is not flattened here
 *
 * A patch is the one Coding operation whose side effect can be *unprovable*: the commit may have
 * partially applied, or the rollback may itself have failed. The Runtime signals that with a dedicated
 * uncertain error, and the adapter must let it through **unchanged** — never as a returned failure and
 * never as an ordinary exception. The Coding Tool boundary is what maps that error onto the canonical
 * uncertain-side-effect vocabulary, which is what stops the batch from continuing into dependent calls
 * and stops any later attempt from blindly retrying the patch.
 *
 * A `changes` entry describes one file operation — kind, workspace-relative path, addition and
 * deletion counts and content hashes — and never carries file bodies.
 */
export interface PatchOperations {
  apply(input: {
    readonly environment: ToolExecutionEnvironment;

    readonly patch: string;

    readonly signal: AbortSignal;
  }): Promise<{
    readonly changeCount: number;

    readonly changes: readonly JsonObject[];
  }>;
}
