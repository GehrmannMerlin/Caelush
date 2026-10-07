import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const ORDERING_SOURCES = [
  "../../src/context/history/semantic-history-unit.ts",
  "../../src/context/planner/context-planner.ts",
  "../../src/context/materializer/context-materializer.ts",
  "../../src/context/engine/context-engine.ts",
  "../../src/context/surface/prompt-surface-anchors.ts",
  "../../src/context/compaction/context-cut-point-selector.ts",
  "../../src/context/compaction/context-compaction-planner.ts",
  "../../src/context/compaction/context-compaction-coverage.ts",
] as const;

describe("multi-turn identity architecture guard", () => {
  it("keeps Prompt Surface anchors scoped and rejects bare Session sequence identities", async () => {
    const sources = await Promise.all(
      ORDERING_SOURCES.map((source) => readFile(new URL(source, import.meta.url), "utf8")),
    );
    const combined = sources.join("\n");

    expect(combined).not.toContain("anchorMessageSequence");
    expect(combined).not.toMatch(/Set\s*<\s*number\s*>/);
    expect(combined).not.toMatch(
      /\.sort\s*\(\s*\(\s*left\s*,\s*right\s*\)\s*=>\s*left\.sequence\s*-\s*right\.sequence/,
    );

    const planner = sources[1]!;
    expect(planner).toMatch(
      /leftHistory\.scope === rightHistory\.scope[\s\S]{0,160}leftHistory\.sequence - rightHistory\.sequence/,
    );
  });
});
