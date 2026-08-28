import { AgentRunSchema, createRunId, createSessionId, createWorkspaceId } from "@caelush/protocol";
import { LLMRequestSchema } from "@caelush/llm/request";
import { describe, expect, it } from "vitest";
import { buildAgentLLMRequest } from "../src/agent-loop-request.js";

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

describe("AgentLoop LLM request builder", () => {
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
    const request = buildAgentLLMRequest(context, run, tools, {
      maxOutputTokens: 40,
      temperature: 0.2,
    });
    expect(LLMRequestSchema.parse(request)).toEqual({
      model: run.model,
      messages: context.messages,
      tools,
      toolChoice: { type: "AUTO" },
      maxOutputTokens: 40,
      temperature: 0.2,
    });
  });

  it("omits tools and choice when none are supplied and never leaks RunLimits", () => {
    const request = buildAgentLLMRequest(context, run, undefined, undefined);
    expect(request).toEqual({ model: run.model, messages: context.messages });
    expect(request).not.toHaveProperty("maxTokens");
    expect(request).not.toHaveProperty("maxCost");
    expect(request).not.toHaveProperty("timeoutMs");
  });
});
