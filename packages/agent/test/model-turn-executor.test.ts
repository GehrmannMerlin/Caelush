import { describe, expect, it } from "vitest";
import { createModelTurnExecutor } from "../src/loop/turn/model-turn-executor.js";
import type {
  AgentExecutionIdentity,
  AgentTransientStreamEvent,
  AgentTurnRef,
  ModelTurnBoundaryPort,
  ModelTurnExecutionResult,
} from "../src/index.js";
import { createAgentTurnRef } from "../src/index.js";
import type {
  AIGateway,
  AIModelRequest,
  AIModelTurnResult,
  AIStream,
  AIStreamEvent,
} from "@caelush/ai";
import type { RunId, SessionId, StepId } from "@caelush/protocol";

/**
 * Frozen `ModelTurnExecutor` contract guards.
 *
 * Phase 3A aligned the executor with the frozen union result. These tests prove the three
 * properties that matter: it never throws for a model outcome, it performs exactly one
 * gateway invocation, and only the three delta kinds reach the transient sink.
 */

const CALL_ID = "llm_0195f3a0-0000-7000-8000-000000000000";

const REQUEST: AIModelRequest = {
  model: { provider: "test", model: "model-a" },
  messages: [{ role: "user", content: "hello" }],
};

const IDENTITY: AgentExecutionIdentity = {
  runId: "run_0195f3a0-0000-7000-8000-000000000000" as RunId,
  sessionId: "ses_0195f3a0-0000-7000-8000-000000000000" as SessionId,
  goal: "prove the frozen turn contract",
};

const TURN: AgentTurnRef = createAgentTurnRef(
  "stp_0195f3a0-0000-7000-8000-000000000000" as StepId,
  1,
);

const RESOLUTION = {
  api: "test-api",
  reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
  cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
} as const;

function start(): AIStreamEvent {
  return {
    type: "stream.start",
    payload: {
      callId: CALL_ID as never,
      providerId: "test",
      model: { provider: "test", model: "model-a" },
      resolution: RESOLUTION as never,
    },
  };
}

function errorEvent(code: string, retryable: boolean, retryAfterMs?: number): AIStreamEvent {
  return {
    type: "stream.error",
    payload: {
      error: {
        code,
        message: "provider failure",
        retryable,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      } as never,
    },
  };
}

/** A gateway that replays a fixed event script and counts invocations. */
function gateway(script: readonly AIStreamEvent[]): {
  readonly gateway: AIGateway;
  callCount(): number;
  requests(): readonly AIModelRequest[];
  signals(): readonly AbortSignal[];
} {
  const requests: AIModelRequest[] = [];
  const signals: AbortSignal[] = [];
  let calls = 0;

  const stub: AIGateway = {
    stream(
      request: AIModelRequest,
      options?: { readonly signal?: AbortSignal },
    ): Promise<AIStream> {
      calls += 1;
      requests.push(request);
      if (options?.signal !== undefined) signals.push(options.signal);
      return Promise.resolve({
        callId: CALL_ID as never,
        events: (async function* generate(): AsyncGenerator<AIStreamEvent> {
          for (const event of script) yield event;
        })(),
      });
    },
    async complete(): Promise<AIModelTurnResult> {
      throw new Error("complete() must not be used by the agent model turn path");
    },
  };

  return {
    gateway: stub,
    callCount: () => calls,
    requests: () => requests,
    signals: () => signals,
  };
}

function textTurn(text: string): readonly AIStreamEvent[] {
  return [
    start(),
    { type: "text.delta", payload: { text } },
    { type: "stream.finish", payload: { finishReason: "STOP" } },
  ];
}

