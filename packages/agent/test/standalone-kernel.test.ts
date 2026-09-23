import { describe, expect, it } from "vitest";
import type { AIGateway, AIStream, AIStreamEvent, AIModelTurnResult } from "@caelush/ai";
import {
  agentMessageId,
  conversationTurnId,
  createAgentDecisionClassifier,
  createAgentConversationSnapshot,
  createAgentLoop,
  createAgentTurnRef,
  createModelTurnExecutor,
  type AgentDecision,
  type AgentExecutionIdentity,
  type AgentLoopAdvanceInput,
  type ContextBuildReport,
  type ContextEnginePort,
  type ContextPrepareInput,
  type ModelTurnExecutor,
  type PreparedModelContext,
  type ToolObservationPolicySnapshot,
} from "@caelush/agent";
import { createRunId, createSessionId, createStepId, type StepId } from "@caelush/protocol";

/**
 * The General Agent Kernel, standalone.
 *
 * This file imports exactly two workspace packages — `@caelush/agent` and `@caelush/ai` — plus
 * the ID factory the host needs to name a turn. There is no Workspace, no Git, no Runtime, no
 * CodingAgent, no legacy Context or Tool package, no Verification and no SQLite anywhere in it.
 *
 * It proves the property the whole phase exists for: a general agent can reason, request a Tool,
 * receive a Tool's result and reach a final candidate with nothing but the frozen kernel and a
 * model. The echo Tool below is a test double owned by this file; the kernel has no idea it
 * exists.
 */

const IDENTITY: AgentExecutionIdentity = {
  runId: createRunId(),
  sessionId: createSessionId(),
  goal: "echo the input back",
};

const CONVERSATION = createAgentConversationSnapshot({
  sessionId: IDENTITY.sessionId,
  currentRunId: IDENTITY.runId,
  currentTurnId: conversationTurnId("cturn_kernel_fixture"),
  turns: [],
});
const USER_MESSAGE_ID = agentMessageId("kernel-user");

/**
 * A minimal echo Tool.
 *
 * It is deliberately outside the kernel: the loop returns a tool *request*, this file executes
 * it, and the result is handed back as the next turn's input.
 */
function echoTool(input: { readonly text: string }): string {
  return `echo:${input.text}`;
}

/** A scripted AI gateway that replays two model turns through the real frozen executor. */
function scriptedGateway(): { readonly gateway: AIGateway; calls(): number } {
  let calls = 0;
  const scripts: readonly AIStreamEvent[][] = [
    [
      {
        type: "stream.start",
        payload: {
          callId: "llm_0195f3a0-0000-7000-8000-00000000000a" as never,
          providerId: "test",
          model: { provider: "test", model: "model-a" },
          resolution: {
            api: "test-api",
            reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
            cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
          } as never,
        },
      },
      { type: "text.delta", payload: { text: "one moment" } },
      {
        type: "tool_call.completed",
        payload: { id: "call_echo", name: "echo", input: { text: "hello" } },
      },
      { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } },
    ],
    [
      {
        type: "stream.start",
        payload: {
          callId: "llm_0195f3a0-0000-7000-8000-00000000000b" as never,
          providerId: "test",
          model: { provider: "test", model: "model-a" },
          resolution: {
            api: "test-api",
            reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
            cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
          } as never,
        },
      },
      { type: "text.delta", payload: { text: "the tool said echo:hello" } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ],
  ];

  return {
    gateway: {
      stream(): Promise<AIStream> {
        const script = scripts[Math.min(calls, scripts.length - 1)]!;
        calls += 1;
        return Promise.resolve({
          callId: "llm_0195f3a0-0000-7000-8000-00000000000a" as never,
          events: (async function* generate(): AsyncGenerator<AIStreamEvent> {
            for (const event of script) yield event;
          })(),
        });
      },
      complete(): Promise<AIModelTurnResult> {
        return Promise.reject(new Error("the standalone agent must stream, not complete"));
      },
    },
    calls: () => calls,
  };
}

/** The frozen context answer a kernel-only engine can always produce. */
const REPORT: ContextBuildReport = {
  estimatedInputTokens: 12,
  effectiveInputLimitTokens: 900,
  remainingTokens: 888,
  pressure: "NORMAL",
  compactionCount: 0,
  contributions: [
    { providerId: "turn", tokenEstimate: 12, itemCount: 1, droppedItems: 0, truncatedItems: 0 },
  ],
};

const POLICY: ToolObservationPolicySnapshot = {
  maxSingleObservationTokens: 90,
  maxObservationBatchTokens: 198,
};

