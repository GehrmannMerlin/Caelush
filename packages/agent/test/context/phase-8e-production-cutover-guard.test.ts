import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Phase 8E production authority cutover", () => {
  it("leaves one compaction authority in the Agent production Engine", () => {
    const engine = source("packages/agent/src/context/engine/context-engine.ts");

    expect(engine).toContain("createContextCompactionCoordinator");
    expect(engine).not.toContain("summarizationRunner.summarize");
    expect(engine).not.toContain("deterministicFactsProvider.collect");
    expect(engine).not.toContain("commitCompaction(");
    expect(engine).not.toContain("compactionDigestBuilder.");
  });

  it("keeps forced observation bounds separate from Agent recovery authority", () => {
    const daemon = source("apps/daemon/src/context/v2-context-composition.ts");

    expect(daemon).toContain("forcedObservationPolicy");
    expect(daemon).not.toContain("forcedPolicy:");
    expect(daemon).not.toContain("sourceLimits:");
    expect(daemon).toContain("createBudgetedContextSummarizer");
  });
});
