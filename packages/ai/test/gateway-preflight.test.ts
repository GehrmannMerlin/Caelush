import { describe, expect, it } from "vitest";
import { AIError } from "../src/errors/ai-error.js";
import { createAIGateway } from "../src/gateway/ai-gateway.js";
import { modelDescriptor } from "./support/fixtures.js";
import { adapterEvents, createFakeAdapter, textTurn } from "./support/fake-adapter.js";
import {
  delayedCredentialResolver,
  testGatewayDependencies,
  testProviderBinding,
} from "./support/gateway-fixtures.js";
import type { AIGateway } from "../src/gateway/ai-gateway.js";
import type { AIModelRequest } from "../src/request/model-request.js";
import type { AIProviderBinding } from "../src/providers/provider-binding.js";
import type { ModelDescriptor } from "../src/models/model-descriptor.js";

const MODEL = modelDescriptor({ ref: { provider: "test", model: "model-a" }, api: "test-api" });

const READ_FILE = {
  name: "read_file",
  description: "read a file",
  inputSchema: { type: "object" },
};

function request(overrides: Partial<AIModelRequest> = {}): AIModelRequest {
  return {
    model: { provider: "test", model: "model-a" },
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as AIModelRequest;
}

interface Harness {
  gateway: AIGateway;
  callCount(): number;
}

interface HarnessOptions {
  readonly descriptors?: readonly ModelDescriptor[];
  readonly providers?: readonly AIProviderBinding[];
  readonly api?: string;
}

function harness(options: HarnessOptions = {}): Harness {
  const adapter = createFakeAdapter(options.api ?? "test-api", () =>
    adapterEvents(...textTurn("hello")),
  );
  const gateway = createAIGateway(
    testGatewayDependencies({
      descriptors: options.descriptors ?? [MODEL],
      adapters: [adapter],
      ...(options.providers === undefined ? {} : { providers: options.providers }),
    }),
  );
  return { gateway, callCount: () => adapter.callCount() };
}

/** Assert preflight rejects with a code, and the adapter was never invoked. */
async function expectPreflight(
  gateway: AIGateway,
  callCount: () => number,
  value: AIModelRequest,
  code: AIError["code"],
): Promise<void> {
  await expect(gateway.stream(value)).rejects.toBeInstanceOf(AIError);
  await gateway.stream(value).catch((error: unknown) => {
    expect(error).toBeInstanceOf(AIError);
    expect((error as AIError).code).toBe(code);
    expect((error as AIError).retryable).toBe(false);
  });
  expect(callCount()).toBe(0);
}

describe("AIGateway preflight", () => {
  it("rejects an invalid request", async () => {
    const { gateway, callCount } = harness();

    await expectPreflight(
      gateway,
      callCount,
      { model: { provider: "test", model: "model-a" }, messages: [] } as unknown as AIModelRequest,
      "AI_INVALID_REQUEST",
    );
    await expectPreflight(
      gateway,
      callCount,
      request({ settings: { temperature: 3 } }),
      "AI_INVALID_REQUEST",
    );
  });

  it("rejects a missing provider", async () => {
    const { gateway, callCount } = harness();

    await expectPreflight(
      gateway,
      callCount,
      request({ model: { provider: "azure", model: "model-a" } }),
      "AI_MODEL_METADATA_INCOMPLETE",
    );
  });

  it("rejects an unknown model with incomplete metadata", async () => {
    const { gateway, callCount } = harness();

    await expectPreflight(
      gateway,
      callCount,
      request({ model: { provider: "test", model: "unknown-model" } }),
      "AI_MODEL_METADATA_INCOMPLETE",
    );
  });

  it("rejects a model the provider does not allow", async () => {
    const { gateway, callCount } = harness({
      providers: [testProviderBinding({ allowedModels: ["other-model"] })],
    });

    await expectPreflight(gateway, callCount, request(), "AI_MODEL_UNSUPPORTED");
  });

  it("rejects a fallback descriptor when the provider forbids unknown models", async () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("hello")));
    const gateway = createAIGateway(
      testGatewayDependencies({
        modelSources: [
          {
            id: "safe-defaults",
            priority: 100,
            resolve: (ref) => ({
              ...modelDescriptor({ ref, api: "test-api" }),
              source: "FALLBACK",
            }),
          },
        ],
        providers: [testProviderBinding({ allowUnknownModels: false })],
        adapters: [adapter],
      }),
    );

    await expectPreflight(
      gateway,
      () => adapter.callCount(),
      request({ model: { provider: "test", model: "anything" } }),
      "AI_MODEL_METADATA_INCOMPLETE",
    );
  });

  it("accepts a fallback descriptor when the provider allows unknown models", async () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("ok")));
    const gateway = createAIGateway(
      testGatewayDependencies({
        modelSources: [
          {
            id: "safe-defaults",
            priority: 100,
            resolve: (ref) => ({
              ...modelDescriptor({ ref, api: "test-api" }),
              source: "FALLBACK",
            }),
          },
        ],
        providers: [testProviderBinding({ allowUnknownModels: true })],
        adapters: [adapter],
      }),
    );

    const stream = await gateway.stream(
      request({ model: { provider: "test", model: "anything" } }),
    );

    expect(stream.callId).toMatch(/^llm_/);
  });

  it("rejects a model whose api dialect has no adapter", async () => {
    const { gateway, callCount } = harness({
      descriptors: [modelDescriptor({ ref: MODEL.ref, api: "anthropic-messages" })],
    });

    await expectPreflight(gateway, callCount, request(), "AI_ADAPTER_NOT_FOUND");
  });

  it("rejects invalid tool semantics", async () => {
    const { gateway, callCount } = harness();

    await expectPreflight(
      gateway,
      callCount,
      request({ tools: [READ_FILE, READ_FILE] }),
      "AI_INVALID_REQUEST",
    );
    await expectPreflight(
      gateway,
      callCount,
      request({ toolChoice: { type: "TOOL", toolName: "read_file" } }),
      "AI_INVALID_REQUEST",
    );
    await expectPreflight(
      gateway,
      callCount,
      request({ toolChoice: { type: "REQUIRED" } }),
      "AI_INVALID_REQUEST",
    );
  });

  it("rejects an explicitly unsupported capability", async () => {
    const { gateway, callCount } = harness({
      descriptors: [
        modelDescriptor({
          ref: MODEL.ref,
          capabilities: { ...MODEL.capabilities, toolCalling: "UNSUPPORTED" },
        }),
      ],
    });

    await expectPreflight(
      gateway,
      callCount,
      request({ tools: [READ_FILE] }),
      "AI_CAPABILITY_UNSUPPORTED",
    );
  });

  it("rejects a reasoning request the model cannot satisfy", async () => {
    const { gateway, callCount } = harness();

    await expectPreflight(
      gateway,
      callCount,
      request({ settings: { reasoning: { level: "HIGH" } } }),
      "AI_CAPABILITY_UNSUPPORTED",
    );
  });

  it("rejects maxOutputTokens beyond the model limit", async () => {
    const { gateway, callCount } = harness();

    await expectPreflight(
      gateway,
      callCount,
      request({ settings: { maxOutputTokens: MODEL.limits.maxOutputTokens + 1 } }),
      "AI_INVALID_REQUEST",
    );
  });

  it("rejects an invalid timeout", async () => {
    const { gateway, callCount } = harness();

    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(gateway.stream(request(), { timeoutMs })).rejects.toBeInstanceOf(AIError);
      await gateway.stream(request(), { timeoutMs }).catch((error: unknown) => {
        expect(error).toBeInstanceOf(AIError);
        expect((error as AIError).code).toBe("AI_INVALID_REQUEST");
      });
    }
    expect(callCount()).toBe(0);
  });

  it("rejects an invalid default timeout configured on the gateway", async () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("hello")));
    const gateway = createAIGateway(
      testGatewayDependencies({ descriptors: [MODEL], adapters: [adapter] }),
      { defaultTimeoutMs: 0 },
    );

    await expect(gateway.stream(request())).rejects.toBeInstanceOf(AIError);
    expect(adapter.callCount()).toBe(0);
  });

  it("rejects a credential resolution failure before any adapter call", async () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("hello")));
    const gateway = createAIGateway(
      testGatewayDependencies({
        descriptors: [MODEL],
        providers: [
          testProviderBinding({
            credentials: {
              resolve: () => Promise.reject(new Error("no api key configured")),
            },
          }),
        ],
        adapters: [adapter],
      }),
    );

    await expectPreflight(gateway, () => adapter.callCount(), request(), "AI_AUTHENTICATION");
  });

  it("resolves credentials asynchronously before returning the stream", async () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("ok")));
    const credential = delayedCredentialResolver(20);
    const gateway = createAIGateway(
      testGatewayDependencies({
        descriptors: [MODEL],
        providers: [testProviderBinding({ credentials: credential.resolver })],
        adapters: [adapter],
      }),
    );

    expect(credential.resolved()).toBe(false);
    const stream = await gateway.stream(request());

    expect(credential.resolved()).toBe(true);
    expect(stream.callId).toMatch(/^llm_/);
    expect(adapter.callCount()).toBe(0);
  });

  it("rejects a malformed credential resolution result", async () => {
    const adapter = createFakeAdapter("test-api", () => adapterEvents(...textTurn("ok")));
    const gateway = createAIGateway(
      testGatewayDependencies({
        descriptors: [MODEL],
        providers: [
          testProviderBinding({
            credentials: {
              resolve: () => Promise.resolve(undefined as unknown as { apiKey: string }),
            },
          }),
        ],
        adapters: [adapter],
      }),
    );

    await expectPreflight(gateway, () => adapter.callCount(), request(), "AI_AUTHENTICATION");
  });
});
