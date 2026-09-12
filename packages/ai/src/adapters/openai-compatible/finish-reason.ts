import type { AIFinishReason } from "../../tools/tool-call.js";

/**
 * Map a native OpenAI-compatible finish reason onto the frozen AI finish reason.
 *
 * The mapping is total and lossless in the direction that matters: an
 * unrecognised provider reason becomes `OTHER` and never `STOP`, because claiming
 * a normal stop for an unknown reason would let a truncated or filtered turn read
 * as a finished answer.
 *
 * The native reason is preserved separately as `providerReason` on
 * `adapter.finish`, so `OTHER` never loses the information that produced it.
 */
export function mapOpenAICompatibleFinishReason(reason: string): AIFinishReason {
  switch (reason) {
    case "stop":
      return "STOP";
    case "length":
      return "LENGTH";
    case "tool-calls":
      return "TOOL_CALLS";
    case "content-filter":
      return "CONTENT_FILTER";
    default:
      return "OTHER";
  }
}
