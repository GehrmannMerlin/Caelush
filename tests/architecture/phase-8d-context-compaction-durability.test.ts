import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));

function source(relativePath: string): string {
  return readFileSync(resolve(testDirectory, relativePath), "utf8");
}

describe("Phase 8D Context compaction durability architecture", () => {
  it("keeps candidate rebuild and durable digest ownership in Agent", () => {
    const rebuilder = source(
      "../../packages/agent/src/context/compaction/context-compaction-rebuilder.ts",
    );
    const digest = source(
      "../../packages/agent/src/context/compaction/context-compaction-digest.ts",
    );

    expect(rebuilder).not.toMatch(
      /ContextEngine\.prepare|ContextSummar|ContextCompactionCommit|@caelush\/storage|usageStore|notifyCommitted/u,
    );
    expect(digest).not.toMatch(/@caelush\/storage|DatabaseSync|SQLITE/u);
  });

  it("keeps the Engine on the shared final Coordinator path without V2 token patching", () => {
    const engine = source("../../packages/agent/src/context/engine/context-engine.ts");

    expect(engine).toContain("buildPreparedProjectionWithoutCompaction");
    expect(engine).toContain("createContextCompactionRebuilder");
    expect(engine).toContain("createContextCompactionCoordinator");
    expect(engine).toContain("createContextRecoveryPlanner");
    expect(engine).toContain("withRecoveryTailPolicy");
    expect(engine).not.toContain("updateTokensAfter");
    expect(engine).not.toMatch(/ContextCompactionAttempt|AUXILIARY_LLM/u);
  });

  it("keeps persistence and event proof in Storage and adds no attempt schema", () => {
    const repository = source("../../packages/storage/src/context-checkpoint-repository-v2.ts");
    const commitStore = source("../../packages/storage/src/context-compaction-commit-store.ts");
    const migrations = source("../../packages/storage/src/migrate.ts");

    expect(repository).toContain("StorageConflictError");
    expect(commitStore).toContain("findContextCompactionCompletionEventsInTransaction");
    expect(`${repository}\n${commitStore}\n${migrations}`).not.toMatch(
      /context_compaction_attempts|ContextCompactionAttempt/u,
    );
  });

  it("leaves the main provider overflow retry authority in AgentLoop", () => {
    const loop = source("../../packages/agent/src/loop/agent-loop.ts");

    expect(loop).toMatch(/CONTEXT_OVERFLOW|FORCED_RECOVERY/u);
  });
});
