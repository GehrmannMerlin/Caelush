import { describe, expect, it } from "vitest";
import {
  allowedModelAdmission,
  agentMessageId,
  conversationTurnId,
  createAgentDecisionClassifier,
  createAgentConversationSnapshot,
  createAgentLoop,
  createAgentTurnRef,
} from "../src/index.js";
import type {
  AgentDecision,
  AgentExecutionIdentity,
  AgentLoopAdvanceInput,
  AgentLoopAdvanceResult,
  AgentLoopContextReceipt,
  ContextBuildReport,
  ContextEnginePort,
  ContextPrepareInput,
  ModelRequestAdmissionDecision,
  ModelRequestAdmissionInput,
  ModelTurnBoundaryInput,
  ModelTurnBoundaryPort,
  ModelTurnExecutionResult,
  ModelTurnExecutor,
  PreparedModelContext,
  ToolObservationPolicySnapshot,
} from "../src/index.js";
import type { AIModelTurnResult, ModelDescriptor } from "@caelush/ai";
import { createRunId, createSessionId, createStepId, type StepId } from "@caelush/protocol";

/**
 * Frozen `AgentLoop.advance()` behaviour.
 *
 * These tests drive the loop with hand-written ports, so they prove the *order* of one Reason
 * and nothing else: there is no Run, no Runtime, no Tool, no workspace and no storage anywhere
 * in this file.
 */

const IDENTITY: AgentExecutionIdentity = {
  runId: createRunId(),
  sessionId: createSessionId(),
  goal: "prove one Reason",
};

const TURN = createAgentTurnRef(createStepId(), 1);
const USER_MESSAGE_ID = agentMessageId("amsg_user_input");
const CONVERSATION = createAgentConversationSnapshot({
  sessionId: IDENTITY.sessionId,
  currentRunId: IDENTITY.runId,
  currentTurnId: conversationTurnId("cturn_fixture"),
  turns: [],
});

const MODEL: ModelDescriptor = {
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
};

const RESOLUTION = {
  api: "test-api",
  reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
  cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
} as const;

const REPORT: ContextBuildReport = {
  estimatedInputTokens: 10,
  effectiveInputLimitTokens: 100,
  remainingTokens: 90,
  pressure: "NORMAL",
  compactionCount: 0,
  requestOverheadTokens: 0,
  contributions: [
    {
      providerId: "test",
      tokenEstimate: 10,
      itemCount: 1,
      droppedItems: 0,
      truncatedItems: 0,
    },
  ],
};

const POLICY: ToolObservationPolicySnapshot = {
  maxSingleObservationTokens: 100,
  maxObservationBatchTokens: 200,
};

/** The frozen context answer every hand-written engine returns unless a test says otherwise. */
function prepared(partial: Partial<PreparedModelContext> = {}): PreparedModelContext {
  return {
    messages: [{ role: "user", content: "prepared" }],
    report: REPORT,
    observationPolicy: POLICY,
    ...partial,
  };
}

function turnResult(partial: Partial<AIModelTurnResult> = {}): AIModelTurnResult {
  return {
    callId: "llm_0195f3a0-0000-7000-8000-000000000000" as AIModelTurnResult["callId"],
    providerId: "test",
    model: MODEL.ref,
    text: "",
    toolCalls: [],
    finishReason: "STOP",
    resolution: RESOLUTION as never,
    ...partial,
  };
}

function userTurn(content = "hello"): AgentLoopAdvanceInput["input"] {
  void content;
  return { kind: "USER_INPUT", userMessageId: USER_MESSAGE_ID };
}

/** A context engine that records what it was asked and returns a fixed context. */
function contextEngine(options: {
  readonly context?: PreparedModelContext;
  readonly onPrepare?: (
    input: ContextPrepareInput,
  ) => PreparedModelContext | Promise<PreparedModelContext>;
  readonly fail?: (input: ContextPrepareInput) => unknown;
}): {
  readonly engine: ContextEnginePort;
  modes(): readonly string[];
  inputs(): readonly ContextPrepareInput[];
} {
  const modes: string[] = [];
  const inputs: ContextPrepareInput[] = [];
  return {
    engine: {
      async prepare(input) {
        modes.push(input.mode);
        inputs.push(input);
        if (options.fail !== undefined) throw options.fail(input);
        if (options.onPrepare !== undefined) return options.onPrepare(input);
        return options.context ?? prepared();
      },
    },
    modes: () => modes,
    inputs: () => inputs,
  };
}

