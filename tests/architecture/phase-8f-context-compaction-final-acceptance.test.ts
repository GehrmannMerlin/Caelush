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
    expect(existsSync(resolve(process.cwd(), "packages/agent/src/context/compaction/context-summary-compatibility.ts"))).toBe(false);
  });
});
