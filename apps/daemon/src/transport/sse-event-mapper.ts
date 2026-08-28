import type { AgentEvent } from "@caelush/protocol";

export type SseEventMessage =
  | { readonly event: string; readonly data: string }
  | { readonly event: string; readonly data: string; readonly id: string };

export function mapAgentEventToSse(event: AgentEvent): SseEventMessage {
  const message = { event: event.type, data: JSON.stringify(event) };
  if (event.durability.kind === "DURABLE") {
    return { ...message, id: String(event.durability.sequence) };
  }
  return message;
}
