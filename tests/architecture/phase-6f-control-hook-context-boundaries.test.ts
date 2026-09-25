import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relativePath: string): string => readFileSync(join(root, relativePath), "utf8");

describe("Phase 6F Control Hook and Context boundaries", () => {
  it("keeps the generic Hook core independent of Context, Storage, Runtime, and provider messages", () => {
    for (const relativePath of [
      "packages/agent/src/hooks/control-hook.ts",
      "packages/agent/src/hooks/control-hook-runner.ts",
      "packages/agent/src/hooks/context-contribution.ts",
    ]) {
      const source = read(relativePath);
      expect(source, relativePath).not.toMatch(/@caelush\/(context|storage|runtime|security|core)/);
      expect(source, relativePath).not.toMatch(
        /\b(?:AIMessage|AISystemMessage|AIToolSpec|Provider|DatabaseSync)\b/,
      );
    }
  });

  it("places the named adapter and artifact port in Core, with composition in Daemon", () => {
    const adapter = read("packages/core/src/legacy-context-runtime-adapter.ts");
    expect(adapter).toContain("ContextContributionPipeline");
    expect(adapter).toContain("ContextArtifactRepository");
    expect(adapter).toContain("projectContextContributions");
    expect(adapter).toContain("CONTEXT_CONTRIBUTION_SNAPSHOT");
    expect(adapter).not.toContain("ModelTurnExecutor");

    const daemon = read("apps/daemon/src/daemon-composition.ts");
    expect(daemon).toContain("createContextContributionPipeline");
    expect(daemon).toContain("options.storage.contextArtifacts");
    expect(daemon).toContain("contextContributionHooks");
  });

  it("does not create a second conversation or provider request authority", () => {
    const adapter = read("packages/core/src/legacy-context-runtime-adapter.ts");
    expect(adapter).not.toMatch(/messagesToAppend|AgentMessageRecord|AIMessage\s*\(/);
    expect(adapter).not.toContain("provider.stream");
    expect(adapter).not.toContain("gateway");
  });
});
