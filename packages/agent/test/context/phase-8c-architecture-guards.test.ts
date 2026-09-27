import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));

function source(relativePath: string): string {
  return readFileSync(resolve(testDirectory, relativePath), "utf8");
}

describe("Phase 8C architecture guards", () => {
  it("keeps Agent semantic contracts authority-neutral", () => {
    const semanticDraft = source("../../src/context/compaction/semantic-checkpoint-draft.ts");
    const validator = source("../../src/context/compaction/semantic-summary-validator.ts");

    expect(`${semanticDraft}\n${validator}`).not.toMatch(
      /ContextAuthoritySnapshot|ContextAuthorityProviderPort|@caelush\/storage|AgentLoop/u,
    );
  });

  it("keeps the Daemon semantic adapter on the direct gateway boundary", () => {
    const adapter = source("../../../../apps/daemon/src/context/ai-context-summarizer-adapter.ts");

    expect(adapter).not.toMatch(
      /AgentLoop|ToolBatchCoordinator|MemoryRetriever|rawArtifactRef|@caelush\/storage/u,
    );
    expect(adapter).toContain("tools: []");
    expect(adapter).toContain("gateway.complete");
  });

  it("keeps Coding facts projection away from raw Tool payloads and Storage", () => {
    const projector = source(
      "../../../../packages/coding-agent/src/context/compaction/coding-compaction-facts.ts",
    );

    expect(projector).not.toMatch(
      /@caelush\/storage|rawArtifactRef|observation\.content|invocation\.args/u,
    );
  });
});
