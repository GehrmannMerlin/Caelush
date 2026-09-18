/**
 * Tool execution mode.
 *
 * ```ts
 * export type ToolExecutionMode = "SEQUENTIAL" | "PARALLEL_SAFE";
 * ```
 *
 * Tool System V2 freezes this discriminant on `AgentTool` and freezes the behaviour that comes with
 * it: **the first migration wave executes every batch sequentially.** `PARALLEL_SAFE` is a declared
 * future capability, not an enabled one. Even when a Tool declares it, the scheduler keeps running
 * it in order until parallel admission, approval-in-mixed-batch, per-invocation settlement and file
 * mutation conflict strategy are frozen.
 *
 * Declaring the type now is what lets a *later* round enable concurrency without touching the Tool
 * contract; enabling it now would change execution semantics inside a structural migration.
 */
export type ToolExecutionMode = "SEQUENTIAL" | "PARALLEL_SAFE";

/** The conservative default an `AgentTool` must state explicitly. */
export const DEFAULT_TOOL_EXECUTION_MODE: ToolExecutionMode = "SEQUENTIAL";

/** Every declared execution mode, in canonical order. */
export const TOOL_EXECUTION_MODES = [
  "SEQUENTIAL",
  "PARALLEL_SAFE",
] as const satisfies readonly ToolExecutionMode[];

/** True when `value` is a declared execution mode. */
export function isToolExecutionMode(value: unknown): value is ToolExecutionMode {
  return value === "SEQUENTIAL" || value === "PARALLEL_SAFE";
}