/** A model turn executor that replays a script and counts invocations. */
function modelTurns(
  script: readonly ModelTurnExecutionResult[] | (() => ModelTurnExecutionResult),
): { readonly executor: ModelTurnExecutor; callCount(): number; requests(): readonly unknown[] } {
  let calls = 0;
  const requests: unknown[] = [];
  return {
    executor: {
      execute(input) {
        requests.push(input.request);
        const result =
          typeof script === "function" ? script() : script[Math.min(calls, script.length - 1)];
        calls += 1;
        return Promise.resolve(result!);
      },
    },
    callCount: () => calls,
    requests: () => requests,
  };
}

function advanceInput(overrides: Partial<AgentLoopAdvanceInput> = {}): AgentLoopAdvanceInput {
  return {
    identity: IDENTITY,
    turn: TURN,
    input: userTurn(),
    conversation: CONVERSATION,
    model: MODEL,
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function loopWith(options: {
  readonly context?: ReturnType<typeof contextEngine>;
  readonly turns?: ReturnType<typeof modelTurns>;
  readonly admission?: {
    admit: (input: ModelRequestAdmissionInput) => Promise<ModelRequestAdmissionDecision>;
  };
  readonly boundary?: ModelTurnBoundaryPort;
}) {
  return createAgentLoop({
    contextEngine: (options.context ?? contextEngine({})).engine,
    modelTurnExecutor: (
      options.turns ?? modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "answer" }) }])
    ).executor,
    decisionClassifier: createAgentDecisionClassifier(),
    ...(options.admission === undefined
      ? {}
      : { modelAdmission: { admit: options.admission.admit } as never }),
    ...(options.boundary === undefined ? {} : { modelTurnBoundary: options.boundary }),
  });
}

function decisionOf(result: AgentLoopAdvanceResult): AgentDecision {
  if (result.kind !== "TOOL_REQUESTS" && result.kind !== "FINAL_CANDIDATE") {
    throw new Error(`expected a decision, received ${result.kind}`);
  }
  return result.decision;
}

