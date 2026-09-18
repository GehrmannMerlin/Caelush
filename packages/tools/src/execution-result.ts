/**
 * The legacy raw Tool execution result.
 *
 * ```text
 * @caelush/tools  ──re-export──▶  @caelush/agent
 * ```
 *
 * `ToolExecutionResult` and the Tool System's `AgentToolResult<TDetails>` are one structure. The
 * legacy name is kept as an alias so existing handlers, projectors and validators keep compiling and
 * keep meaning the same thing, and no second declaration of the shape exists.
 */
export type { AgentToolExecutionResult as ToolExecutionResult } from "@caelush/agent";
