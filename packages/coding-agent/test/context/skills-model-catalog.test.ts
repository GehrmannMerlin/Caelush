import { describe, expect, it } from "vitest";

import { createUtf8HeuristicTokenEstimator, type ContextSourceInput } from "@caelush/agent";
import {
  createSkillCatalogContextSourceProvider,
  type SkillCatalogPort,
} from "@caelush/coding-agent";
import type { ModelDescriptor } from "@caelush/ai";
import type { SkillSearchCatalog } from "@caelush/skills";

const MODEL: ModelDescriptor = {
  ref: { provider: "fixture", model: "skills-catalog" },
  api: "fixture-chat",
  limits: { contextWindowTokens: 32_000, maxOutputTokens: 2_000 },
  capabilities: {
    streaming: "UNKNOWN",
    toolCalling: "UNKNOWN",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

describe("MODEL Skill catalog Context provider", () => {
  it("presents a bounded Run catalog and explicitly marks omitted entries", async () => {
    const catalog = catalogOf(500);
    const seen: string[] = [];
    const provider = createSkillCatalogContextSourceProvider({
      port: {
        async list(input: Parameters<SkillCatalogPort["list"]>[0]) {
          seen.push(input.runId);
          return catalog;
        },
      } satisfies SkillCatalogPort,
      tokenEstimator: createUtf8HeuristicTokenEstimator(),
    });

    const result = await provider.collect(contextInput(10_000));
    const text = result.items[0]?.payload.kind === "TEXT" ? result.items[0].payload.text : "";

    expect(seen).toEqual(["run_skill_catalog"]);
    expect(result.items).toHaveLength(1);
    expect(text).toContain('"presentationComplete":false');
    expect(text).toContain('"inventoryComplete":true');
    expect(text).toContain('"omittedCount":');
    expect(text).not.toContain("private-locator");
    expect(result.items[0]?.tokenEstimate).toBeLessThanOrEqual(200);
  });
});

function catalogOf(count: number): SkillSearchCatalog {
  return {
    revision: "catalog-model-presentation-v1",
    complete: true,
    diagnostics: [],
    entries: Array.from({ length: count }, (_, index) => ({
      skillId: `skill-id-${String(index).padStart(3, "0")}`,
      name: `skill-${String(index).padStart(3, "0")}`,
      description: `A safe public description for skill ${String(index)}.`,
      searchTerms: [],
      enabled: true,
      userInvocable: true,
      modelInvocable: true,
    })),
  };
}

function contextInput(effectiveInputLimitTokens: number): ContextSourceInput {
  return {
    identity: {
      runId: "run_skill_catalog" as never,
      sessionId: "session_skill_catalog" as never,
      goal: "find a Skill",
    },
    turn: { stepId: "step_skill_catalog" as never, sequence: 1 },
    conversation: {} as never,
    input: { kind: "CONTINUATION", reason: "STEERING" },
    model: MODEL,
    mode: "FORCED_RECOVERY",
    policy: { effectiveInputLimitTokens } as never,
    signal: new AbortController().signal,
  };
}