describe("AgentLoop.advance() one Reason", () => {
  it("turns a user input with tool calls into TOOL_REQUESTS", async () => {
    const turns = modelTurns([
      {
        kind: "COMPLETED",
        result: turnResult({
          finishReason: "TOOL_CALLS",
          toolCalls: [{ id: "call_a", name: "read_file", input: { path: "a.ts" } }],
        }),
      },
    ]);

    const result = await loopWith({ turns }).advance(advanceInput());

    expect(result.kind).toBe("TOOL_REQUESTS");
    expect(decisionOf(result).type).toBe("TOOL_CALLS_REQUESTED");
    // The loop never executes a tool: it reports the request and stops.
    expect(turns.callCount()).toBe(1);
    if (result.kind !== "TOOL_REQUESTS") throw new Error("expected tool requests");
    expect(result.messagesToAppend.map((message) => message.role)).toEqual(["assistant"]);
    expect(result.context).toEqual({ report: REPORT, observationPolicy: POLICY, recovery: "NONE" });
    expect(result.turn).toEqual(TURN);
    expect(result.modelTurn.finishReason).toBe("TOOL_CALLS");
  });

  it("turns a plain answer into FINAL_CANDIDATE, never into completion", async () => {
    const result = await loopWith({}).advance(advanceInput());

    expect(result.kind).toBe("FINAL_CANDIDATE");
    const decision = decisionOf(result);
    expect(decision.type).toBe("FINAL_CANDIDATE");
    // The only expression of "the model finished" the kernel owns is a candidate.
    expect(Object.keys(decision)).toEqual(["type", "modelTurn", "candidateText"]);
  });

  it("validates tool results and returns the next decision", async () => {
    const turns = modelTurns([
      {
        kind: "COMPLETED",
        result: turnResult({
          finishReason: "TOOL_CALLS",
          toolCalls: [{ id: "call_b", name: "search_text", input: { query: "x" } }],
        }),
      },
    ]);
    const pending = {
      type: "TOOL_CALLS_REQUESTED" as const,
      modelTurn: {
        callId: "llm_0195f3a0-0000-7000-8000-000000000000",
        model: MODEL.ref,
        finishReason: "TOOL_CALLS" as const,
        assistantMessage: {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call_a",
              toolName: "read_file",
              input: { path: "a.ts" },
            },
          ],
        },
      },
      toolRequests: [{ externalCallId: "call_a", toolName: "read_file", args: { path: "a.ts" } }],
    };

    const result = await loopWith({ turns }).advance(
      advanceInput({
        input: {
          kind: "TOOL_RESULTS",
          sourceStepId: TURN.stepId,
          pendingDecision: pending,
          toolResultMessageIds: [agentMessageId("result-call_a")],
        },
      }),
    );

    expect(decisionOf(result).type).toBe("TOOL_CALLS_REQUESTED");
    if (result.kind !== "TOOL_REQUESTS") throw new Error("expected tool requests");
    expect(result.messagesToAppend.map((message) => message.role)).toEqual(["assistant"]);
  });

  it("returns a final candidate from a tool-result continuation", async () => {
    const pending = {
      type: "TOOL_CALLS_REQUESTED" as const,
      modelTurn: {
        callId: "llm_0195f3a0-0000-7000-8000-000000000000",
        model: MODEL.ref,
        finishReason: "TOOL_CALLS" as const,
        assistantMessage: {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call_a",
              toolName: "read_file",
              input: { path: "a.ts" },
            },
          ],
        },
      },
      toolRequests: [{ externalCallId: "call_a", toolName: "read_file", args: { path: "a.ts" } }],
    };

    const result = await loopWith({}).advance(
      advanceInput({
        input: {
          kind: "TOOL_RESULTS",
          sourceStepId: TURN.stepId,
          pendingDecision: pending,
          toolResultMessageIds: [agentMessageId("result-call_a")],
        },
      }),
    );

    expect(decisionOf(result).type).toBe("FINAL_CANDIDATE");
  });

  it("carries supplied continuation messages and appends the assistant message", async () => {
    const result = await loopWith({}).advance(
      advanceInput({
        input: {
          kind: "CONTINUATION",
          reason: "VERIFICATION_REPAIR",
          messageIds: [agentMessageId("steering-message")],
        },
      }),
    );

    expect(decisionOf(result).type).toBe("FINAL_CANDIDATE");
    if (result.kind !== "FINAL_CANDIDATE") throw new Error("expected final candidate");
    expect(result.messagesToAppend.map((message) => message.role)).toEqual(["assistant"]);
  });

  it("accepts a STEERING continuation as a contract with no special behaviour", async () => {
    const result = await loopWith({}).advance(
      advanceInput({ input: { kind: "CONTINUATION", reason: "STEERING" } }),
    );

    expect(result.kind).toBe("FINAL_CANDIDATE");
  });
});

