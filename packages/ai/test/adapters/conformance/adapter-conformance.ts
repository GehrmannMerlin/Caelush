import { describe, expect, it } from "vitest";
import { createAISubsystem } from "../../../src/create-ai-subsystem.js";
import { modelDescriptor } from "../../support/fixtures.js";
import type { AdapterConformanceOptions, ConformanceRun, FinishReasonInput } from "./types.js";
import type { AIModelRequest } from "../../../src/request/model-request.js";
import type { AISubsystem } from "../../../src/create-ai-subsystem.js";
import type { AIStreamEvent } from "../../../src/stream/events.js";
import type { CapturingTransport } from "../../support/openai-compatible-transport.js";
import type { ModelDescriptor } from "../../../src/models/model-descriptor.js";
import type { EnumerableModelDescriptorSourcePort } from "../../../src/models/model-descriptor-source-port.js";
import type { ReasoningLevel } from "../../../src/reasoning/reasoning-level.js";
import type { CacheRetention } from "../../../src/cache/cache-retention.js";

const FINISH_CASES: readonly FinishReasonInput[] = [
  "STOP",
  "LENGTH",
  "TOOL_CALLS",
  "CONTENT_FILTER",
];

interface ModelOverrides {
  readonly reasoningLevels?: readonly ReasoningLevel[];
  readonly cacheRetentions?: readonly CacheRetention[];
}

/**
 * Run the reusable adapter conformance suite for one dialect.
 *
 * The suite drives the adapter through the real AI gateway over a controlled
 * transport and asserts the guarantees every dialect must provide: envelope
 * authority, tool lifecycle, finish and usage mapping, no retry, error mapping,
 * abort propagation, secret safety, and reasoning/cache translation or fail-closed.
 *
 * A dialect supplies its own wire scripts plus the two translation hooks, so Phase 2D
 * can run the same suite for a second dialect without changing this file.
 */
