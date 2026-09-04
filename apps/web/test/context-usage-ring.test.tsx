import { renderToStaticMarkup } from "react-dom/server";
import { createRunId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { ContextUsageRing } from "../src/components/context-usage-ring.js";

describe("ContextUsageRing", () => {
  it("renders a restrained accessible SVG ring using used ratio", () => {
    const markup = renderToStaticMarkup(
      <ContextUsageRing
        usage={{
          runId: createRunId(),
          providerId: "fixture",
          modelId: "small",
          contextWindowTokens: 1000,
          effectiveInputLimitTokens: 800,
          estimatedInputTokens: 400,
          usedRatio: 0.5,
          remainingTokens: 400,
          pressureState: "NORMAL",
          compactionCount: 1,
          breakdown: {
            pinned: 0,
            checkpoint: 20,
            recentTail: 100,
            project: 50,
            files: 100,
            toolObservations: 80,
            memory: 50,
          },
          updatedAt: 1,
        }}
      />,
    );
    expect(markup).toContain('aria-label="工作上下文用量：50%"');
    expect(markup).toContain('viewBox="0 0 14 14"');
    expect(markup).toContain('stroke-dashoffset="0.5"');
    expect(markup).toContain("工作上下文");
  });
});