describe("AgentLoop.advance() failure classification", () => {
  it.each([["LENGTH"], ["CONTENT_FILTER"], ["OTHER"]])(
    "fails a %s turn without a decision, keeping the settled turn",
    async (finishReason) => {
      const turns = modelTurns([
        {
          kind: "COMPLETED",
          result: turnResult({ finishReason: finishReason as never, text: "partial" }),
        },
      ]);

      const result = await loopWith({ turns }).advance(advanceInput());

      expect(result.kind).toBe("FAILED");
      if (result.kind !== "FAILED") throw new Error("expected failure");
      expect(result.error.code).toBe("MODEL_ERROR");
      expect(result.error.retryable).toBe(false);
      // The provider answered, so the settled turn travels with the failure.
      expect(result.modelTurn?.finishReason).toBe(finishReason);
      expect(result.turn).toEqual(TURN);
    },
  );

  it("projects a provider failure onto the canonical error with retry metadata", async () => {
    const turns = modelTurns([
      {
        kind: "FAILED",
        error: { code: "NETWORK", message: "unreachable", retryable: true, retryAfterMs: 1_500 },
      },
    ]);

    const result = await loopWith({ turns }).advance(advanceInput());

    expect(result).toMatchObject({
      kind: "FAILED",
      error: { code: "NETWORK_ERROR", retryable: true, phase: "LLM" },
      retry: { code: "NETWORK", retryable: true, retryAfterMs: 1_500 },
    });
    if (result.kind !== "FAILED") throw new Error("expected failure");
    expect(result.modelTurn).toBeUndefined();
  });

  it("carries no retry metadata for a deterministic provider failure", async () => {
    const turns = modelTurns([
      { kind: "FAILED", error: { code: "AUTHENTICATION", message: "denied", retryable: false } },
    ]);

    const result = await loopWith({ turns }).advance(advanceInput());

    expect(result.kind).toBe("FAILED");
    if (result.kind !== "FAILED") throw new Error("expected failure");
    expect(result.error.code).toBe("MODEL_ERROR");
    expect(result.retry).toBeUndefined();
  });

  it("fails a context preparation error with no provider call", async () => {
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "never" }) }]);
    const context = contextEngine({ fail: () => new Error("inspection failed") });

    const result = await loopWith({ context, turns }).advance(advanceInput());

    expect(result).toMatchObject({ kind: "FAILED", error: { code: "MODEL_ERROR" } });
    // Nothing was prepared, so the failure carries no context receipt at all.
    expect((result as { context?: unknown }).context).toBeUndefined();
    expect(turns.callCount()).toBe(0);
  });

  it("performs no provider call when admission blocks the turn", async () => {
    let boundaryCalls = 0;
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "never" }) }]);

    const result = await loopWith({
      turns,
      admission: {
        admit: () =>
          Promise.resolve({
            kind: "BLOCKED" as const,
            reason: "BUDGET" as const,
            block: { kind: "EXCEEDED", dimension: "TOKENS", accounted: 5, limit: 5 } as never,
          }),
      },
      boundary: {
        beforeExecute: () => {
          boundaryCalls += 1;
          return Promise.resolve();
        },
      },
    }).advance(advanceInput());

    expect(result.kind).toBe("FAILED");
    if (result.kind !== "FAILED") throw new Error("expected failure");
    expect(result.error.code).toBe("BUDGET_EXCEEDED");
    // A refused turn reaches neither the durable boundary nor the provider.
    expect(boundaryCalls).toBe(0);
    expect(turns.callCount()).toBe(0);
  });

  it("fails closed as unavailable when budget enforcement cannot be established", async () => {
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "never" }) }]);

    const result = await loopWith({
      turns,
      admission: {
        admit: () =>
          Promise.resolve({
            kind: "BLOCKED" as const,
            reason: "BUDGET" as const,
            block: { kind: "UNAVAILABLE", reason: "PRICING" } as never,
          }),
      },
    }).advance(advanceInput());

    expect(result.kind).toBe("FAILED");
    if (result.kind !== "FAILED") throw new Error("expected failure");
    // An unavailable budget is not an exceeded one.
    expect(result.error.code).toBe("BUDGET_ENFORCEMENT_UNAVAILABLE");
  });

  it("performs no provider call when the durable boundary fails", async () => {
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "never" }) }]);

    const result = await loopWith({
      turns,
      boundary: { beforeExecute: () => Promise.reject(new Error("commit failed")) },
    }).advance(advanceInput());

    expect(result).toMatchObject({ kind: "FAILED", error: { code: "MODEL_ERROR" } });
    expect(turns.callCount()).toBe(0);
  });

  it("performs one provider call when the durable boundary succeeds", async () => {
    let boundaryCalls = 0;
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "answer" }) }]);

    const result = await loopWith({
      turns,
      boundary: {
        beforeExecute: () => {
          boundaryCalls += 1;
          return Promise.resolve();
        },
      },
    }).advance(advanceInput());

    expect(result.kind).toBe("FINAL_CANDIDATE");
    expect(boundaryCalls).toBe(1);
    expect(turns.callCount()).toBe(1);
  });

  it("orders context, admission, boundary and model", async () => {
    const order: string[] = [];
    const turns: ReturnType<typeof modelTurns> = {
      executor: {
        execute: () => {
          order.push("model");
          return Promise.resolve({ kind: "COMPLETED", result: turnResult({ text: "answer" }) });
        },
      },
      callCount: () => order.length,
      requests: () => [],
    };

    await loopWith({
      turns,
      context: contextEngine({
        onPrepare: () => {
          order.push("context");
          return prepared();
        },
      }),
      admission: {
        admit: (input) => {
          order.push("admission");
          return Promise.resolve(allowedModelAdmission(input.request));
        },
      },
      boundary: {
        beforeExecute: () => {
          order.push("boundary");
          return Promise.resolve();
        },
      },
    }).advance(advanceInput());

    expect(order).toEqual(["context", "admission", "boundary", "model"]);
  });
});

