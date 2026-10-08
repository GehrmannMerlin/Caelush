import { PromptCacheUsageSchema, createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  projectPromptCacheUsage,
  promptCacheSamplesFromDurableMessages,
} from "../src/daemon-composition.js";

const SENTINEL = "C4_PRIVATE_REPLAY_SENTINEL";

describe("cache metrics privacy boundary", () => {
  it("projects only numeric Provider Usage from durable Assistant records", () => {
    const samples = promptCacheSamplesFromDurableMessages([
      {
        messageType: "ASSISTANT",
        createdAt: createTimestampMs(1_700_000_000_000),
        data: {
          model: {
            kind: "MODEL_TURN",
            callId: "call_c4_private_metrics_fixture",
            usage: {
              inputTokens: 100,
              outputTokens: 10,
              cachedInputTokens: 80,
              cacheMissInputTokens: 20,
              reasoningTokens: 4,
            },
            providerState: {
              reference: "opaque-reference-only",
              payload: { reasoningContent: SENTINEL, rawToolArguments: SENTINEL },
            },
            privateReplay: { reasoningContent: SENTINEL, rawToolArguments: SENTINEL },
          },
        },
      } as never,
    ]);
    const projection = projectPromptCacheUsage(
      { updatedAt: createTimestampMs(1_700_000_000_001) },
      samples,
    );
    const safeProjection = PromptCacheUsageSchema.parse(projection);

    expect(safeProjection.metricsV2?.fullRun.mainAgent.hitRate).toBe(0.8);
    expect(JSON.stringify(safeProjection)).not.toContain(SENTINEL);
  });
});
