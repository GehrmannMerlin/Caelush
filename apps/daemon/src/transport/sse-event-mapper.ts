import type { AgentEvent } from "@caelush/protocol";

export type SseEventMessage =
  | { readonly event: string; readonly data: AgentEvent }
  | { readonly event: string; readonly data: AgentEvent; readonly id: string };

export function mapAgentEventToSse(event: AgentEvent): SseEventMessage {
  const message = { event: event.type, data: event };
  if (event.durability.kind === "DURABLE") {
    return { ...message, id: String(event.durability.sequence) };
  }
  return message;
}
