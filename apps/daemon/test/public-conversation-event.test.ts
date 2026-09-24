import { RunEventSchema } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { DefaultPublicEventProjector } from "../src/events/public-event-projector.js";

const event = RunEventSchema.parse({
  eventId: "evt_00000000-0000-7000-8000-000000000001",
  schemaVersion: 1,
  runId: "run_00000000-0000-7000-8000-000000000001",
  sessionId: "ses_00000000-0000-7000-8000-000000000001",
  timestamp: 1_700_000_000_000,
  visibility: "USER_VISIBLE",
  durability: { kind: "DURABLE", version: 1, sequence: 1 },
  type: "conversation.message.committed",
  payload: {
    messageId: "amsg_00000000-0000-7000-8000-000000000000",
    conversationTurnId: "cturn_00000000-0000-7000-8000-000000000000",
    messageType: "ASSISTANT",
  },
});

describe("conversation message public projection", () => {
  it("projects only identifiers and message type", () => {
    const projected = new DefaultPublicEventProjector().project(event);

    expect(projected?.payload).toEqual(event.payload);
    expect(projected).not.toBeNull();
    expect(JSON.stringify(projected)).not.toContain("content");
    expect(JSON.stringify(projected)).not.toContain("data");
  });
});
