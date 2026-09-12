import { describe, expect, it } from "vitest";
import { createModelTurnExecutor } from "../src/model-turn-executor.js";
import type { AIGateway, AIModelRequest, AIModelTurnResult, AIStream, AIStreamEvent } from "@caelush/ai";

const CALL_ID = "llm_0195f3a0-0000-7000-8000-000000000000" as never;

const REQUEST: AIModelRequest = {
  model: { provider: "test", model: "model-a" },
  messages: [{ role: "user", content: "hello" }],
};

const RESOLUTION = {
  api: "test-api",
  reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
  cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
} as const;

function start(): AIStreamEvent {
  return {
    type: "stream.start",
    payload: {
      callId: CALL_ID,
      providerId: "test",
      model: { provider: "test", model: "model-a" },
      resolution: RESOLUTION as never,
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
    stream(request: AIModelRequest, options?: { readonly signal?: AbortSignal }): Promise<AIStream> {
      calls += 1;
      requests.push(request);
      if (options?.signal !== undefined) signals.push(options.signal);
      return Promise.resolve({
        callId: CALL_ID,
        events: (async function* generate(): AsyncGenerator<AIStreamEvent> {
          for (const event of script) yield event;
        })(),
      });
    },
    async complete(): Promise<AIModelTurnResult> {
      throw new Error("complete() must not be used by the agent model turn path");
    },
  };

  return { gateway: stub, callCount: () => calls, requests: () => requests, signals: () => signals };
}

function textTurn(text: string): readonly AIStreamEvent[] {
  return [start(), { type: "text.delta", payload: { text } }, { type: "stream.finish", payload: { finishReason: "STOP" } }];
}

describe("ModelTurnExecutor", () => {
  it("executes one stream and returns the assembled turn result", async () => {
    const fake = gateway(textTurn("hello"));
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    const result = await executor.execute({
      request: REQUEST,
      signal: new AbortController().signal,
    });

    expect(result.text).toBe("hello");
    expect(result.finishReason).toBe("STOP");
    expect(result.providerId).toBe("test");
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

    const result = await executor.execute({
      request: REQUEST,
      signal: new AbortController().signal,
    });

    expect(result.usage).toEqual({ inputTokens: 9 });
    expect(result.resolution.api).toBe("test-api");
  });

  it("returns completed tool calls", async () => {
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

    const result = await executor.execute({
      request: REQUEST,
      signal: new AbortController().signal,
    });

    expect(result.toolCalls).toEqual([{ id: "c1", name: "read_file", input: { path: "a.ts" } }]);
    expect(result.finishReason).toBe("TOOL_CALLS");
  });

  it("forwards every event to the transient sink in order", async () => {
    const fake = gateway([
      start(),
      { type: "text.delta", payload: { text: "a" } },
      { type: "reasoning.summary.delta", payload: { text: "thinking" } },
      { type: "text.delta", payload: { text: "b" } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });
    const seen: string[] = [];

    const result = await executor.execute({
      request: REQUEST,
      signal: new AbortController().signal,
      sink: {
        onEvent: (event) => {
          seen.push(event.type);
        },
      },
    });

    expect(seen).toEqual([
      "stream.start",
      "text.delta",
      "reasoning.summary.delta",
      "text.delta",
      "stream.finish",
    ]);
    // A reasoning summary is transient: it never becomes durable assistant text.
    expect(result.text).toBe("ab");
    expect(JSON.stringify(result)).not.toContain("thinking");
  });

  it("rejects with AI_ABORTED for an aborted stream", async () => {
    const fake = gateway([
      start(),
      { type: "text.delta", payload: { text: "partial" } },
      {
        type: "stream.error",
        payload: { error: { code: "AI_ABORTED", message: "aborted", retryable: false } },
      },
    ]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    await expect(
      executor.execute({ request: REQUEST, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "AI_ABORTED", retryable: false });
  });

  it.each(["AI_NETWORK", "AI_RATE_LIMIT", "AI_TIMEOUT"] as const)(
    "rejects with a retryable %s and performs no retry",
    async (code) => {
      const fake = gateway([
        start(),
        { type: "stream.error", payload: { error: { code, message: "failed", retryable: true } } },
      ]);
      const executor = createModelTurnExecutor({ gateway: fake.gateway });

      await expect(
        executor.execute({ request: REQUEST, signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code, retryable: true });
      // Exactly one gateway invocation: retry authority belongs to the run layer.
      expect(fake.callCount()).toBe(1);
    },
  );

  it("never produces a result for a partial tool call", async () => {
    const fake = gateway([
      start(),
      { type: "tool_call.start", payload: { toolCallId: "c1", toolName: "read_file" } },
      { type: "tool_call.delta", payload: { toolCallId: "c1", delta: '{"path"' } },
      {
        type: "stream.error",
        payload: { error: { code: "AI_NETWORK", message: "reset", retryable: true } },
      },
    ]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    await expect(
      executor.execute({ request: REQUEST, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "AI_NETWORK" });
  });

  it("never produces a result for an unfinished stream", async () => {
    const fake = gateway([start(), { type: "text.delta", payload: { text: "x" } }]);
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    await expect(
      executor.execute({ request: REQUEST, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
  });

  it("propagates a preflight rejection from the gateway", async () => {
    const stub: AIGateway = {
      stream: () => Promise.reject(Object.assign(new Error("bad"), { code: "AI_PROVIDER_NOT_FOUND" })),
      complete: () => Promise.reject(new Error("unused")),
    };
    const executor = createModelTurnExecutor({ gateway: stub });

    await expect(
      executor.execute({ request: REQUEST, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "AI_PROVIDER_NOT_FOUND" });
  });

  it("forwards the caller signal unchanged", async () => {
    const fake = gateway(textTurn("x"));
    const executor = createModelTurnExecutor({ gateway: fake.gateway });
    const controller = new AbortController();

    await executor.execute({ request: REQUEST, signal: controller.signal });

    expect(fake.signals()[0]).toBe(controller.signal);
  });

  it("passes the request through unchanged", async () => {
    const fake = gateway(textTurn("x"));
    const executor = createModelTurnExecutor({ gateway: fake.gateway });

    await executor.execute({ request: REQUEST, signal: new AbortController().signal });

    expect(fake.requests()[0]).toBe(REQUEST);
  });
});
