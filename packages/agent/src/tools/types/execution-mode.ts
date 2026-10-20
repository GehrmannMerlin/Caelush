/**
 * Tool execution mode.
 *
 * ```ts
 * export type ToolExecutionMode = "SEQUENTIAL" | "PARALLEL_SAFE";
 * ```
 *
 * `PARALLEL_SAFE` declares that a Tool reads without mutating shared workspace state. It is only a
 * scheduling capability: the host must opt into bounded parallel windows, the approval path must be
 * known not to pause on an approval, and the batch must contain consecutive Tools with this mode.
 * Otherwise the canonical batch coordinator keeps the calls sequential.
 *
 * The durable invocation lifecycle and result order remain unchanged when a host enables those
 * windows.
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
