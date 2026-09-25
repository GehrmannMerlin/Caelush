import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import {
  createContextDocumentBuilder,
  createContextItem,
  createContextItemId,
  createContextPlanner,
  createContextPolicy,
  createContextSourceId,
  type ContextSectionAuthority,
} from "@caelush/agent";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-7c-authority" },
  api: "test-api",
  limits: { contextWindowTokens: 100, maxOutputTokens: 10 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

function buildDocumentForItemType(type: string) {
  const item = createContextItem({
    id: createContextItemId(`authority:${type}`),
    type,
    source: {
      providerId: createContextSourceId("test.authority"),
      sourceRef: `test/${type}`,
      version: "v1",
    },
    scope: "RUN",
    retention: "EPHEMERAL",
    priorityClass: "NORMAL",
    tokenEstimate: 1,
    cacheStability: "DYNAMIC",
    freshness: "CURRENT",
    sensitivity: "INTERNAL",
    whyLoaded: "authority test",
    payload: { kind: "TEXT", text: "authority test" },
  });
  const policy = createContextPolicy({
    model: MODEL,
    requestOverhead: { toolSchemaTokens: 0, protocolOverheadTokens: 0, totalTokens: 0 },
    options: { outputReserveTokens: 1, safetyReserveTokens: 1 },
  });
  const plan = createContextPlanner().plan({ items: [item], policy });
  return createContextDocumentBuilder().build({
    plan,
    rehydrated: {
      goal: "",
      changedFiles: [],
      pendingApprovals: [],
      activeProcesses: [],
      verificationState: "",
      resourceGovernance: "",
      projectFacts: [],
    },
  });
}

describe("Phase 7C public provider exports and Document authority", () => {
  it("publishes Generic and Coding Providers from package roots", async () => {
    const agent = await import("@caelush/agent");
    const coding = await import("@caelush/coding-agent");

    expect(agent.AGENT_CONTEXT_SOURCE_IDS.conversation).toBe("agent.conversation");
    expect(coding.CODING_CONTEXT_SOURCE_IDS.relevantFiles).toBe("coding.relevant-files");
    expect(agent.createConversationContextSourceProvider).toBeTypeOf("function");
    expect(agent.createCheckpointContextSourceProvider).toBeTypeOf("function");
    expect(agent.createMemoryContextSourceProvider).toBeTypeOf("function");
    expect(agent.createExtensionContributionContextSourceProvider).toBeTypeOf("function");
    expect(agent.createBranchContextSourceProvider).toBeTypeOf("function");
    expect(coding.createRelevantFileContextSourceProvider).toBeTypeOf("function");
    expect(coding.createSkillCatalogContextSourceProvider).toBeTypeOf("function");
    expect(coding.createTemporalContextSourceProvider).toBeTypeOf("function");
  });

  it.each([
    ["coding.project_instruction", "PROJECT_INSTRUCTION"],
    ["coding.workspace", "RUNTIME_FACT"],
    ["coding.runtime_fact", "RUNTIME_FACT"],
    ["coding.git_state", "RUNTIME_FACT"],
    ["coding.temporal", "RUNTIME_FACT"],
    ["agent.checkpoint", "RECOVERY_RECORD"],
    ["agent.memory", "REFERENCE"],
    ["coding.project_metadata", "REFERENCE"],
    ["coding.relevant_file", "REFERENCE"],
    ["coding.skill_catalog", "REFERENCE"],
    ["coding.verification_repair", "DIAGNOSTIC"],
  ] as const)("maps %s to %s", (type, authority: ContextSectionAuthority) => {
    expect(buildDocumentForItemType(type).sections[0]?.authority).toBe(authority);
  });
});