describe("AgentLoop.advance() admission and boundary inputs", () => {
  it("executes the request admission approved, not the one it was given", async () => {
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "answer" }) }]);
    const adjusted = { ...turns, executor: turns.executor };

    const result = await loopWith({
      turns,
      admission: {
        admit: (input) => {
          // Admission restates the request — a clamped output ceiling, for instance. The frozen
          // contract carries the restatement back through `ALLOWED.request`.
          return Promise.resolve({
            kind: "ALLOWED" as const,
            request: { ...input.request, settings: { maxOutputTokens: 7 } },
          });
        },
      },
    }).advance(advanceInput());

    expect(result.kind).toBe("FINAL_CANDIDATE");
    expect(adjusted.callCount()).toBe(1);
    // The provider call uses the admitted request, not the original.
    expect(turns.requests()).toHaveLength(1);
    expect((turns.requests()[0] as { settings?: { maxOutputTokens?: number } }).settings).toEqual({
      maxOutputTokens: 7,
    });
  });

  it("gives the durable boundary the model ref and never the request", async () => {
    const seen: ModelTurnBoundaryInput[] = [];
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "answer" }) }]);

    const result = await loopWith({
      turns,
      boundary: {
        beforeExecute: (input) => {
          seen.push(input);
          return Promise.resolve();
        },
      },
    }).advance(advanceInput());

    expect(result.kind).toBe("FINAL_CANDIDATE");
    expect(seen).toHaveLength(1);
    // The model identity is not the full descriptor, and the request is not part of the contract.
    expect(seen[0]?.model).toEqual(MODEL.ref);
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(["identity", "model", "turn"]);
    expect(seen[0]).not.toHaveProperty("request");
  });
});

describe("AgentLoop.advance() context overflow recovery", () => {
  it("performs exactly one forced recovery and one extra provider attempt", async () => {
    let attempt = 0;
    const turns = modelTurns(() => {
      attempt += 1;
      return attempt === 1
        ? {
            kind: "FAILED",
            error: { code: "CONTEXT_OVERFLOW", message: "too big", retryable: false },
          }
        : { kind: "COMPLETED", result: turnResult({ text: "recovered" }) };
    });
    const modes: string[] = [];
    const context = contextEngine({
      onPrepare: (input) => {
        modes.push(input.mode);
        return prepared();
      },
    });

    const result = await loopWith({ context, turns }).advance(advanceInput());

    expect(result.kind).toBe("FINAL_CANDIDATE");
    expect(modes).toEqual(["NORMAL", "FORCED_RECOVERY"]);
    // Two provider attempts, never a third.
    expect(turns.callCount()).toBe(2);
    // The recovery resends a request rebuilt from the recovered context, not the rejected one.
    expect(turns.requests()).toHaveLength(2);
    expect(turns.requests()[0]).not.toBe(turns.requests()[1]);
    // The receipt records that the context this Reason ran on was a forced recovery.
    if (result.kind !== "FINAL_CANDIDATE") throw new Error("expected final candidate");
    expect(result.context.recovery).toBe("FORCED_CONTEXT_RECOVERY");
  });

  it("records NONE for a turn that never needed recovery", async () => {
    const result = await loopWith({}).advance(advanceInput());

    if (result.kind !== "FINAL_CANDIDATE") throw new Error("expected final candidate");
    const receipt: AgentLoopContextReceipt = result.context;
    expect(receipt.recovery).toBe("NONE");
    expect(receipt.report).toEqual(REPORT);
    expect(receipt.observationPolicy).toEqual(POLICY);
  });

  it("fails as exhausted after a second overflow, with no third attempt", async () => {
    const turns = modelTurns([
      { kind: "FAILED", error: { code: "CONTEXT_OVERFLOW", message: "too big", retryable: false } },
    ]);
    const context = contextEngine({ onPrepare: () => prepared() });

    const result = await loopWith({ context, turns }).advance(advanceInput());

    expect(result.kind).toBe("FAILED");
    if (result.kind !== "FAILED") throw new Error("expected failure");
    expect(result.error.code).toBe("CONTEXT_EXHAUSTED");
    expect(result.context?.recovery).toBe("FORCED_CONTEXT_RECOVERY");
    expect(turns.callCount()).toBe(2);
  });

  it("does not spend a second attempt when the engine rejects the forced recovery", async () => {
    const turns = modelTurns([
      { kind: "FAILED", error: { code: "CONTEXT_OVERFLOW", message: "too big", retryable: false } },
    ]);
    // The engine reports that it cannot compact by rejecting the forced preparation, which is the
    // only honest answer: a context that does not fit must never be returned as "recovered".
    const context = contextEngine({
      onPrepare: (input) => {
        if (input.mode === "FORCED_RECOVERY") {
          throw Object.assign(new Error("cannot compact"), { name: "ContextExhaustedError" });
        }
        return prepared();
      },
    });

    const result = await loopWith({ context, turns }).advance(advanceInput());

    expect(result.kind).toBe("FAILED");
    if (result.kind !== "FAILED") throw new Error("expected failure");
    expect(result.error.code).toBe("CONTEXT_EXHAUSTED");
    // One provider attempt only: resending the same context would be an identical call.
    expect(turns.callCount()).toBe(1);
  });
});

