import type { JsonObject } from "@caelush/ai";
import type { ToolExecutionEnvironment } from "@caelush/agent";

/**
 * Read Git status and diffs.
 *
 * ```ts
 * export interface GitOperations {
 *   status(input: {
 *     readonly environment: ToolExecutionEnvironment;
 *     readonly args: JsonObject;
 *     readonly signal: AbortSignal;
 *   }): Promise<JsonObject>;
 *
 *   diff(input: {
 *     readonly environment: ToolExecutionEnvironment;
 *     readonly args: JsonObject;
 *     readonly signal: AbortSignal;
 *   }): Promise<JsonObject>;
 * }
 * ```
 *
 * ## Why `status` takes `args`
 *
 * `diff` always took an `args` bag, and `status` originally did not. That asymmetry was a modelling
 * defect rather than a decision:
 *
 * ```text
 * git_status.path    is a real Git pathspec that decides WHICH PATHS GIT REPORTS AT ALL
 * git_status.limit   drives status parsing and truncation
 * ```
 *
 * A `status({ environment, signal })` port has no channel for either, and neither can be reconstructed
 * afterwards: a pathspec is applied by Git itself, inside the `git status` invocation, and Git pathspec
 * semantics include glob and `:(magic)` forms that no string filter reproduces. So `status` gained
 * `args`, symmetric with `diff`, exactly as `PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md` records.
 *
 * ## `args` is a validated canonical shape, not raw model input
 *
 * The port types `args` as `JsonObject` because the capability boundary is what is frozen here, not a
 * result vocabulary. The **semantic** shape is fixed and enforced by the Coding Tool, which passes
 * prepared, defaulted, validated values:
 *
 * ```text
 * status   { path?: string; limit: number }
 * diff     { scope?: "WORKTREE" | "STAGED" | "ALL"; path?: string }
 * ```
 *
 * A builtin never forwards raw provider arguments to the Runtime, and never interprets a Git pathspec
 * itself: the adapter maps `args` onto `RuntimeGitService`, which resolves, contains and sanitises the
 * path. That is what keeps Git's own path semantics — rather than an approximation of them — in charge.
 */
export interface GitOperations {
  status(input: {
    readonly environment: ToolExecutionEnvironment;

    readonly args: JsonObject;

    readonly signal: AbortSignal;
  }): Promise<JsonObject>;

  diff(input: {
    readonly environment: ToolExecutionEnvironment;

    readonly args: JsonObject;

    readonly signal: AbortSignal;
  }): Promise<JsonObject>;
}
