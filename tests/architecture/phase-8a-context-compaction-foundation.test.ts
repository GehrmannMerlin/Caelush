import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("Phase 8A Context Compaction pressure and safe-cut boundaries", () => {
  it("keeps pressure and cut ownership inside Agent Context compaction", async () => {
    const evaluatorPath = "packages/agent/src/context/compaction/context-pressure-evaluator.ts";
    const cutPath = "packages/agent/src/context/compaction/context-compaction-cut.ts";
    const selectorPath = "packages/agent/src/context/compaction/context-cut-point-selector.ts";
    const [evaluator, cut, selector] = await Promise.all([
      readSource(evaluatorPath),
      readSource(cutPath),
      readSource(selectorPath),
    ]);

    expect(evaluator).toContain("export function createContextPressureEvaluator");
    expect(cut).toContain("export type ContextCompactionCutKind");
    expect(selector).toContain("export function createContextCutPointSelector");
    for (const source of [evaluator, cut, selector]) {
      expect(source).not.toMatch(
        /@caelush\/storage|apps\/daemon|DatabaseSync|ContextArtifactStore/,
      );
      expect(source).not.toMatch(/ObservationRepository|rawArtifact|raw artifact/i);
      expect(source).not.toContain("ContextCompactionCoordinator");
    }
  });

  it("publishes the new contracts only through Agent public entry points", async () => {
    const contextIndex = await readSource("packages/agent/src/context/index.ts");
    const packageIndex = await readSource("packages/agent/src/index.ts");

    for (const source of [contextIndex, packageIndex]) {
      expect(source).toContain("createContextPressureEvaluator");
      expect(source).toContain("createContextCutPointSelector");
      expect(source).toContain("ContextCompactionCut");
      expect(source).toContain("ContextCutPointSelector");
    }
    expect(packageIndex).not.toContain("context/compaction/context-pressure-evaluator.js");
    expect(packageIndex).not.toContain("context/compaction/context-cut-point-selector.js");
  });

  it("keeps pressure independent from the tail target and overflow recovery in AgentLoop", async () => {
    const engine = await readSource("packages/agent/src/context/engine/context-engine.ts");
    const loop = await readSource("packages/agent/src/loop/agent-loop.ts");

    expect(engine).toContain("pressureEvaluator.evaluate");
    expect(engine).not.toContain(
      "activeCoverage.history.estimatedTokens > policy.targetRecentTailTokens",
    );
    expect(engine).toContain("stored.message.runId === range.runId");
    expect(engine).toContain("stored.sequence >= range.firstSequence");
    expect(loop).toContain('execution.error.code === "CONTEXT_OVERFLOW"');
    expect(loop).toContain('prepare(dependencies.contextEngine, input, "FORCED_RECOVERY")');
    expect(loop).toContain("const error =");
  });
});
