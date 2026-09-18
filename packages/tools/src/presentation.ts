import type { AgentToolExecutionResult } from "@caelush/agent";

/**
 * The legacy presentation contract.
 *
 * ```text
 * @caelush/tools  ──re-export──▶  @caelush/agent
 * ```
 *
 * The port is a general boundary — it decorates durable and transient Tool events for a UI and may
 * never influence a Tool call — so its declaration belongs in the Agent Tool Layer with the result
 * contract it projects. `AgentToolExecutionResult` is the Agent root's public alias for the Tool
 * System's own `AgentToolResult<TDetails>`; the two names denote one structure, and the legacy alias
 * below denotes the same structure again so existing imports keep compiling.
 */
export type {
  ToolInvocationPresentation,
  ToolPresentationPort,
  ToolResultPresentation,
} from "@caelush/agent";

/** The legacy name for the raw Tool execution result. */
export type ToolExecutionResult = AgentToolExecutionResult;
