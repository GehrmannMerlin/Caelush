import type { AICacheRequest, ModelCatalog } from "@caelush/ai";
import type { ModelTurnExecutor } from "@caelush/agent";
import { createStepId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createRunAgentExecutionContext,
  type RunAgentExecutionConfiguration,
} from "../src/run-agent-execution.js";
import type { AgentLoopModelSettings } from "../src/run-agent-types.js";

function createContext(config: RunAgentExecutionConfiguration) {
  return createRunAgentExecutionContext({
    config,
    models: {} as ModelCatalog,
    modelTurnExecutor: {} as ModelTurnExecutor,
    stepIds: { create: createStepId },
    createContextEngine: () => ({
      prepare: async () => {
        throw new Error("the Context Engine is not used by this settings projection test");
      },
    }),
  });
}

describe("Run Agent cache settings projection", () => {
  it("preserves the cache request while keeping tool choice out of AI settings", () => {
    const cache: AICacheRequest = { retention: "SHORT", key: "stable-conversation-key" };
    const modelSettings: AgentLoopModelSettings = {
      cache,
      toolChoice: { type: "NONE" },
    };
    const context = createContext({ baseSystemPrompt: "system", tools: [], modelSettings });

    expect(context.modelSettings).toEqual({ cache });
    expect(context.modelSettings).not.toHaveProperty("toolChoice");
  });

  it("does not invent a cache request when the host has no model settings", () => {
    const context = createContext({ baseSystemPrompt: "system", tools: [] });

    expect(context.modelSettings).toBeUndefined();
  });
});
