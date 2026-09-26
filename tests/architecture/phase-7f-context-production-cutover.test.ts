import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

describe("Phase 7F production Context cutover", () => {
  it("routes daemon Agent turns through the V2 Context Engine", () => {
    const composition = read("apps/daemon/src/daemon-composition.ts");
    const v2 = read("apps/daemon/src/context/v2-context-composition.ts");
    const engine = read("packages/agent/src/context/engine/context-engine.ts");
    const sourceDefinitions =
      read("packages/agent/src/context/source/source-ids.ts") +
      read("packages/coding-agent/src/context/source-ids.ts");
    expect(composition).toContain("createDaemonV2ContextEngine");
    expect(composition).not.toContain("createLegacyContextRuntimeAdapter");
    expect(composition).not.toContain("createDefaultContextBuilder");
    expect(composition).not.toContain("createLocalRelevantFilePlanner");
    expect(composition).not.toContain("historyPrefix");
    expect(v2).toContain("createV2ContextEngine");
    expect(v2).toContain("contextCompactionCommit");
    expect(engine).toContain("notifyCommitted");
    for (const sourceId of [
      "agent.conversation",
      "agent.checkpoint",
      "agent.core-policy",
      "agent.memory",
      "agent.extension-contributions",
      "agent.branch-context",
      "coding.workspace",
      "coding.runtime-facts",
      "coding.project-instructions",
      "coding.project-metadata",
      "coding.relevant-files",
      "coding.skill-catalog",
      "coding.git-state",
      "coding.verification-repair",
      "coding.temporal",
    ]) {
      expect(sourceDefinitions).toContain(sourceId);
    }
  });

  it("keeps Agent Context generic and Coding Context runtime-backed", () => {
    const agentContext = read("packages/agent/src/context/engine/context-engine.ts");
    const codingPorts = read("packages/coding-agent/src/context/local-ports.ts");
    for (const forbidden of [
      "@caelush/runtime",
      "@caelush/storage",
      "@caelush/context",
      "@caelush/coding-agent",
      "node:fs",
      "node:child_process",
      "sqlite",
    ]) {
      expect(agentContext).not.toContain(forbidden);
    }
    expect(codingPorts).toContain("openWorkspace");
    expect(codingPorts).toContain("readTextFile");
    expect(codingPorts).toContain("resolveExisting");
    expect(codingPorts).toContain("realpath");
  });

  it("registers one metadata-only durable compaction fact in Protocol", () => {
    const schema = read("packages/protocol/src/events/context.ts");
    const catalog = read("packages/protocol/src/events/catalog.ts");
    const registry = read("packages/protocol/src/events/registry.ts");
    expect(schema).toContain("context.compaction.completed");
    expect(schema).toContain("checkpointId");
    expect(schema).toContain("sourceSequenceFrom");
    expect(catalog).toContain('durable("context.compaction.completed", "SYSTEM")');
    expect(registry).toContain("context.compaction.completed\\u00001");
  });
});
