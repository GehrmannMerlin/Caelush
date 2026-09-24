import {
  ConversationMessageCommittedEventSchema,
  PublicRunEventSchema,
  RUN_EVENT_SCHEMA_REGISTRY,
  RUN_EVENT_TYPE_CATALOG,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

const event = {
  eventId: "evt_00000000-0000-7000-8000-000000000000",
  schemaVersion: 1,
  runId: "run_00000000-0000-7000-8000-000000000000",
  sessionId: "ses_00000000-0000-7000-8000-000000000000",
  timestamp: 1_700_000_000_000,
  visibility: "USER_VISIBLE" as const,
  durability: { kind: "DURABLE" as const, version: 1 as const, sequence: 1 },
  type: "conversation.message.committed" as const,
  payload: {
    messageId: "amsg_00000000-0000-7000-8000-000000000000",
    conversationTurnId: "cturn_00000000-0000-7000-8000-000000000000",
    messageType: "ASSISTANT",
  },
};

describe("conversation.message.committed protocol contract", () => {
  it("accepts the metadata-only durable payload and rejects message content/data", () => {
    expect(ConversationMessageCommittedEventSchema.safeParse(event).success).toBe(true);
    expect(
      ConversationMessageCommittedEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, content: "private conversation" },
      }).success,
    ).toBe(false);
    expect(
      ConversationMessageCommittedEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, data: { content: "private conversation" } },
      }).success,
    ).toBe(false);
  });

  it.each(["messageId", "conversationTurnId", "messageType"])(
    "rejects a payload without %s",
    (field) => {
      const payload = { ...event.payload } as Record<string, unknown>;
      delete payload[field];
      expect(ConversationMessageCommittedEventSchema.safeParse({ ...event, payload }).success).toBe(
        false,
      );
    },
  );

  it("is statically registered as a durable USER_VISIBLE event and public event", () => {
    expect(RUN_EVENT_SCHEMA_REGISTRY.supports("conversation.message.committed", 1)).toBe(true);
    expect(RUN_EVENT_TYPE_CATALOG).toContainEqual({
      type: "conversation.message.committed",
      schemaVersion: 1,
      visibility: "USER_VISIBLE",
      delivery: { kind: "DURABLE" },
    });
    expect(PublicRunEventSchema.safeParse(event).success).toBe(true);
  });
});
