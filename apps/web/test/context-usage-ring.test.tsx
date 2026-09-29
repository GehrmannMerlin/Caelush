import { renderToStaticMarkup } from "react-dom/server";
import { createRunId } from "@caelush/protocol";
import type { ContextUsageProjection } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { ContextUsageRing } from "../src/components/context-usage-ring.js";
import { ContextInspector } from "../src/components/context-inspector.js";

const baseUsage: ContextUsageProjection = {
  runId: createRunId(),
  providerId: "fixture",
  modelId: "small",
  contextWindowTokens: 1000,
  rawContextWindowTokens: 1200,
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
    systemTokens: 60,
    goalTokens: 12,
    currentUserTokens: 20,
    relevantFileTokens: 100,
    currentTurnTokens: 180,
    mandatoryTokens: 200,
  },
  lastBuildAt: 2,
  lastRecoveryStages: ["REBUILD_CONTEXT"],
  updatedAt: 1,
};

describe("ContextUsageRing", () => {
  it("renders a restrained accessible SVG ring using used ratio", () => {
    const markup = renderToStaticMarkup(<ContextUsageRing usage={baseUsage} />);
    const inspectorMarkup = renderToStaticMarkup(<ContextInspector usage={baseUsage} />);
    expect(markup).toContain('aria-label="工作上下文用量：50%"');
    expect(markup).toContain('viewBox="0 0 18 18"');
    expect(markup).toContain('stroke-dashoffset="0.5"');
    expect(markup).toContain("工作上下文");
    expect(inspectorMarkup).toContain("Raw Context Window");
    expect(inspectorMarkup).toContain("1,200 tokens");
    expect(inspectorMarkup).toContain("Current Turn");
    expect(inspectorMarkup).toContain("180 tokens");
  });

  it("clamps invalid ratios to the visible 0%–100% ring range", () => {
    const overfull = renderToStaticMarkup(
      <ContextUsageRing usage={{ ...baseUsage, usedRatio: 1.4 }} />,
    );
    const negative = renderToStaticMarkup(
      <ContextUsageRing usage={{ ...baseUsage, usedRatio: -0.2 }} />,
    );
    expect(overfull).toContain('stroke-dashoffset="0"');
    expect(negative).toContain('stroke-dashoffset="1"');
  });
});