/** A Context Engine with no knowledge of anything but the turn it is asked about. */
function fakeContextEngine(): {
  readonly engine: ContextEnginePort;
  inputs(): readonly ContextPrepareInput[];
} {
  const inputs: ContextPrepareInput[] = [];
  return {
    engine: {
      prepare(input): Promise<PreparedModelContext> {
        inputs.push(input);
        // The engine contributes the turn's own user text and nothing else: there is no project,
        // no workspace and no file to consult.
        const messages = [{ role: "user" as const, content: "fixture" }];
        return Promise.resolve({ messages, report: REPORT, observationPolicy: POLICY });
      },
    },
    inputs: () => inputs,
  };
}

describe("General Agent Kernel, standalone", () => {
  it("reasons, requests a tool, receives its result and reaches a final candidate", async () => {
    const gateway = scriptedGateway();
    const context = fakeContextEngine();
    const modelTurnExecutor: ModelTurnExecutor = createModelTurnExecutor({
      gateway: gateway.gateway,
    });
    const loop = createAgentLoop({
      contextEngine: context.engine,
      modelTurnExecutor,
      decisionClassifier: createAgentDecisionClassifier(),
    });

    const base = {
      identity: IDENTITY,
      model: {
        ref: { provider: "test", model: "model-a" },
        api: "test-api",
        limits: { contextWindowTokens: 1_000, maxOutputTokens: 100 },
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
      } as const,
      tools: [
        {
          name: "echo",
          description: "echo the supplied text",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      ],
      conversation: CONVERSATION,
      signal: new AbortController().signal,
    };

    /* 1. User → AgentLoop → Tool request. */
    const first = await loop.advance({
      ...base,
      turn: createAgentTurnRef(createStepId(), 1),
      input: { kind: "USER_INPUT", userMessageId: USER_MESSAGE_ID },
    } satisfies AgentLoopAdvanceInput);

    expect(first.kind).toBe("TOOL_REQUESTS");
    if (first.kind !== "TOOL_REQUESTS") throw new Error("expected a decision");
    const requested: AgentDecision = first.decision;
    expect(requested.type).toBe("TOOL_CALLS_REQUESTED");
    if (requested.type !== "TOOL_CALLS_REQUESTED") throw new Error("expected tool requests");
    expect(requested.toolRequests).toEqual([
      { externalCallId: "call_echo", toolName: "echo", args: { text: "hello" } },
    ]);

    /* 2. This test file — not the kernel — executes the Tool. */
    const results = requested.toolRequests.map((request) => ({
      role: "tool" as const,
      toolCallId: request.externalCallId,
      toolName: request.toolName,
      content: echoTool(request.args as { readonly text: string }),
      isError: false,
    }));
    expect(results[0]?.content).toBe("echo:hello");

    /* 3. Tool result → AgentLoop → final candidate. */
    const second = await loop.advance({
      ...base,
      turn: createAgentTurnRef(createStepId(), 2),
      conversation: CONVERSATION,
      input: {
        kind: "TOOL_RESULTS",
        sourceStepId: "stp_0195f3a0-0000-7000-8000-000000000000" as StepId,
        pendingDecision: requested,
        toolResultMessageIds: results.map((result) =>
          agentMessageId(`result-${result.toolCallId}`),
        ),
      },
    } satisfies AgentLoopAdvanceInput);

    expect(second.kind).toBe("FINAL_CANDIDATE");
    if (second.kind !== "FINAL_CANDIDATE") throw new Error("expected a decision");
    expect(second.decision.type).toBe("FINAL_CANDIDATE");
    if (second.decision.type !== "FINAL_CANDIDATE") throw new Error("expected a candidate");
    expect(second.decision.candidateText).toBe("the tool said echo:hello");

    /* 4. The kernel performed no Tool execution and no completion. */
    expect(gateway.calls()).toBe(2);
    expect(second.messagesToAppend.map((message) => message.role)).toEqual(["assistant"]);
    // The only thing the kernel ever says about finishing is "candidate".
    expect(JSON.stringify(second.decision)).not.toContain("COMPLETED");
  });

  it("refuses a Tool result batch whose identity does not answer the request", async () => {
    const gateway = scriptedGateway();
    const context = fakeContextEngine();
    const loop = createAgentLoop({
      contextEngine: context.engine,
      modelTurnExecutor: createModelTurnExecutor({ gateway: gateway.gateway }),
      decisionClassifier: createAgentDecisionClassifier(),
    });

    const model = {
      ref: { provider: "test", model: "model-a" },
      api: "test-api",
      limits: { contextWindowTokens: 1_000, maxOutputTokens: 100 },
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
    } as const;

    const first = await loop.advance({
      identity: IDENTITY,
      turn: createAgentTurnRef(createStepId(), 1),
      input: { kind: "USER_INPUT", userMessageId: USER_MESSAGE_ID },
      conversation: CONVERSATION,
      model,
      tools: [],
      signal: new AbortController().signal,
    });
    if (first.kind !== "TOOL_REQUESTS") throw new Error("expected tool requests");

    const refused = await loop.advance({
      identity: IDENTITY,
      turn: createAgentTurnRef(createStepId(), 2),
      conversation: CONVERSATION,
      input: {
        kind: "TOOL_RESULTS",
        sourceStepId: "stp_0195f3a0-0000-7000-8000-000000000000" as StepId,
        pendingDecision: first.decision,
        // The durable reference is malformed, so the kernel refuses the batch before Context.
        toolResultMessageIds: [agentMessageId("")],
      },
      model,
      tools: [],
      signal: new AbortController().signal,
    });

    expect(refused.kind).toBe("FAILED");
    if (refused.kind !== "FAILED") throw new Error("expected failure");
    expect(refused.error.code).toBe("TOOL_OUTPUT_ERROR");
    expect(refused.messagesToAppend).toEqual([]);
    // The model was never asked to reason from an invalid batch.
    expect(gateway.calls()).toBe(1);
    expect(context.inputs()).toHaveLength(1);
  });

  it("streams correlated transient deltas to the host without making them durable", async () => {
    const gateway = scriptedGateway();
    const seen: { readonly type: string; readonly correlation: unknown }[] = [];
    const turn = createAgentTurnRef(createStepId(), 1);

    // The sink is bound where the frozen contract puts it: the composition decorates the
    // `ModelTurnExecutor`. `AgentLoop.advance()` has no presentation input at all.
    const executor = createModelTurnExecutor({ gateway: gateway.gateway });
    const loop = createAgentLoop({
      contextEngine: fakeContextEngine().engine,
      modelTurnExecutor: {
        execute: (execution) =>
          executor.execute({
            ...execution,
            streamSink: {
              publish(event): void {
                seen.push({
                  type: event.type,
                  correlation: { runId: event.runId, stepId: event.stepId },
                });
              },
            },
          }),
      },
      decisionClassifier: createAgentDecisionClassifier(),
    });

    const result = await loop.advance({
      identity: IDENTITY,
      turn,
      input: { kind: "USER_INPUT", userMessageId: USER_MESSAGE_ID },
      conversation: CONVERSATION,
      model: {
        ref: { provider: "test", model: "model-a" },
        api: "test-api",
        limits: { contextWindowTokens: 1_000, maxOutputTokens: 100 },
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
      },
      tools: [],
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe("TOOL_REQUESTS");
    // Only transient deltas reached the host: no envelope, no usage, no tool lifecycle.
    expect(seen).toEqual([
      { type: "text.delta", correlation: { runId: IDENTITY.runId, stepId: turn.stepId } },
    ]);
  });

  it("correlates every delta of every concurrent turn without crossing streams", async () => {
    const gateway = scriptedGateway();
    const seen: { readonly runId: string; readonly stepId: string; readonly type: string }[] = [];
    const executor = createModelTurnExecutor({ gateway: gateway.gateway });
    const loop = createAgentLoop({
      contextEngine: fakeContextEngine().engine,
      modelTurnExecutor: executor,
      decisionClassifier: createAgentDecisionClassifier(),
    });

    const model = {
      ref: { provider: "test", model: "model-a" },
      api: "test-api",
      limits: { contextWindowTokens: 1_000, maxOutputTokens: 100 },
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
    } as const;

    // Two Runs, two Steps, one shared presentation channel. Each delta must carry the identity
    // of the turn that produced it, because the host is the only party that knows the mapping.
    const runs = [
      { identity: IDENTITY, turn: createAgentTurnRef(createStepId(), 1) },
      {
        identity: { ...IDENTITY, runId: createRunId() } satisfies AgentExecutionIdentity,
        turn: createAgentTurnRef(createStepId(), 2),
      },
    ];

    for (const entry of runs) {
      await createAgentLoop({
        contextEngine: fakeContextEngine().engine,
        modelTurnExecutor: {
          execute: (execution) =>
            executor.execute({
              ...execution,
              streamSink: {
                publish(event): void {
                  seen.push({
                    runId: event.runId,
                    stepId: event.stepId,
                    type: event.type,
                  });
                },
              },
            }),
        },
        decisionClassifier: createAgentDecisionClassifier(),
      }).advance({
        identity: entry.identity,
        turn: entry.turn,
        input: { kind: "USER_INPUT", userMessageId: USER_MESSAGE_ID },
        conversation: CONVERSATION,
        model,
        tools: [],
        signal: new AbortController().signal,
      });
    }

    expect(seen).toEqual([
      { runId: runs[0]!.identity.runId, stepId: runs[0]!.turn.stepId, type: "text.delta" },
      { runId: runs[1]!.identity.runId, stepId: runs[1]!.turn.stepId, type: "text.delta" },
    ]);
    void loop;
  });
});
