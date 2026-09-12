import { createAISubsystem } from "@caelush/ai";
import type {
  AIAdapterEvent,
  AIProviderBinding,
  ApiAdapter,
  ApiAdapterStreamInput,
  AISubsystem,
  ModelDescriptor,
  ModelDescriptorSourcePort,
  ModelRef as AIModelRef,
} from "@caelush/ai";

/**
 * Core integration support: a **real** `AISubsystem` driven by a scripted `ApiAdapter`.
 *
 * Phase 2C removed every Core seam that could reach a model without the AI core, so a
 * test that wants to prove "AgentLoop → ModelTurnExecutor → AIGateway.stream()" must
 * run the real gateway. Only the two things a unit test cannot own are scripted:
 *
 *   - the transport dialect (an `ApiAdapter`, which is the AI core's own test seam), and
 *   - the connection (a provider binding with an unresolvable credential resolver).
 *
 * Nothing here replaces the gateway, the catalog, the provider registry, the stream
 * validator or the turn assembler.
 */

export const FIXTURE_PROVIDER = "fixture";
export const FIXTURE_API = "fixture-api";
export const FIXTURE_MODEL = "fixture-model";
export const FIXTURE_REF: AIModelRef = { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL };
export const FIXTURE_ENDPOINT = "http://expected.example/v1";

/** One scripted provider turn, expressed in the adapter's own dialect. */
export type AdapterTurnScript = (
  input: ApiAdapterStreamInput,
  turnIndex: number,
) => Iterable<AIAdapterEvent> | AsyncIterable<AIAdapterEvent>;

export interface TestAiSubsystem {
  readonly ai: AISubsystem;
  /** Every adapter invocation, in order, so a test can prove how many turns happened. */
  readonly adapterCalls: readonly ApiAdapterStreamInput[];
  /** The signals the gateway handed to the adapter, for abort assertions. */
  readonly adapterSignals: readonly AbortSignal[];
}

export interface TestAiSubsystemOptions {
  readonly script: AdapterTurnScript;
  readonly descriptor?: ModelDescriptor;
  /** Overrides the provider endpoint, e.g. to prove a stored baseUrl cannot route. */
  readonly endpoint?: string;
}

/** A descriptor whose intrinsic limits are unmistakable in an assertion. */
export function fixtureDescriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    ref: FIXTURE_REF,
    api: FIXTURE_API,
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
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
    ...overrides,
  };
}

/** Build a real AI subsystem over a scripted adapter. */
export function createTestAiSubsystem(options: TestAiSubsystemOptions): TestAiSubsystem {
  const descriptor = options.descriptor ?? fixtureDescriptor();
  const adapterCalls: ApiAdapterStreamInput[] = [];
  const adapterSignals: AbortSignal[] = [];

  const adapter: ApiAdapter = {
    id: FIXTURE_API,
    stream(input: ApiAdapterStreamInput): AsyncIterable<AIAdapterEvent> {
      const turnIndex = adapterCalls.length;
      adapterCalls.push(input);
      adapterSignals.push(input.signal);
      return toAsyncIterable(options.script(input, turnIndex));
    },
  };

  const source: ModelDescriptorSourcePort & { list(): readonly ModelDescriptor[] } = {
    id: "core-integration",
    priority: 0,
    resolve: (ref: AIModelRef) =>
      ref.provider === descriptor.ref.provider && ref.model === descriptor.ref.model
        ? descriptor
        : undefined,
    list: () => [descriptor],
  };

  const binding: AIProviderBinding = {
    id: FIXTURE_PROVIDER,
    endpoint: options.endpoint ?? FIXTURE_ENDPOINT,
    defaultApi: FIXTURE_API,
    allowUnknownModels: true,
    credentials: { resolve: () => Promise.resolve({}) },
  };

  const ai = createAISubsystem({
    modelSources: [source],
    providers: [binding],
    adapters: [adapter],
  });

  return { ai, adapterCalls, adapterSignals };
}

async function* toAsyncIterable(
  events: Iterable<AIAdapterEvent> | AsyncIterable<AIAdapterEvent>,
): AsyncIterable<AIAdapterEvent> {
  for await (const event of events) yield event;
}
