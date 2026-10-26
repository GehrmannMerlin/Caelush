import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_SCHEMA_REGISTRY,
  createEventId,
  createRunId,
  createSessionId,
} from "@caelush/protocol";

describe("Context compaction durable event V2", () => {
  it("decodes the metadata needed to explain a multi-range activation", () => {
    const event = {
      eventId: createEventId(),
      schemaVersion: 2,
      runId: createRunId(),
      sessionId: createSessionId(),
      timestamp: 1_798_000_000_000,
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1, sequence: 1 },
      type: "context.compaction.completed",
      payload: {
        checkpointId: "checkpoint_v3",
        operationId: "operation_v3",
        epochId: "epoch_v3",
        reason: "PROACTIVE_PRESSURE",
        sourceRangeCount: 3,
        sourceMessageCount: 240,
        tokensBefore: 930_000,
        tokensAfter: 44_192,
        freedTokens: 885_808,
        degraded: false,
        targetStatus: "DEEP",
      },
    };

    expect(RUN_EVENT_SCHEMA_REGISTRY.supports("context.compaction.completed", 1)).toBe(true);
    expect(RUN_EVENT_SCHEMA_REGISTRY.parse(event)).toMatchObject({
      schemaVersion: 2,
      payload: { checkpointId: "checkpoint_v3", freedTokens: 885_808 },
    });
  });
});
