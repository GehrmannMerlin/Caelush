import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

const phase8bModules = [
  "packages/agent/src/context/compaction/incremental-checkpoint-resolver.ts",
  "packages/agent/src/context/compaction/incremental-compaction-resolver.ts",
  "packages/agent/src/context/compaction/summary-source-serializer.ts",
  "packages/agent/src/context/compaction/checkpoint-budget.ts",
  "packages/agent/src/context/compaction/compaction-gain.ts",
] as const;

describe("Phase 8B incremental source and gain boundaries", () => {
  it("keeps all new production authority inside Agent Context compaction", async () => {
    const sources = await Promise.all(phase8bModules.map(readSource));
    for (const source of sources) {
      expect(source).not.toMatch(
        /@caelush\/storage|apps\/daemon|DatabaseSync|Runtime|ObservationRepository|ContextArtifactStorePort/i,
      );
      expect(source).not.toMatch(/rawArtifactRef|filesystem authority|raw artifact/i);
      expect(source).not.toContain("ContextCompactionCoordinator");
    }
    expect(sources[2]).toContain("canonicalJsonText");
    expect(sources[2]).not.toMatch(/ContextSummarizerPort|ProviderPort|provider SDK/i);
  });

  it("publishes Phase 8B contracts through Context and Agent public entry points", async () => {
    const contextIndex = await readSource("packages/agent/src/context/index.ts");
    const packageIndex = await readSource("packages/agent/src/index.ts");
    for (const name of [
      "createIncrementalCheckpointResolver",
      "createContextIncrementalCompactionResolver",
      "createContextSummarySourceSerializer",
      "createContextCheckpointBudgetResolver",
      "createContextCompactionGainEvaluator",
      "IncrementalCheckpointState",
      "ContextIncrementalCompactionInput",
      "CompactionSemanticSource",
      "ContextCheckpointBudget",
      "ContextCompactionGain",
    ]) {
      expect(contextIndex).toContain(name);
      expect(packageIndex).toContain(name);
    }
    expect(packageIndex).not.toMatch(
      /context\/compaction\/(?:incremental|summary-source|checkpoint-budget|compaction-gain)/,
    );
  });

  it("does not begin the explicitly deferred later-phase authorities", async () => {
    const sources = await Promise.all(phase8bModules.map(readSource));
    const combined = sources.join("\n");
    for (const forbidden of [
      "SemanticCheckpointDraft",
      "SemanticSummaryValidator",
      "ContextAuthorityFact",
      "ContextCompactionCoordinator",
      "ContextRecoveryPlanner",
      "ContextCompactionRebuilder",
      "ContextCompactionBudgetLedger",
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  });

  it("keeps AgentLoop's existing single overflow recovery path intact", async () => {
    const loop = await readSource("packages/agent/src/loop/agent-loop.ts");
    const engine = await readSource("packages/agent/src/context/engine/context-engine.ts");
    expect(loop).toContain('execution.error.code === "CONTEXT_OVERFLOW"');
    expect(loop).toContain('prepare(dependencies.contextEngine, input, "FORCED_RECOVERY")');
    expect(loop).toContain("const error =");
    expect(engine).toContain("isMeaningfulContextCompactionGain");
    expect(engine).not.toContain("ContextCompactionCoordinator");
  });
});
