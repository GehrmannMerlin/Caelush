import { describe, expect, it } from "vitest";
import { createAgentLoop, createAgentTurnRef, ALLOWED_MODEL_ADMISSION } from "../src/index.js";
import type {
  AgentDecision,
  AgentExecutionIdentity,
  AgentLoopAdvanceInput,
  AgentLoopAdvanceResult,
  AgentModelAdmissionDecision,
  AgentTurnInput,
  ContextEnginePort,
  ContextPrepareInput,
  ModelTurnBoundaryPort,
  ModelTurnExecutionResult,
  ModelTurnExecutor,
  PreparedModelContext,
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

function userTurn(content = "hello"): AgentTurnInput {
  return { kind: "USER_INPUT", messages: [{ role: "user", content }] };
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
        return (
          options.context ?? {
            messages: [{ role: "user", content: "prepared" }],
            report: { prepared: true },
          }
        );
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
    history: [],
    model: MODEL,
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function loopWith(options: {
  readonly context?: ReturnType<typeof contextEngine>;
  readonly turns?: ReturnType<typeof modelTurns>;
  readonly admission?: { admit: () => Promise<AgentModelAdmissionDecision> };
  readonly boundary?: ModelTurnBoundaryPort;
}) {
  return createAgentLoop({
    contextEngine: (options.context ?? contextEngine({})).engine,
    modelTurnExecutor: (
      options.turns ?? modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "answer" }) }])
    ).executor,
    ...(options.admission === undefined
      ? {}
      : { modelAdmission: { admit: options.admission.admit } as never }),
    ...(options.boundary === undefined ? {} : { modelTurnBoundary: options.boundary }),
  });
}

function decisionOf(result: AgentLoopAdvanceResult): AgentDecision {
  if (result.status !== "COMPLETED") {
    throw new Error(`expected COMPLETED, received ${result.status}`);
  }
  return result.decision;
}

describe("AgentLoop.advance() one Reason", () => {
  it("turns a user input with tool calls into TOOL_CALLS_REQUESTED", async () => {
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

    const decision = decisionOf(result);
    expect(decision.type).toBe("TOOL_CALLS_REQUESTED");
    // The loop never executes a tool: it reports the request and stops.
    expect(turns.callCount()).toBe(1);
    if (result.status !== "COMPLETED") throw new Error("expected completion");
    expect(result.messagesToAppend.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.contextReport).toEqual({ prepared: true });
  });

  it("turns a plain answer into FINAL_CANDIDATE, never into completion", async () => {
    const result = await loopWith({}).advance(advanceInput());

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
          results: [
            {
              role: "tool",
              toolCallId: "call_a",
              toolName: "read_file",
              content: "data",
              isError: false,
            },
          ],
        },
      }),
    );

    expect(decisionOf(result).type).toBe("TOOL_CALLS_REQUESTED");
    if (result.status !== "COMPLETED") throw new Error("expected completion");
    expect(result.messagesToAppend.map((message) => message.role)).toEqual(["tool", "assistant"]);
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
          results: [
            {
              role: "tool",
              toolCallId: "call_a",
              toolName: "read_file",
              content: "data",
              isError: false,
            },
          ],
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
          messages: [{ role: "user", content: "the tests failed" }],
        },
      }),
    );

    expect(decisionOf(result).type).toBe("FINAL_CANDIDATE");
    if (result.status !== "COMPLETED") throw new Error("expected completion");
    expect(result.messagesToAppend.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("accepts a STEERING continuation as a contract with no special behaviour", async () => {
    const result = await loopWith({}).advance(
      advanceInput({ input: { kind: "CONTINUATION", reason: "STEERING" } }),
    );

    expect(result.status).toBe("COMPLETED");
  });
});