export function runAdapterConformance(options: AdapterConformanceOptions): void {
  const { apiId, providerId, endpoint, credentials, secret } = options;

  const descriptor = (overrides: ModelOverrides = {}): ModelDescriptor =>
    modelDescriptor({
      ref: { provider: providerId, model: "fixture-model" },
      api: apiId,
      ...(overrides.reasoningLevels === undefined
        ? {}
        : {
            reasoning: { supportedLevels: overrides.reasoningLevels, supportsSummary: "UNKNOWN" },
          }),
      ...(overrides.cacheRetentions === undefined
        ? {}
        : { cache: { supportedRetentions: overrides.cacheRetentions } }),
    });

  const subsystem = (
    transport: CapturingTransport,
    overrides: ModelOverrides = {},
  ): AISubsystem => {
    const model = descriptor(overrides);
    const source: EnumerableModelDescriptorSourcePort = {
      id: "conformance",
      priority: 0,
      resolve: (ref) =>
        ref.provider === providerId && ref.model === model.ref.model ? model : undefined,
      list: () => [model],
    };

    return createAISubsystem({
      modelSources: [source],
      providers: [
        {
          id: providerId,
          endpoint,
          defaultApi: apiId,
          allowUnknownModels: false,
          credentials: { resolve: () => Promise.resolve(credentials) },
          transport: { fetch: transport.fetch },
        },
      ],
      adapters: options.adapters,
    });
  };

  async function run(
    transport: CapturingTransport,
    overrides: ModelOverrides = {},
    request: Partial<AIModelRequest> = {},
  ): Promise<ConformanceRun> {
    const ai = subsystem(transport, overrides);
    const events: AIStreamEvent[] = [];
    let thrown: unknown;

    try {
      const stream = await ai.gateway.stream({
        model: { provider: providerId, model: "fixture-model" },
        messages: [{ role: "user", content: "hello" }],
        ...request,
      });
      for await (const event of stream.events) events.push(event);
    } catch (error) {
      thrown = error;
    }

    const terminal = events.at(-1);
    return {
      eventTypes: events.map((event) => event.type),
      events: events as unknown as ConformanceRun["events"],
      streamError: terminal?.type === "stream.error" ? terminal.payload.error : undefined,
      thrown,
      requests: transport.requests,
      transportAttempts: transport.callCount(),
    };
  }

  /** The captured provider request body, or a loud failure when none was sent. */
  function body(run_: ConformanceRun, index = 0): Record<string, unknown> {
    const request = run_.requests[index];
    if (request === undefined) throw new Error("no provider request was captured");
    return request.body;
  }

  function request_(run_: ConformanceRun, index = 0) {
    const request = run_.requests[index];
    if (request === undefined) throw new Error("no provider request was captured");
    return request;
  }

  describe(`${apiId} adapter conformance`, () => {
    describe("envelope authority", () => {
      it("starts, streams text and finishes in order", async () => {
        const result = await run(options.textTurn("conformance"));

        expect(result.eventTypes).toEqual(["stream.start", "text.delta", "stream.finish"]);
        expect(result.transportAttempts).toBe(1);
      });

      it("produces exactly one gateway envelope per stream", async () => {
        const result = await run(options.textTurn("x"));

        expect(result.eventTypes.filter((type) => type === "stream.start")).toHaveLength(1);
        expect(result.eventTypes.filter((type) => type === "stream.finish")).toHaveLength(1);
        expect(result.eventTypes[0]).toBe("stream.start");
      });

      it("assembles a complete turn through gateway.complete", async () => {
        const transport = options.textTurn("conformance text");
        const result = await subsystem(transport).gateway.complete({
          model: { provider: providerId, model: "fixture-model" },
          messages: [{ role: "user", content: "hello" }],
        });

        expect(result.text).toBe("conformance text");
        expect(result.finishReason).toBe("STOP");
        expect(result.providerId).toBe(providerId);
        expect(result.resolution.api).toBe(apiId);
        expect(transport.callCount()).toBe(1);
      });
    });

    describe("tool lifecycle", () => {
      it("forwards a complete tool call lifecycle", async () => {
        const result = await run(options.toolTurn());

        expect(result.eventTypes).toEqual([
          "stream.start",
          "tool_call.start",
          "tool_call.delta",
          "tool_call.delta",
          "tool_call.completed",
          "stream.finish",
        ]);

        const completed = result.events.find((event) => event.type === "tool_call.completed");
        expect(completed?.payload).toMatchObject({
          id: "call-a",
          name: "read_file",
          input: { path: "a.ts" },
        });
      });

      it("keeps parallel tool calls separate and in arrival order", async () => {
        const result = await run(options.parallelToolTurn());
        const completed = result.events.filter((event) => event.type === "tool_call.completed");

        expect(completed).toHaveLength(2);
        expect(completed.map((event) => (event.payload as { id: string }).id)).toEqual([
          "call-a",
          "call-b",
        ]);
      });

      it("assembles completed tool calls into the turn result", async () => {
        const result = await subsystem(options.toolTurn()).gateway.complete({
          model: { provider: providerId, model: "fixture-model" },
          messages: [{ role: "user", content: "hello" }],
        });

        expect(result.toolCalls).toHaveLength(1);
        expect(result.finishReason).toBe("TOOL_CALLS");
      });
    });

    describe("finish mapping", () => {
      it.each(FINISH_CASES)("maps the %s finish reason", async (reason) => {
        const result = await run(options.finishReason(reason));

        expect(result.eventTypes).toEqual(["stream.start", "stream.finish"]);
        expect(result.events.at(-1)?.payload).toMatchObject({ finishReason: reason });
      });

      it("never maps an unknown finish reason to STOP", async () => {
        const result = await run(options.unknownFinish());
        const finish = result.events.at(-1)?.payload as { finishReason: string };

        expect(finish.finishReason).toBe("OTHER");
        expect(finish.finishReason).not.toBe("STOP");
      });
    });

    describe("usage normalization", () => {
      it("forwards usage and makes finalUsage authoritative", async () => {
        const result = await subsystem(options.usageTurn()).gateway.complete({
          model: { provider: providerId, model: "fixture-model" },
          messages: [{ role: "user", content: "hello" }],
        });

        expect(result.usage).toEqual({
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
          cachedInputTokens: 2,
          reasoningTokens: 1,
        });
      });
    });

    describe("retry is disabled", () => {
      it.each([
        ["authentication", () => options.authFailure()],
        ["rate limit", () => options.rateLimitFailure()],
        ["transport", () => options.networkFailure()],
        ["context overflow", () => options.overflowFailure()],
      ] as const)("makes exactly one transport attempt for a %s failure", async (_name, build) => {
        const result = await run(build());

        expect(result.transportAttempts).toBe(1);
      });
    });

    describe("error mapping", () => {
      it("maps an authentication failure as non-retryable", async () => {
        const result = await run(options.authFailure());

        expect(result.streamError?.code).toBe("AI_AUTHENTICATION");
        expect(result.streamError?.retryable).toBe(false);
      });

      it("maps a rate limit as retryable and carries retryAfterMs", async () => {
        const result = await run(options.rateLimitFailure());

        expect(result.streamError?.code).toBe("AI_RATE_LIMIT");
        expect(result.streamError?.retryable).toBe(true);
        expect(result.streamError?.retryAfterMs).toBe(2_000);
      });

      it("maps a context overflow as non-retryable", async () => {
        const result = await run(options.overflowFailure());

        expect(result.streamError?.code).toBe("AI_CONTEXT_OVERFLOW");
        expect(result.streamError?.retryable).toBe(false);
      });

      it("maps a malformed provider response", async () => {
        const result = await run(options.invalidResponseFailure());

        expect(result.streamError?.code).toBe("AI_INVALID_RESPONSE");
        expect(result.streamError?.retryable).toBe(false);
      });

      it("maps a transport failure", async () => {
        const result = await run(options.networkFailure());

        expect(result.streamError?.code).toBe("AI_NETWORK");
      });

      it("turns a mid-stream failure into one terminal stream.error", async () => {
        const result = await run(options.textThenFailure());

        expect(result.eventTypes[0]).toBe("stream.start");
        expect(result.eventTypes.at(-1)).toBe("stream.error");
        expect(result.eventTypes.filter((type) => type === "stream.error")).toHaveLength(1);
      });

      it("never yields a turn result for a broken stream", async () => {
        await expect(
          subsystem(options.textThenFailure()).gateway.complete({
            model: { provider: providerId, model: "fixture-model" },
            messages: [{ role: "user", content: "hello" }],
          }),
        ).rejects.toBeDefined();
      });
    });

    describe("abort propagation", () => {
      it("reaches the transport and reports an abort, not a bad response", async () => {
        const hanging = options.hang();
        const ai = subsystem(hanging);
        const controller = new AbortController();

        const stream = await ai.gateway.stream(
          {
            model: { provider: providerId, model: "fixture-model" },
            messages: [{ role: "user", content: "hello" }],
          },
          { signal: controller.signal },
        );

        const types: string[] = [];
        for await (const event of stream.events) {
          types.push(event.type);
          if (event.type === "stream.start") controller.abort();
        }

        expect(types.at(-1)).toBe("stream.error");
        expect(hanging.observedAbort()).toBe(true);
      });

      it("honours the gateway timeout", async () => {
        const hanging = options.hang();
        const stream = await subsystem(hanging).gateway.stream(
          {
            model: { provider: providerId, model: "fixture-model" },
            messages: [{ role: "user", content: "hello" }],
          },
          { timeoutMs: 20 },
        );

        const events: AIStreamEvent[] = [];
        for await (const event of stream.events) events.push(event);
        const terminal = events.at(-1);

        expect(terminal?.type).toBe("stream.error");
        expect(terminal?.type === "stream.error" ? terminal.payload.error.code : undefined).toBe(
          "AI_TIMEOUT",
        );
      });
    });

    describe("secret safety", () => {
      const serializedOf = (result: ConformanceRun): string => JSON.stringify(result.events);

      it("keeps credentials out of a successful public stream", async () => {
        const serialized = serializedOf(await run(options.textTurn("x")));

        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain("authorization");
        expect(serialized).not.toContain(endpoint);
      });

      it("keeps credentials out of a failure event", async () => {
        expect(serializedOf(await run(options.authFailure()))).not.toContain(secret);
        expect(serializedOf(await run(options.networkFailure()))).not.toContain(secret);
      });

      it("still sends the credential to the transport", async () => {
        const result = await run(options.textTurn("x"));

        expect(request_(result).headers["authorization"]).toBe(`Bearer ${secret}`);
      });
    });

    describe("reasoning translation", () => {
      const reasoningSupported = options.reasoning.assertNative !== undefined;

      it(
        reasoningSupported
          ? "translates the effective level to a native option"
          : "fails closed when the dialect cannot express the level",
        async () => {
          const result = await run(
            options.textTurn("x"),
            { reasoningLevels: [options.reasoning.level] },
            { settings: { reasoning: { level: options.reasoning.level } } },
          );

          if (!reasoningSupported) {
            expect(result.streamError?.code).toBe("AI_CAPABILITY_UNSUPPORTED");
            expect(result.transportAttempts).toBe(0);
            return;
          }
          expect(result.streamError).toBeUndefined();
          options.reasoning.assertNative?.(request_(result));
        },
      );
    });

    describe("cache translation", () => {
      it(
        options.cache.expressible
          ? "translates the effective retention to a native option"
          : "fails closed when the dialect cannot express the retention",
        async () => {
          const result = await run(
            options.textTurn("x"),
            { cacheRetentions: ["NONE", "SHORT", "LONG"] },
            { settings: { cache: { retention: "LONG" } } },
          );

          if (!options.cache.expressible) {
            expect(result.streamError?.code).toBe("AI_CAPABILITY_UNSUPPORTED");
            return;
          }
          expect(result.streamError).toBeUndefined();
          options.cache.assertNative?.(request_(result));
        },
      );

      it("still completes a turn when the retention downgrades to NONE", async () => {
        const result = await run(
          options.textTurn("x"),
          { cacheRetentions: ["NONE"] },
          { settings: { cache: { retention: "SHORT" } } },
        );

        expect(result.eventTypes.at(-1)).toBe("stream.finish");
        expect(JSON.stringify(body(result))).not.toContain("cache");
      });
    });

    describe("request invariants", () => {
      it("uses the provider endpoint and never a legacy baseUrl", async () => {
        const result = await run(
          options.textTurn("x"),
          {},
          {
            model: {
              provider: providerId,
              model: "fixture-model",
              baseUrl: "http://attacker.example/v1",
            },
          },
        );

        expect(request_(result).url).toContain(new URL(endpoint).host);
        expect(request_(result).url).not.toContain("attacker.example");
      });

      it("sends no tools when none are declared", async () => {
        expect(body(await run(options.textTurn("x")))).not.toHaveProperty("tools");
      });
    });
  });
}