describe("AgentLoop.advance() tool result validation", () => {
  const pending = {
    type: "TOOL_CALLS_REQUESTED" as const,
    modelTurn: {
      callId: "llm_0195f3a0-0000-7000-8000-000000000000",
      model: MODEL.ref,
      finishReason: "TOOL_CALLS" as const,
      assistantMessage: {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call_a",
            toolName: "read_file",
            input: { path: "a.ts" },
          },
          {
            type: "tool-call" as const,
            toolCallId: "call_b",
            toolName: "read_file",
            input: { path: "b.ts" },
          },
        ],
      },
    },
    toolRequests: [
      { externalCallId: "call_a", toolName: "read_file", args: { path: "a.ts" } },
      { externalCallId: "call_b", toolName: "read_file", args: { path: "b.ts" } },
    ],
  };

  function result(toolCallId: string, toolName = "read_file") {
    return {
      role: "tool" as const,
      toolCallId,
      toolName,
      content: `data:${toolCallId}`,
      isError: false,
    };
  }

  function toolTurn(results: readonly ReturnType<typeof result>[]): AgentLoopAdvanceInput["input"] {
    return {
      kind: "TOOL_RESULTS",
      sourceStepId: TURN.stepId,
      pendingDecision: pending,
      toolResultMessageIds: results.map((entry) => agentMessageId(`result-${entry.toolCallId}`)),
    };
  }

  /**
   * Every invalid batch must fail before the loop does any work at all.
   *
   * The four counters are the point: an invalid turn is a protocol statement about the caller's
   * own bookkeeping, so it must cost no context build, no admission decision, no durable commit
   * and no provider call.
   */
  async function expectRefusedBeforeWork(input: AgentLoopAdvanceInput["input"]): Promise<void> {
    const context = contextEngine({});
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "never" }) }]);
    let boundaryCalls = 0;

    const outcome = await loopWith({
      context,
      turns,
      boundary: {
        beforeExecute: () => {
          boundaryCalls += 1;
          return Promise.resolve();
        },
      },
    }).advance(advanceInput({ input }));

    expect(outcome.kind).toBe("FAILED");
    if (outcome.kind !== "FAILED") throw new Error("expected failure");
    expect(outcome.error.code).toBe("TOOL_OUTPUT_ERROR");
    expect(outcome.messagesToAppend).toEqual([]);
    expect(context.inputs()).toHaveLength(0);
    expect(boundaryCalls).toBe(0);
    expect(turns.callCount()).toBe(0);
  }

  it("refuses a wrong result count before any port is called", async () => {
    await expectRefusedBeforeWork(toolTurn([result("call_a")]));
  });

  it("refuses a duplicate durable Tool-result ID before any port is called", async () => {
    await expectRefusedBeforeWork({
      kind: "TOOL_RESULTS",
      sourceStepId: TURN.stepId,
      pendingDecision: pending,
      toolResultMessageIds: [agentMessageId("result-call_a"), agentMessageId("result-call_a")],
    });
  });

  it("refuses an invalid durable Tool-result ID before any port is called", async () => {
    await expectRefusedBeforeWork({
      kind: "TOOL_RESULTS",
      sourceStepId: TURN.stepId,
      pendingDecision: pending,
      toolResultMessageIds: [agentMessageId("result-call_a"), agentMessageId("")],
    });
  });

  it("refuses a duplicate result ID", async () => {
    await expectRefusedBeforeWork(toolTurn([result("call_a"), result("call_a")]));
  });

  it("refuses an extra result beyond the requested calls", async () => {
    await expectRefusedBeforeWork(
      toolTurn([result("call_a"), result("call_b"), result("call_extra")]),
    );
  });

  it("accepts a complete batch and reasons from it in request order", async () => {
    const context = contextEngine({});
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "done" }) }]);

    const outcome = await loopWith({ context, turns }).advance(
      advanceInput({ input: toolTurn([result("call_a"), result("call_b")]) }),
    );

    expect(outcome.kind).toBe("FINAL_CANDIDATE");
    // The context engine saw the turn exactly once, and the batch reached it in request order.
    expect(context.inputs()).toHaveLength(1);
    expect(context.inputs()[0]?.input).toMatchObject({ kind: "TOOL_RESULTS" });
    expect(turns.callCount()).toBe(1);
  });
});

