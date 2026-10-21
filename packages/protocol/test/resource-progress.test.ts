import { describe, expect, it } from "vitest";
import {
  ResourceProgressBoundarySchema,
  ResourceProgressRecordV1Schema,
} from "../src/resource-progress.js";

describe("resource progress boundary", () => {
  it("uses a closed JSON contract and keeps model-turn boundaries singular", () => {
    expect(
      ResourceProgressBoundarySchema.parse({
        kind: "MODEL_TURN",
        sourceStepId: "step-2",
        messageIds: ["message-2"],
      }),
    ).toEqual({
      kind: "MODEL_TURN",
      sourceStepId: "step-2",
      messageIds: ["message-2"],
    });
    expect(() =>
      ResourceProgressBoundarySchema.parse({
        kind: "MODEL_TURN",
        sourceStepId: "step-2",
        messageIds: ["message-2", "message-3"],
      }),
    ).toThrow();
    expect(() =>
      ResourceProgressBoundarySchema.parse({
        kind: "TOOL_RESULTS",
        sourceStepId: "step-2",
        messageIds: ["message-2", "message-2"],
      }),
    ).toThrow();
  });
});

describe("resource progress receipts", () => {
  it("accepts the canonical SHA-256 Context fingerprint", () => {
    const parsed = ResourceProgressRecordV1Schema.parse({
      version: 1,
      turns: [],
      deliveryReceipts: [
        {
          interventionId: "intervention-1",
          episodeId: "episode-1",
          consumerStepId: "step-2",
          contextArtifactId: "sha256:context-artifact",
          contextFingerprint: `sha256:${"a".repeat(64)}`,
          selectedSourceItemId: "daemon.resource-governance:correction:intervention-1",
          selectedSourceProviderId: "daemon.resource-governance-correction",
          selectedSourceProviderVersion: "resource-correction-receipt-v1",
          callId: "call-2",
          assistantMessageId: "message-2",
          createdAt: 1,
        },
      ],
    });

    expect(parsed.deliveryReceipts?.[0]?.contextFingerprint).toBe(`sha256:${"a".repeat(64)}`);
  });
});
