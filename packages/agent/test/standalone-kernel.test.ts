import { describe, expect, it } from "vitest";
import type { AIGateway, AIStream, AIStreamEvent, AIModelTurnResult } from "@caelush/ai";
import {
  createAgentLoop,
  createAgentTurnRef,
  createModelTurnExecutor,
  type AgentDecision,
  type AgentExecutionIdentity,
  type AgentLoopAdvanceInput,
  type ContextEnginePort,
  type ContextPrepareInput,
  type ModelTurnExecutor,
  type PreparedModelContext,
  type ModelTurnStreamSink,
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
        const messages =
          input.input.kind === "USER_INPUT"
            ? [...input.history, ...input.input.messages]
            : input.input.kind === "TOOL_RESULTS"
              ? [
                  ...input.history,
                  input.input.pendingDecision.modelTurn.assistantMessage,
                  ...input.input.results,
                ]
              : [...input.history, ...(input.input.messages ?? [])];
        return Promise.resolve({
          messages,
          report: { mode: input.mode, items: messages.length },
        });
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
      history: [],
      signal: new AbortController().signal,
    };

    /* 1. User → AgentLoop → Tool request. */
    const first = await loop.advance({
      ...base,
      turn: createAgentTurnRef(createStepId(), 1),
      input: { kind: "USER_INPUT", messages: [{ role: "user", content: "say hello" }] },
    } satisfies AgentLoopAdvanceInput);

    expect(first.status).toBe("COMPLETED");
    if (first.status !== "COMPLETED") throw new Error("expected a decision");
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
      // The history this Reason sees is what the previous Reason appended, which is exactly the
      // ledger a caller persists.
      history: first.messagesToAppend,
      input: {
        kind: "TOOL_RESULTS",
        sourceStepId: "stp_0195f3a0-0000-7000-8000-000000000000" as StepId,
        pendingDecision: requested,
        results,
      },
    } satisfies AgentLoopAdvanceInput);

    expect(second.status).toBe("COMPLETED");
    if (second.status !== "COMPLETED") throw new Error("expected a decision");
    expect(second.decision.type).toBe("FINAL_CANDIDATE");
    if (second.decision.type !== "FINAL_CANDIDATE") throw new Error("expected a candidate");
    expect(second.decision.candidateText).toBe("the tool said echo:hello");

    /* 4. The kernel performed no Tool execution and no completion. */
    expect(gateway.calls()).toBe(2);
    expect(second.messagesToAppend.map((message) => message.role)).toEqual(["tool", "assistant"]);
    // The only thing the kernel ever says about finishing is "candidate".
    expect(JSON.stringify(second.decision)).not.toContain("COMPLETED");
  });

  it("streams transient deltas to the host without making them durable", async () => {
    const gateway = scriptedGateway();
    const seen: string[] = [];
    const loop = createAgentLoop({
      contextEngine: fakeContextEngine().engine,
      modelTurnExecutor: createModelTurnExecutor({ gateway: gateway.gateway }),
    });

    const result = await loop.advance({
      identity: IDENTITY,
      turn: createAgentTurnRef(createStepId(), 1),
      input: { kind: "USER_INPUT", messages: [{ role: "user", content: "say hello" }] },
      history: [],
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
      streamSink: {
        publish(event): void {
          seen.push(event.type);
        },
      } satisfies ModelTurnStreamSink,
    });

    expect(result.status).toBe("COMPLETED");
    // Only transient deltas reached the host: no envelope, no usage, no tool lifecycle.
    expect(seen).toEqual(["text.delta"]);
  });
});
