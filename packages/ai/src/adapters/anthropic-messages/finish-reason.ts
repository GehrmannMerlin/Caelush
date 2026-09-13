import type { AIFinishReason } from "../../tools/tool-call.js";

/**
 * Map a native Anthropic stop reason onto the frozen AI finish reason.
 *
 * Two properties matter and both are asserted by golden tests:
 *
 * ```text
 * `pause_turn` is NOT a stop. It means the provider paused a long-running turn and
 * expects the caller to continue, so it becomes `OTHER` with the native reason
 * preserved as `providerReason` — never `STOP`.
 *
 * every unrecognised reason becomes `OTHER`, never `STOP`, because reporting a
 * normal stop for an unknown reason would let a truncated or refused turn read as
 * a finished answer.
 * ```
 */
export function mapAnthropicFinishReason(reason: string): AIFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "STOP";
    case "tool_use":
      return "TOOL_CALLS";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "LENGTH";
    case "refusal":
      return "CONTENT_FILTER";
    default:
      return "OTHER";
  }
}

/**
 * Whether the native reason must be preserved on `adapter.finish`.
 *
 * The frozen contract keeps `providerReason` optional, and an unmapped reason is
 * exactly the case where losing it would make a downstream diagnosis impossible.
 */
export function shouldReportProviderReason(reason: string): boolean {
  return reason.length > 0 && mapAnthropicFinishReason(reason) === "OTHER";
}
