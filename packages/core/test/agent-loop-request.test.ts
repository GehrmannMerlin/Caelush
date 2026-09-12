import { AgentRunSchema, createRunId, createSessionId, createWorkspaceId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { buildAgentAIModelRequest } from "../src/agent-loop-request.js";
import { testModelCatalog } from "./support/fake-model-turn-executor.js";

const run = AgentRunSchema.parse({
  id: createRunId(),
  sessionId: createSessionId(),
  goal: "goal",
  status: "RUNNING",
  workspace: { id: createWorkspaceId(), path: "/repo" },
  model: { provider: "fixture", model: "fixture-model" },
  runtime: { id: "runtime", kind: "fixture" },
  permissionProfile: "READ_ONLY",
  approvalPolicy: "ALWAYS_ASK",
  limits: { maxSteps: 3, maxToolCalls: 99, timeoutMs: 99, maxTokens: 7, maxCost: 1 },
  createdAt: 0,
  startedAt: 0,
});

const context = {
  messages: [{ role: "system" as const, content: "context" }],
  report: {} as never,
};

/** The AI model ref the loop resolves with; Protocol refs may carry a legacy baseUrl. */
const aiRef = { provider: run.model.provider, model: run.model.model };

/** The descriptor the AgentLoop resolves from the catalog before building a request. */
const descriptor = testModelCatalog().resolve(aiRef);

describe("AgentLoop AI model request builder", () => {
  it("uses run.model, forwards tools/settings, and defaults tool choice to AUTO", () => {
    const tools = [
      {
        name: "read_file",
        description: "read",
        inputSchema: {},
        outputSchema: {},
        riskLevel: "LOW" as const,
        requiredCapabilities: [],
        runtimeRequirements: {},
      },
    ];
    const request = buildAgentAIModelRequest(
      context,
      run,
      tools,
      { maxOutputTokens: 40, temperature: 0.2 },
      descriptor,
    );

    // `baseUrl` is a legacy compatibility hint and must not survive the projection.
    expect(request.model).toEqual({ provider: "fixture", model: "fixture-model" });
    expect(request.messages).toEqual(context.messages);
    // Only the model-facing tool fields cross the boundary.
    expect(request.tools).toEqual([{ name: "read_file", description: "read", inputSchema: {} }]);
    expect(request.toolChoice).toEqual({ type: "AUTO" });
    expect(request.settings).toEqual({ maxOutputTokens: 40, temperature: 0.2 });
    // RunLimits are budget policy, not model settings.
    expect(request).not.toHaveProperty("maxTokens");
    expect(request).not.toHaveProperty("maxCost");
    expect(request).not.toHaveProperty("timeoutMs");
  });

  it("omits tools, choice and settings when none are supplied and never leaks RunLimits", () => {
    const request = buildAgentAIModelRequest(context, run, undefined, undefined, descriptor);
    expect(request).toEqual({
      model: { provider: "fixture", model: "fixture-model" },
      messages: context.messages,
    });
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("toolChoice");
    expect(request).not.toHaveProperty("settings");
  });

  it("rejects a request the resolved model cannot serve", () => {
    const descriptorWithoutTools = testModelCatalog({
      ref: aiRef,
      api: "test-api",
      limits: { contextWindowTokens: 1_000, maxOutputTokens: 100 },
      capabilities: {
        streaming: "SUPPORTED",
        toolCalling: "UNSUPPORTED",
        parallelToolCalls: "UNKNOWN",
        structuredOutput: "UNKNOWN",
        vision: "UNKNOWN",
        reasoning: "UNKNOWN",
        reasoningSummary: "UNKNOWN",
        promptCaching: "UNKNOWN",
        usageReporting: "UNKNOWN",
      },
      source: "CONFIGURATION",
    }).resolve(aiRef);

    expect(() =>
      buildAgentAIModelRequest(
        context,
        run,
        [
          {
            name: "read_file",
            description: "read",
            inputSchema: {},
            outputSchema: {},
            riskLevel: "LOW" as const,
            requiredCapabilities: [],
            runtimeRequirements: {},
          },
        ],
        undefined,
        descriptorWithoutTools,
      ),
    ).toThrow();
  });
});
