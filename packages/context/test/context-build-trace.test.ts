import { describe, expect, it } from "vitest";
import { createContextBuildTrace } from "../src/context-build-trace.js";

describe("ContextBuildTrace", () => {
  it("contains safe counts but never content or raw tool payloads", () => {
    const trace = createContextBuildTrace({
      contextWindow: 16_000,
      effectiveInputLimit: 13_392,
      estimatedInputTokens: 10_000,
      systemTokens: 100,
      goalTokens: 20,
      checkpointTokens: 300,
      recentTailTokens: 1000,
      projectTokens: 200,
      fileTokens: 500,
      observationTokens: 700,
      memoryTokens: 0,
      droppedItems: 2,
      truncatedItems: 1,
      pressureRatio: 0.74,
      checkpointId: "checkpoint-1",
      compactionCount: 2,
      loadedFileCount: 1,
      observationCount: 3,
      systemPromptBody: "secret system prompt",
      rawToolArgs: "password=secret",
      rawToolOutput: "private output",
    });

    expect(JSON.stringify(trace)).not.toContain("secret");
    expect(trace.compactionCount).toBe(2);
  });
});
