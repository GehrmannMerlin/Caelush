import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Phase 8F final Context Compaction architecture", () => {
  it("retires the Phase 8E summary compatibility surface", () => {
    const engine = source("packages/agent/src/context/engine/context-engine.ts");

    expect(engine).not.toContain("summarizationRunner");
    expect(engine).not.toContain("createContextSummarizerFromRunner");
    expect(
      existsSync(
        resolve(
          process.cwd(),
          "packages/agent/src/context/compaction/context-summary-compatibility.ts",
        ),
      ),
    ).toBe(false);
  });

  it("keeps one Agent-owned compaction and recovery authority", () => {
    const engine = source("packages/agent/src/context/engine/context-engine.ts");
    const coordinator = source(
      "packages/agent/src/context/compaction/context-compaction-coordinator.ts",
    );
    const recovery = source("packages/agent/src/context/compaction/context-recovery-planner.ts");
    const daemon = source("apps/daemon/src/context/v2-context-composition.ts");

    expect(engine).toContain("createContextCompactionCoordinator");
    expect(engine).toContain("createContextRecoveryPlanner");
    expect(coordinator).toContain("createContextSummarizationRunner");
    expect(coordinator).toContain("options.dependencies.commit.commit");
    expect(recovery).toContain("FORCED_ACTIONS");
    expect(daemon).not.toContain("ContextRecoveryPlanner");
    expect(daemon).not.toContain("forcedPolicy:");
    expect(daemon).not.toContain("sourceLimits:");
  });

  it("keeps raw artifact reprojection outside semantic compaction", () => {
    const semanticSources = [
      "packages/agent/src/context/compaction/context-summary.ts",
      "packages/agent/src/context/compaction/summary-source-serializer.ts",
      "packages/agent/src/context/compaction/context-compaction-coordinator.ts",
      "packages/agent/src/context/compaction/deterministic-compaction-facts.ts",
      "packages/agent/src/context/compaction/context-compaction-digest.ts",
    ].map(source);
    const engine = source("packages/agent/src/context/engine/context-engine.ts");
    const materializer = source("packages/agent/src/context/materializer/context-materializer.ts");

    expect(semanticSources.join("\n")).not.toMatch(
      /rawArtifactRef|readSafeProjection|reprojectOpenToolObservations|raw artifact/i,
    );
    expect(engine).toContain(
      'reprojectOpenToolObservations: input.contextInput.mode === "FORCED_RECOVERY"',
    );
    expect(materializer).toContain("reprojectOpenToolObservations");
  });

  it("retains the AgentLoop single forced overflow retry and no event control path", () => {
    const loop = source("packages/agent/src/loop/agent-loop.ts");
    const coordinator = source(
      "packages/agent/src/context/compaction/context-compaction-coordinator.ts",
    );

    expect(loop).toContain('execution.error.code === "CONTEXT_OVERFLOW"');
    expect(loop).toContain('prepare(dependencies.contextEngine, input, "FORCED_RECOVERY")');
    expect(coordinator).not.toMatch(
      /RunEventHub|subscribe\(|eventSubscriber|ContextCompactionAttempt/u,
    );
  });

  it("keeps the frozen Context Compaction contracts on the Agent root", () => {
    const agent = source("packages/agent/src/index.ts");
    for (const contract of [
      "ContextPressureEvaluator",
      "ContextCutPointSelector",
      "ContextCompactionPlanner",
      "IncrementalCheckpointResolver",
      "ContextIncrementalCompactionResolver",
      "ContextSummarySourceSerializer",
      "ContextSummarizerPort",
      "SemanticSummaryValidator",
      "DeterministicCompactionFactsProvider",
      "DeterministicCheckpointBuilder",
      "ContextCheckpointEnricher",
      "ContextCheckpointBudgetResolver",
      "ContextCompactionGainEvaluator",
      "ContextCompactionRebuilder",
      "ContextCheckpointRecordV2",
      "ContextCompactionCommitPort",
      "ContextCompactionCoordinator",
      "ContextRecoveryPlanner",
    ]) {
      expect(agent).toContain(contract);
    }
  });
});
