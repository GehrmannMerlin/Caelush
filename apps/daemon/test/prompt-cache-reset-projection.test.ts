import { PromptCacheUsageSchema, createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";

import { projectPromptCacheUsage } from "../src/daemon-composition.js";
import {
  isInternalPromptCacheResetReason,
  toPublicPromptCacheResetReason,
} from "../src/context/prompt-cache-reset-projection.js";

const STEP = 129;
const RESET_AT = createTimestampMs(1_700_000_000_000);

describe("prompt-cache reset reason projection", () => {
  it("keeps the internal capacity-rollover reason out of the public enum", () => {
    expect(toPublicPromptCacheResetReason("CAPACITY_ROLLOVER")).toBeUndefined();
    expect(toPublicPromptCacheResetReason("MODEL_CHANGED")).toBe("MODEL_CHANGED");
    expect(toPublicPromptCacheResetReason(undefined)).toBeUndefined();
    expect(isInternalPromptCacheResetReason("CAPACITY_ROLLOVER")).toBe(true);
    expect(isInternalPromptCacheResetReason("NOT_A_REASON")).toBe(false);
  });

  it("still reports a cache reset for a capacity rollover, without an unknown reason", () => {
    const projection = projectPromptCacheUsage(
      {
        updatedAt: createTimestampMs(Number(RESET_AT) + 1),
        promptSurface: {
          epochId: "rollover-epoch",
          prefixFingerprint: "sha256:".concat("1".repeat(64)),
          stableHeadTokens: 10,
          snapshotTokens: 20,
          expectedReusablePrefixTokens: 30,
          resetReason: "INITIAL",
        },
      },
      [],
      {
        epochId: "rollover-epoch",
        resetReason: "CAPACITY_ROLLOVER",
        createdStepSequence: STEP,
        createdAt: RESET_AT,
      },
    );

    expect(projection.status).toBe("RESET");
    expect(projection.epochId).toBe("rollover-epoch");
    // The value must not appear on the wire at all: the enum is closed and strict.
    expect(projection.resetReason).toBeUndefined();
    expect(projection.resetStepSequence).toBeUndefined();
    expect(projection.resetAt).toBeUndefined();
    expect(JSON.stringify(projection)).not.toContain("CAPACITY_ROLLOVER");
    expect(() => PromptCacheUsageSchema.parse(projection)).not.toThrow();
  });

  it("keeps the known public reasons unchanged", () => {
    const projection = projectPromptCacheUsage(
      {
        updatedAt: createTimestampMs(Number(RESET_AT) + 1),
        promptSurface: {
          epochId: "model-change-epoch",
          prefixFingerprint: "sha256:".concat("2".repeat(64)),
          stableHeadTokens: 10,
          snapshotTokens: 20,
          expectedReusablePrefixTokens: 30,
          resetReason: "MODEL_CHANGED",
        },
      },
      [],
      {
        epochId: "model-change-epoch",
        resetReason: "MODEL_CHANGED",
        createdStepSequence: 4,
        createdAt: RESET_AT,
      },
    );

    expect(projection.resetReason).toBe("MODEL_CHANGED");
    expect(projection.resetStepSequence).toBe(4);
    expect(projection.resetAt).toBe(RESET_AT);
    expect(() => PromptCacheUsageSchema.parse(projection)).not.toThrow();
  });
});