describe("AgentLoop.advance() cancellation", () => {
  it("returns CANCELLED with no work when the signal is already aborted", async () => {
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "never" }) }]);
    const controller = new AbortController();
    controller.abort();

    const result = await loopWith({ turns }).advance(advanceInput({ signal: controller.signal }));

    expect(result).toEqual({ kind: "CANCELLED", turn: TURN, messagesToAppend: [] });
    expect(turns.callCount()).toBe(0);
  });

  it("returns CANCELLED when the model turn reports cancellation", async () => {
    const turns = modelTurns([{ kind: "CANCELLED" }]);

    const result = await loopWith({ turns }).advance(advanceInput());

    expect(result.kind).toBe("CANCELLED");
    expect(result).toMatchObject({ turn: TURN, messagesToAppend: [] });
  });

  it("returns CANCELLED when the context engine fails on an aborted signal", async () => {
    const controller = new AbortController();
    const context = contextEngine({
      fail: () => {
        controller.abort();
        return new Error("cancelled");
      },
    });

    const result = await loopWith({ context }).advance(advanceInput({ signal: controller.signal }));

    expect(result).toEqual({ kind: "CANCELLED", turn: TURN, messagesToAppend: [] });
  });
});

describe("AgentLoop.advance() context boundary", () => {
  it("sends the frozen context input and nothing else", async () => {
    const context = contextEngine({});

    await loopWith({ context }).advance(advanceInput({ tools: [] }));

    const received = context.inputs()[0]!;
    expect(Object.keys(received).sort()).toEqual([
      "conversation",
      "identity",
      "input",
      "mode",
      "model",
      "signal",
      "tools",
      "turn",
    ]);
    // The exclusions are the point: a general kernel carries no host environment.
    expect(received).not.toHaveProperty("cwd");
    expect(received).not.toHaveProperty("workspace");
    expect(received).not.toHaveProperty("project");
    expect(received).not.toHaveProperty("git");
    expect(received).not.toHaveProperty("verificationPlan");
    expect(received).not.toHaveProperty("runtime");
  });

  it("passes the caller conversation snapshot and turn through unchanged", async () => {
    const context = contextEngine({});

    await loopWith({ context }).advance(
      advanceInput({
        turn: createAgentTurnRef("stp_0195f3a0-0000-7000-8000-000000000000" as StepId, 7),
      }),
    );

    expect(context.inputs()[0]?.conversation).toBe(CONVERSATION);
    expect(context.inputs()[0]?.turn.sequence).toBe(7);
    expect(context.inputs()[0]?.identity).toBe(IDENTITY);
  });

  it("carries modelSettings under its frozen name and no stream sink", async () => {
    const context = contextEngine({});
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "answer" }) }]);

    await loopWith({ context, turns }).advance(
      advanceInput({ modelSettings: { maxOutputTokens: 42 } }),
    );

    expect((turns.requests()[0] as { settings?: unknown }).settings).toEqual({
      maxOutputTokens: 42,
    });
  });
});