function input(
  overrides: Partial<Parameters<ReturnType<typeof createModelTurnExecutor>["execute"]>[0]> = {},
) {
  return {
    identity: IDENTITY,
    turn: TURN,
    request: REQUEST,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Unwrap the frozen union the way a durable caller does. */
function completed(result: ModelTurnExecutionResult): AIModelTurnResult {
  if (result.kind !== "COMPLETED") {
    throw new Error(`expected COMPLETED, received ${result.kind}`);
  }
  return result.result;
}

describe("ModelTurnExecutor frozen result contract", () => {
  it("resolves COMPLETED with the assembled turn result", async () => {
    const fake = gateway(textTurn("hello"));
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    const result = await executor.execute(input());

    expect(result.kind).toBe("COMPLETED");
    expect(completed(result).text).toBe("hello");
    expect(completed(result).finishReason).toBe("STOP");
    expect(completed(result).providerId).toBe("test");
    expect(fake.callCount()).toBe(1);
  });

  it("preserves usage and resolution", async () => {
    const fake = gateway([
      start(),
      { type: "text.delta", payload: { text: "x" } },
      { type: "usage", payload: { inputTokens: 3 } },
      { type: "stream.finish", payload: { finishReason: "STOP", finalUsage: { inputTokens: 9 } } },
    ]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    const result = completed(await executor.execute(input()));

    expect(result.usage).toEqual({ inputTokens: 9 });
    expect(result.resolution.api).toBe("test-api");
  });

  it("returns completed tool calls and never a partial one", async () => {
    const fake = gateway([
      start(),
      { type: "tool_call.start", payload: { toolCallId: "c1", toolName: "read_file" } },
      { type: "tool_call.delta", payload: { toolCallId: "c1", delta: '{"path"' } },
      {
        type: "tool_call.completed",
        payload: { id: "c1", name: "read_file", input: { path: "a.ts" } },
      },
      { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } },
    ]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    const result = completed(await executor.execute(input()));

    expect(result.toolCalls).toEqual([{ id: "c1", name: "read_file", input: { path: "a.ts" } }]);
    expect(result.finishReason).toBe("TOOL_CALLS");
  });

  it("forwards the caller signal and the request unchanged", async () => {
    const fake = gateway(textTurn("x"));
    const executor = createModelTurnExecutor({ gateway: fake.gateway });
    const controller = new AbortController();

    await executor.execute(input({ signal: controller.signal }));

    expect(fake.signals()[0]).toBe(controller.signal);
    expect(fake.requests()[0]).toBe(REQUEST);
  });

  it("never invokes the gateway twice for one execute", async () => {
    const fake = gateway([start(), errorEvent("AI_NETWORK", true)]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    await executor.execute(input());

    // Retry policy belongs to the durable Run layer, so a failed turn must not be
    // silently re-sent by the executor.
    expect(fake.callCount()).toBe(1);
  });
});

describe("ModelTurnExecutor transient stream", () => {
  function collectingSink(): {
    readonly sink: { publish(event: AgentTransientStreamEvent): void };
    events(): readonly AgentTransientStreamEvent[];
  } {
    const events: AgentTransientStreamEvent[] = [];
    return {
      sink: { publish: (event) => void events.push(event) },
      events: () => events,
    };
  }

  it("publishes text deltas in order", async () => {
    const fake = gateway([
      start(),
      { type: "text.delta", payload: { text: "a" } },
      { type: "text.delta", payload: { text: "b" } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });
    const collected = collectingSink();

    const result = completed(await executor.execute(input({ streamSink: collected.sink })));

    expect(collected.events()).toEqual([
      { type: "text.delta", text: "a" },
      { type: "text.delta", text: "b" },
    ]);
    expect(result.text).toBe("ab");
  });

  it("publishes a reasoning summary as a transient thinking delta only", async () => {
    const fake = gateway([
      start(),
      { type: "reasoning.summary.delta", payload: { text: "thinking" } },
      { type: "text.delta", payload: { text: "answer" } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });
    const collected = collectingSink();

    const result = completed(await executor.execute(input({ streamSink: collected.sink })));

    expect(collected.events()).toEqual([
      { type: "thinking.delta", text: "thinking" },
      { type: "text.delta", text: "answer" },
    ]);
    // A reasoning summary is display-only: it is never durable assistant content.
    expect(result.text).toBe("answer");
    expect(JSON.stringify(result)).not.toContain("thinking");
  });

  it("publishes tool-call argument deltas", async () => {
    const fake = gateway([
      start(),
      { type: "tool_call.start", payload: { toolCallId: "c1", toolName: "read_file" } },
      { type: "tool_call.delta", payload: { toolCallId: "c1", delta: '{"path"' } },
      { type: "tool_call.delta", payload: { toolCallId: "c1", delta: ':"a.ts"}' } },
      {
        type: "tool_call.completed",
        payload: { id: "c1", name: "read_file", input: { path: "a.ts" } },
      },
      { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } },
    ]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });
    const collected = collectingSink();

    await executor.execute(input({ streamSink: collected.sink }));

    expect(collected.events()).toEqual([
      { type: "tool_call.delta", toolCallId: "c1", delta: '{"path"' },
      { type: "tool_call.delta", toolCallId: "c1", delta: ':"a.ts"}' },
    ]);
  });

  it("never publishes envelope, usage or tool-call lifecycle events", async () => {
    const fake = gateway([
      start(),
      { type: "usage", payload: { inputTokens: 1 } },
      { type: "tool_call.start", payload: { toolCallId: "c1", toolName: "read_file" } },
      {
        type: "tool_call.completed",
        payload: { id: "c1", name: "read_file", input: { path: "a.ts" } },
      },
      { type: "text.delta", payload: { text: "x" } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });
    const collected = collectingSink();

    await executor.execute(input({ streamSink: collected.sink }));

    // stream.start, usage, tool_call.start, tool_call.completed and stream.finish are
    // envelope, accounting and durable-lifecycle events. Only the transient deltas cross.
    expect(collected.events()).toEqual([{ type: "text.delta", text: "x" }]);
  });

  it("isolates a synchronous and an asynchronous sink failure from the result", async () => {
    const fake = gateway(textTurn("answer"));
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    const throwing = await executor.execute(
      input({
        streamSink: {
          publish: () => {
            throw new Error("presentation failure");
          },
        },
      }),
    );
    expect(completed(throwing).text).toBe("answer");

    const rejecting = await executor.execute(
      input({ streamSink: { publish: () => Promise.reject(new Error("presentation failure")) } }),
    );
    expect(completed(rejecting).text).toBe("answer");
  });
});

describe("ModelTurnExecutor failure mapping", () => {
  it.each([
    ["AI_AUTHENTICATION", "AUTHENTICATION", false],
    ["AI_RATE_LIMIT", "RATE_LIMIT", true],
    ["AI_NETWORK", "NETWORK", true],
    ["AI_TIMEOUT", "TIMEOUT", true],
    ["AI_CONTEXT_OVERFLOW", "CONTEXT_OVERFLOW", false],
    ["AI_PROVIDER_ERROR", "PROVIDER_ERROR", false],
    ["AI_INVALID_RESPONSE", "INVALID_RESPONSE", false],
    ["AI_MODEL_UNSUPPORTED", "UNSUPPORTED_MODEL", false],
    ["AI_MODEL_METADATA_INCOMPLETE", "UNSUPPORTED_MODEL", false],
    ["AI_CAPABILITY_UNSUPPORTED", "UNSUPPORTED_CAPABILITY", false],
  ])("maps %s to FAILED/%s with retryable=%s", async (aiCode, code, retryable) => {
    const fake = gateway([start(), errorEvent(aiCode, retryable)]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    const result = await executor.execute(input());

    expect(result.kind).toBe("FAILED");
    if (result.kind !== "FAILED") throw new Error("expected FAILED");
    expect(result.error.code).toBe(code);
    expect(result.error.retryable).toBe(retryable);
    // Exactly one gateway invocation: a failure is never retried here.
    expect(fake.callCount()).toBe(1);
  });

  it("preserves a safe retry-after hint", async () => {
    const fake = gateway([start(), errorEvent("AI_RATE_LIMIT", true, 2_500)]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    const result = await executor.execute(input());

    expect(result).toMatchObject({
      kind: "FAILED",
      error: { code: "RATE_LIMIT", retryable: true, retryAfterMs: 2_500 },
    });
  });

  it("resolves FAILED rather than throwing for a preflight rejection", async () => {
    const stub: AIGateway = {
      stream: () =>
        Promise.reject(
          Object.assign(new Error("bad"), { code: "AI_PROVIDER_NOT_FOUND", retryable: false }),
        ),
      complete: () => Promise.reject(new Error("unused")),
    };
    const executor = createModelTurnExecutor({ gateway: stub });

    const result = await executor.execute(input());

    expect(result.kind).toBe("FAILED");
    if (result.kind !== "FAILED") throw new Error("expected FAILED");
    expect(result.error.code).toBe("PROVIDER_ERROR");
  });

  it("resolves FAILED for an unfinished stream", async () => {
    const fake = gateway([start(), { type: "text.delta", payload: { text: "x" } }]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    const result = await executor.execute(input());

    expect(result).toMatchObject({ kind: "FAILED", error: { code: "INVALID_RESPONSE" } });
  });

  it("resolves FAILED for a non-AI throw and leaks no raw text", async () => {
    const stub: AIGateway = {
      stream: () => Promise.reject(new Error("CAELUSH_RAW_PROVIDER_BODY_SECRET")),
      complete: () => Promise.reject(new Error("unused")),
    };
    const executor = createModelTurnExecutor({ gateway: stub });

    const result = await executor.execute(input());

    expect(result).toMatchObject({ kind: "FAILED", error: { code: "PROVIDER_ERROR" } });
    expect(JSON.stringify(result)).not.toContain("CAELUSH_RAW_PROVIDER_BODY_SECRET");
  });
});

describe("ModelTurnExecutor cancellation", () => {
  it("resolves CANCELLED for a stream error carrying AI_ABORTED", async () => {
    const fake = gateway([
      start(),
      { type: "text.delta", payload: { text: "partial" } },
      errorEvent("AI_ABORTED", false),
    ]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    const result = await executor.execute(input());

    expect(result).toEqual({ kind: "CANCELLED" });
  });

  it("resolves CANCELLED and performs zero provider calls when already aborted", async () => {
    const fake = gateway(textTurn("never sent"));
    const executor = createModelTurnExecutor({ gateway: fake.gateway });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(input({ signal: controller.signal }));

    expect(result).toEqual({ kind: "CANCELLED" });
    expect(fake.callCount()).toBe(0);
  });

  it("resolves CANCELLED for an abort raised while the stream is being consumed", async () => {
    const controller = new AbortController();
    const stub: AIGateway = {
      stream: () =>
        Promise.resolve({
          callId: CALL_ID as never,
          events: (async function* generate(): AsyncGenerator<AIStreamEvent> {
            yield start();
            controller.abort();
            throw Object.assign(new Error("aborted"), { code: "AI_ABORTED", retryable: false });
          })(),
        }),
      complete: () => Promise.reject(new Error("unused")),
    };
    const executor = createModelTurnExecutor({ gateway: stub });

    const result = await executor.execute(input({ signal: controller.signal }));

    expect(result).toEqual({ kind: "CANCELLED" });
  });
});

describe("AgentTurnRef invariants", () => {
  it("rejects a sequence below one", () => {
    expect(() =>
      createAgentTurnRef("stp_0195f3a0-0000-7000-8000-000000000000" as StepId, 0),
    ).toThrow(/sequence must be a safe integer >= 1/);
  });

  it("rejects a non-integer sequence", () => {
    expect(() =>
      createAgentTurnRef("stp_0195f3a0-0000-7000-8000-000000000000" as StepId, 1.5),
    ).toThrow(/sequence must be a safe integer >= 1/);
  });

  it("accepts the first turn of a Run", () => {
    expect(createAgentTurnRef("stp_0195f3a0-0000-7000-8000-000000000000" as StepId, 1)).toEqual({
      stepId: "stp_0195f3a0-0000-7000-8000-000000000000",
      sequence: 1,
    });
  });
});

describe("ModelTurnBoundaryPort contract", () => {
  /**
   * The frozen invariant this port exists for:
   *
   * ```text
   * Durable Step commit MUST succeed
   *        ↓
   * only then may Provider I/O begin
   * ```
   *
   * Phase 3A defines and tests the contract. The real Run wiring lands in the next phase,
   * so this test drives the documented order directly.
   */
  async function executeWithBoundary(
    boundary: ModelTurnBoundaryPort,
  ): Promise<{ readonly gatewayCalls: number; readonly result?: ModelTurnExecutionResult }> {
    const fake = gateway(textTurn("unreachable"));
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    // The boundary is the first thing a loop calls, and a rejection ends the turn before
    // the executor is ever reached.
    await boundary.beforeExecute({
      identity: IDENTITY,
      turn: TURN,
      request: REQUEST,
      model: {
        ref: REQUEST.model,
        api: "test-api",
        limits: { contextWindowTokens: 1_000, maxOutputTokens: 100 },
        capabilities: {
          streaming: "SUPPORTED",
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
      },
    });
    const result = await executor.execute(input());
    return { gatewayCalls: fake.callCount(), result };
  }

  it("performs zero provider calls when the durable commit fails", async () => {
    const committing: ModelTurnBoundaryPort = {
      beforeExecute: () => Promise.reject(new Error("durable commit failed")),
    };

    await expect(executeWithBoundary(committing)).rejects.toThrow("durable commit failed");
  });

  it("performs exactly one provider call when the durable commit succeeds", async () => {
    let commits = 0;
    const committing: ModelTurnBoundaryPort = {
      beforeExecute: () => {
        commits += 1;
        return Promise.resolve();
      },
    };

    const { gatewayCalls, result } = await executeWithBoundary(committing);

    expect(commits).toBe(1);
    expect(gatewayCalls).toBe(1);
    expect(result?.kind).toBe("COMPLETED");
  });
});
