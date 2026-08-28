import type { FinishReason } from "../../tool-call.js";

export function mapFinishReason(reason: string): FinishReason {
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
