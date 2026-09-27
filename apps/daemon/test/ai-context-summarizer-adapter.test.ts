import { describe, expect, it } from "vitest";

import type { AIGateway, AIModelTurnResult, ModelDescriptor } from "@caelush/ai";
import { createRunId, createSessionId } from "@caelush/protocol";
import {
  createContextMessageRange,
  type AgentExecutionIdentity,
  type ContextSummarizationInput,
} from "@caelush/agent";
import { agentMessageId, conversationTurnId } from "@caelush/agent";

import { createAIContextSummarizerAdapter } from "../src/context/ai-context-summarizer-adapter.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-8c-current" },
  api: "test-api",
  limits: { contextWindowTokens: 10_000, maxOutputTokens: 1_000 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
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

const identity: AgentExecutionIdentity = {
  runId: createRunId(),
  sessionId: createSessionId(),
  goal: "Summarize safely.",
};

const input: ContextSummarizationInput = {
  identity,
  reason: "PROACTIVE_PRESSURE",
  sourceMessages: [],
  sourceRange: createContextMessageRange({
    runId: identity.runId,
    conversationTurnId: conversationTurnId("cturn_phase_8c_adapter"),
    firstMessageId: agentMessageId("amsg_phase_8c_adapter_first"),
    lastMessageId: agentMessageId("amsg_phase_8c_adapter_last"),
    firstSequence: 1,
    lastSequence: 2,
  }),
  cut: {
    kind: "TURN_BOUNDARY",
    firstKeptTurnId: conversationTurnId("cturn_phase_8c_adapter"),
    firstKeptMessageId: agentMessageId("amsg_phase_8c_adapter_last"),
    firstKeptSequence: 3,
  },
  targetTokens: 100,
  model: MODEL,
};

const semantic = {
  goal: "Summarize safely.",
  constraints: [],
  completedWork: ["source was read"],
  inProgress: [],
  blocked: [],
  importantDiscoveries: [],
  keyDecisions: [],
  criticalReferences: [],
  nextIntent: "Continue",
};

function gatewayResult(overrides: Partial<AIModelTurnResult> = {}): AIModelTurnResult {
  return {
    callId: "llm_phase_8c" as AIModelTurnResult["callId"],
    providerId: "test" as AIModelTurnResult["providerId"],
    model: { provider: "test", model: "resolved-phase-8c" },
    text: JSON.stringify(semantic),
    toolCalls: [],
    finishReason: "STOP",
    resolution: {} as AIModelTurnResult["resolution"],
    ...overrides,
  };
}

function fakeGateway(result: AIModelTurnResult): {
  gateway: AIGateway;
  requests: Array<Parameters<AIGateway["complete"]>[0]>;
} {
  const requests: Array<Parameters<AIGateway["complete"]>[0]> = [];
  return {
    requests,
    gateway: {
      async complete(request) {
        requests.push(request);
        return result;
      },
      async stream() {
        throw new Error("stream is not used by semantic summary");
      },
    },
  };
}

describe("Phase 8C Daemon semantic summarizer adapter", () => {
  it("uses the current model, disables tools, asks for semantic JSON, and forwards resolved metadata", async () => {
    const fixture = fakeGateway(gatewayResult());
    const result = await createAIContextSummarizerAdapter(fixture.gateway).summarize(input, {
      signal: new AbortController().signal,
    });
    const request = fixture.requests[0]!;

    expect(request.model).toEqual(input.model.ref);
    expect(request.tools).toEqual([]);
    expect(request.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("SemanticCheckpointDraft"),
    });
    expect(request.messages[0]).toMatchObject({
      content: expect.stringContaining("verificationState"),
    });
    expect(request.messages[1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("UNTRUSTED_DATA"),
    });
    expect(result.semantic).toEqual(semantic);
    expect(result.modelRef).toEqual({ provider: "test", model: "resolved-phase-8c" });
    expect(result.finishReason).toBe("STOP");
    expect(result.summaryPromptVersion).toBe(2);
  });

  it.each(["LENGTH", "CONTENT_FILTER", "TOOL_CALLS", "OTHER"] as const)(
    "forwards finish reason %s without rewriting it",
    async (finishReason) => {
      const fixture = fakeGateway(gatewayResult({ finishReason }));
      const result = await createAIContextSummarizerAdapter(fixture.gateway).summarize(input, {
        signal: new AbortController().signal,
      });
      expect(result.finishReason).toBe(finishReason);
    },
  );

  it("refuses malformed JSON and unexpected tool calls without executing anything", async () => {
    const malformed = fakeGateway(gatewayResult({ text: "not json" }));
    await expect(
      createAIContextSummarizerAdapter(malformed.gateway).summarize(input, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/JSON|semantic/i);

    const toolCalls = fakeGateway(
      gatewayResult({
        toolCalls: [{ id: "call_1", name: "read_file", input: {} }],
      }),
    );
    await expect(
      createAIContextSummarizerAdapter(toolCalls.gateway).summarize(input, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/tool/i);
  });
});
