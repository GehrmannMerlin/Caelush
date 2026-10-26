import { describe, expect, it } from "vitest";

import type {
  AIMessage,
  AIGateway,
  AIModelTurnResult,
  AIToolSpec,
  ModelDescriptor,
} from "@caelush/ai";
import { validateAIModelRequestShape } from "@caelush/ai";
import { createRunId, createSessionId } from "@caelush/protocol";
import {
  createContextMessageRange,
  createPrivateReplayReference,
  createContextSummaryReplayPrefixFingerprint,
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
  purpose: "COMPACTION",
  cacheEligibility: "NOT_ELIGIBLE",
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
  it("reuses the verified main prefix, preserves data-only Tools, and disables execution", async () => {
    const messages: readonly AIMessage[] = [
      { role: "system", content: "Stable host context." },
      { role: "user", content: "Earlier durable input." },
      { role: "assistant", content: [{ type: "text", text: "Earlier answer." }] },
    ];
    const tools: readonly AIToolSpec[] = [
      { name: "read_file", description: "Read one file", inputSchema: { type: "object" } },
    ];
    const replayPrefix = {
      modelRef: input.model.ref,
      api: input.model.api,
      surfaceFingerprint: `sha256:${"b".repeat(64)}`,
      messageRefs: [
        {
          messageId: String(input.sourceRange.firstMessageId),
          runId: String(input.sourceRange.runId),
          conversationTurnId: String(input.sourceRange.conversationTurnId),
          sequence: input.sourceRange.firstSequence,
          schemaVersion: 1,
          modelProjectionVersion: 1,
        },
      ],
      messages,
      tools,
    };
    const eligible = {
      ...input,
      purpose: "COMPACTION",
      cacheEligibility: "CACHE_REUSE_ELIGIBLE",
      replayPrefixFingerprint: createContextSummaryReplayPrefixFingerprint(replayPrefix),
      replayPrefix,
    } satisfies ContextSummarizationInput;
    const fixture = fakeGateway(gatewayResult());

    await createAIContextSummarizerAdapter(fixture.gateway).summarize(eligible, {
      signal: new AbortController().signal,
    });

    const request = fixture.requests[0]!;
    expect(request.messages).toHaveLength(messages.length + 1);
    expect(request.messages.slice(0, messages.length)).toEqual(messages);
    expect(request.tools).toEqual(tools);
    expect(request.toolChoice).toEqual({ type: "NONE" });
    expect(() => validateAIModelRequestShape(request)).not.toThrow();
    expect(request.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("SemanticCheckpointDraft"),
    });
    expect(request.messages.at(-1)?.content).toContain("UNTRUSTED_DATA");
    expect(request.messages.at(-1)?.content).not.toContain("Stable host context.");
    expect(request.messages.at(-1)?.content).not.toContain("Earlier durable input.");
    expect(request.messages.at(-1)?.content).not.toContain("Earlier answer.");
    expect(tools).toHaveLength(1);
  });

  it("scopes and disposes private native replay for a verified summary prefix", async () => {
    const messageId = String(input.sourceRange.firstMessageId);
    const providerState = createPrivateReplayReference({
      sessionId: String(identity.sessionId),
      runId: String(identity.runId),
      messageId,
      callId: "call_summary_replay",
      providerId: MODEL.ref.provider,
      model: MODEL.ref.model,
      api: MODEL.api,
      replayVersion: 1,
    });
    const replayPrefix = {
      modelRef: MODEL.ref,
      api: MODEL.api,
      surfaceFingerprint: `sha256:${"d".repeat(64)}`,
      messageRefs: [
        {
          messageId,
          runId: String(identity.runId),
          conversationTurnId: String(input.sourceRange.conversationTurnId),
          sequence: input.sourceRange.firstSequence,
          schemaVersion: 1,
          modelProjectionVersion: 1,
        },
      ],
      messages: [
        { role: "system" as const, content: "Stable host context." },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "Prior answer." }],
          providerState,
        },
      ],
      tools: [],
    };
    const replayInput: ContextSummarizationInput = {
      ...input,
      cacheEligibility: "CACHE_REUSE_ELIGIBLE",
      replayPrefix,
      replayPrefixFingerprint: createContextSummaryReplayPrefixFingerprint(replayPrefix),
    };
    const resolver = {
      async resolve() {
        return new Uint8Array([1, 2, 3]);
      },
    };
    let observedResolver: unknown;
    let disposed = false;
    const gateway = {
      async complete(
        _request: Parameters<AIGateway["complete"]>[0],
        options?: Parameters<AIGateway["complete"]>[1],
      ) {
        observedResolver = options?.privateReplayResolver;
        return gatewayResult();
      },
      async stream() {
        throw new Error("stream is not used by semantic summary");
      },
    } as AIGateway;

    await createAIContextSummarizerAdapter(gateway, {
      async createPrivateReplayExecution() {
        return {
          resolver,
          dispose() {
            disposed = true;
          },
        };
      },
    }).summarize(replayInput, { signal: new AbortController().signal });

    expect(observedResolver).toBe(resolver);
    expect(disposed).toBe(true);
  });

  it("uses the current model, disables tools, asks for semantic JSON, and forwards resolved metadata", async () => {
    const fixture = fakeGateway(gatewayResult());
    const result = await createAIContextSummarizerAdapter(fixture.gateway).summarize(input, {
      signal: new AbortController().signal,
    });
    const request = fixture.requests[0]!;

    expect(request.model).toEqual(input.model.ref);
    expect(request.tools).toEqual([]);
    expect(request.toolChoice).toEqual({ type: "NONE" });
    expect(() => validateAIModelRequestShape(request)).not.toThrow();
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("SemanticCheckpointDraft"),
    });
    expect(request.messages[0]?.content).toContain("verificationState");
    expect(request.messages[0]?.content).not.toContain(identity.goal);
    expect(request.messages[0]?.content).toContain("UNTRUSTED_DATA");
    expect(result.semantic).toEqual(semantic);
    expect(result.modelRef).toEqual({ provider: "test", model: "resolved-phase-8c" });
    expect(result.finishReason).toBe("STOP");
    expect(result.summaryPromptVersion).toBe(4);
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

  it("refuses a summary turn whose only Tool request had unparseable arguments", async () => {
    // `toolCalls` is empty here, so a projection-only check would accept the turn. The request is
    // still a Tool request, and a summary is never allowed to ask for one.
    const rejectedOnly = fakeGateway(
      gatewayResult({
        toolCalls: [],
        toolRequests: [
          {
            kind: "INVALID_ARGUMENTS",
            sourceOrdinal: 0,
            id: "call_rejected",
            name: "read_file",
            issue: { code: "MALFORMED_JSON", argumentBytes: 9 },
          },
        ],
      }),
    );
    await expect(
      createAIContextSummarizerAdapter(rejectedOnly.gateway).summarize(input, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/tool/i);
  });
});