describe("AgentLoop.advance() failure stages", () => {
  it.each([["LENGTH"], ["CONTENT_FILTER"], ["OTHER"]])(
    "fails a %s turn as MODEL without a decision",
    async (finishReason) => {
      const turns = modelTurns([
        {
          kind: "COMPLETED",
          result: turnResult({ finishReason: finishReason as never, text: "partial" }),
        },
      ]);

      const result = await loopWith({ turns }).advance(advanceInput());

      expect(result.status).toBe("FAILED");
      if (result.status !== "FAILED") throw new Error("expected failure");
      expect(result.stage).toBe("MODEL");
      // The provider answered, so the turn is a completed provider attempt that produced no
      // usable decision.
      expect(result.providerTurnState).toBe("COMPLETED");
    },
  );

  it("fails a provider error as MODEL with a failed provider turn", async () => {
    const turns = modelTurns([
      { kind: "FAILED", error: { code: "NETWORK", message: "unreachable", retryable: true } },
    ]);

    const result = await loopWith({ turns }).advance(advanceInput());

    expect(result).toMatchObject({
      status: "FAILED",
      stage: "MODEL",
      error: { code: "NETWORK", retryable: true },
      providerTurnState: "FAILED",
    });
  });

  it("fails a context preparation error as CONTEXT with no provider call", async () => {
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "never" }) }]);
    const context = contextEngine({ fail: () => new Error("inspection failed") });

    const result = await loopWith({ context, turns }).advance(advanceInput());

    expect(result).toMatchObject({ status: "FAILED", stage: "CONTEXT" });
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

    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") throw new Error("expected failure");
    expect(result.stage).toBe("ADMISSION");
    expect(result.budgetBlock).toEqual({
      kind: "EXCEEDED",
      dimension: "TOKENS",
      accounted: 5,
      limit: 5,
    });
    // A refused turn reaches neither the durable boundary nor the provider.
    expect(boundaryCalls).toBe(0);
    expect(turns.callCount()).toBe(0);
  });

  it("performs no provider call when the durable boundary fails", async () => {
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "never" }) }]);

    const result = await loopWith({
      turns,
      boundary: { beforeExecute: () => Promise.reject(new Error("commit failed")) },
    }).advance(advanceInput());

    expect(result).toMatchObject({ status: "FAILED", stage: "BOUNDARY" });
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

    expect(result.status).toBe("COMPLETED");
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
          return { messages: [{ role: "user", content: "prepared" }] };
        },
      }),
      admission: {
        admit: () => {
          order.push("admission");
          return Promise.resolve(ALLOWED_MODEL_ADMISSION);
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
        return {
          messages: [{ role: "user", content: "prepared" }],
          ...(input.mode === "FORCED_RECOVERY" ? { recovered: true } : {}),
        };
      },
    });

    const result = await loopWith({ context, turns }).advance(advanceInput());

    expect(result.status).toBe("COMPLETED");
    expect(modes).toEqual(["NORMAL", "FORCED_RECOVERY"]);
    // Two provider attempts, never a third.
    expect(turns.callCount()).toBe(2);
    // The recovery resends a request rebuilt from the recovered context, not the rejected one.
    expect(turns.requests()).toHaveLength(2);
    expect(turns.requests()[0]).not.toBe(turns.requests()[1]);
  });

  it("fails as exhausted after a second overflow, with no third attempt", async () => {
    const turns = modelTurns([
      { kind: "FAILED", error: { code: "CONTEXT_OVERFLOW", message: "too big", retryable: false } },
    ]);
    const context = contextEngine({
      onPrepare: (input) => ({
        messages: [{ role: "user", content: "prepared" }],
        ...(input.mode === "FORCED_RECOVERY" ? { recovered: true } : {}),
      }),
    });

    const result = await loopWith({ context, turns }).advance(advanceInput());

    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") throw new Error("expected failure");
    expect(result.error.code).toBe("CONTEXT_OVERFLOW");
    expect(result.error.message).toContain("exhausted");
    expect(turns.callCount()).toBe(2);
  });

  it("does not spend a second attempt when the engine cannot recover", async () => {
    const turns = modelTurns([
      { kind: "FAILED", error: { code: "CONTEXT_OVERFLOW", message: "too big", retryable: false } },
    ]);
    // No `recovered` flag: the engine re-rendered the same context and cannot make it fit.
    const context = contextEngine({});

    const result = await loopWith({ context, turns }).advance(advanceInput());

    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") throw new Error("expected failure");
    expect(result.error.message).toContain("exhausted");
    // One provider attempt only: resending the same context would be an identical call.
    expect(turns.callCount()).toBe(1);
  });
});

describe("AgentLoop.advance() cancellation", () => {
  it("returns CANCELLED with no work when the signal is already aborted", async () => {
    const turns = modelTurns([{ kind: "COMPLETED", result: turnResult({ text: "never" }) }]);
    const controller = new AbortController();
    controller.abort();

    const result = await loopWith({ turns }).advance(advanceInput({ signal: controller.signal }));

    expect(result).toEqual({ status: "CANCELLED" });
    expect(turns.callCount()).toBe(0);
  });

  it("returns CANCELLED when the model turn reports cancellation", async () => {
    const turns = modelTurns([{ kind: "CANCELLED" }]);

    const result = await loopWith({ turns }).advance(advanceInput());

    expect(result).toEqual({ status: "CANCELLED" });
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

    expect(result).toEqual({ status: "CANCELLED" });
  });
});

describe("AgentLoop.advance() context boundary", () => {
  it("sends the frozen context input and nothing else", async () => {
    const context = contextEngine({});

    await loopWith({ context }).advance(advanceInput({ tools: [] }));

    const received = context.inputs()[0]!;
    expect(Object.keys(received).sort()).toEqual([
      "history",
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

  it("passes the caller history and turn through unchanged", async () => {
    const context = contextEngine({});
    const history = [{ role: "user" as const, content: "earlier" }];

    await loopWith({ context }).advance(
      advanceInput({
        history,
        turn: createAgentTurnRef("stp_0195f3a0-0000-7000-8000-000000000000" as StepId, 7),
      }),
    );

    expect(context.inputs()[0]?.history).toBe(history);
    expect(context.inputs()[0]?.turn.sequence).toBe(7);
    expect(context.inputs()[0]?.identity).toBe(IDENTITY);
  });
});
