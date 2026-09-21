import type { JsonObject } from "@caelush/ai";
import type { ToolExecutionEnvironment } from "@caelush/agent";

/**
 * Search text across a workspace tree.
 *
 * ```ts
 * export interface SearchTextOperations {
 *   search(input: {
 *     readonly environment: ToolExecutionEnvironment;
 *     readonly pattern: string;
 *     readonly path?: string;
 *     readonly include?: string;
 *     readonly limit: number;
 *     readonly signal: AbortSignal;
 *   }): Promise<{ readonly matches: readonly JsonObject[]; readonly truncated: boolean }>;
 * }
 * ```
 *
 * ## `include` and `limit` are operation semantic inputs
 *
 * This interface carries `include` and `limit`, and
 * `docs/architecture/v2/PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md` records why the original
 * freeze had to be corrected to add them.
 *
 * ```text
 * include   a ripgrep-compatible glob applied by the Runtime search implementation
 *           BEFORE any truncation. It decides which files are searched at all.
 * limit     the maximum number of MATCHES THE TOOL WANTS TO SHOW.
 * ```
 *
 * Neither can be handled after the fact. `include` is a path-level pre-filter — applying it to an
 * already-truncated match list silently changes which matches exist, because the truncation happened
 * against a different file set. And a port that could not carry `limit` would force the Tool to accept
 * whatever ceiling the port chose, which is a behaviour change rather than an implementation detail.
 *
 * ## `limit` is a business bound, not a capture bound
 *
 * The number here is what the **Tool** intends to display. The Runtime's own `limit` is a *capture*
 * bound, and the adapter deliberately asks the Runtime for `limit + 1` so that "there were more
 * matches" is provable from the returned set rather than guessed. That `N + 1` probe predates this
 * interface and is preserved by it: the adapter keeps the existing capture strategy and reports
 * `truncated` from the real match count.
 *
 * ## What the Tool never sees
 *
 * `matches` are JSON-safe objects naming a workspace-relative path, a line number and bounded text.
 * The adapter rejects any match whose path escapes the search root before it returns, so a misbehaving
 * search backend cannot turn into a host-path disclosure.
 */
export interface SearchTextOperations {
  search(input: {
    readonly environment: ToolExecutionEnvironment;

    readonly pattern: string;

    readonly path?: string;

    readonly include?: string;

    readonly limit: number;

    readonly signal: AbortSignal;
  }): Promise<{
    readonly matches: readonly JsonObject[];

    readonly truncated: boolean;
  }>;
}
