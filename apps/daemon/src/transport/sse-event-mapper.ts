import type { PublicRunEvent } from "@caelush/protocol";

export interface SseRunEventMessage {
  readonly event: string;
  readonly data: PublicRunEvent;
  readonly id?: string;
}

export function mapPublicRunEventToSse(event: PublicRunEvent): SseRunEventMessage {
  const message = { event: event.type, data: event };
  if (event.durability.kind === "DURABLE") {
    return { ...message, id: String(event.durability.sequence) };
  }
  return message;
}
