import { createLLMCallId as createProtocolCallId } from "@caelush/protocol";
import type {
  AIError,
  AIErrorCode,
  AIModelRequest,
  AIModelTurnResult,
  ModelCatalog,
  ModelDescriptor,
  ModelRef as AIModelRef,
  ModelUsage,
} from "@caelush/ai";
import type { ModelDescriptorSourcePort } from "@caelush/ai";
import type { ModelTurnExecutor, ModelTurnExecutionInput } from "@caelush/agent";

/**
 * Core test support for the post-2C model seams.
 *
 * It fakes only `ModelTurnExecutor` and `ModelCatalog` — the contracts Core now
 * depends on. It deliberately does not fake a provider, an SDK, a gateway or an
 * adapter: a test that needs those is an integration test and must use the real
 * implementation over a controlled transport.
 */

/** The subset of a turn result a test usually cares about. */
export interface PartialTurnResult {
  readonly callId?: string;
  readonly providerId?: string;
  readonly model?: AIModelRef;
  readonly text?: string;
  readonly toolCalls?: AIModelTurnResult["toolCalls"];
  readonly finishReason?: AIModelTurnResult["finishReason"];
  readonly usage?: ModelUsage | undefined;
  readonly resolution?: AIModelTurnResult["resolution"];
}

const DEFAULT_RESOLUTION: AIModelTurnResult["resolution"] = {
  api: "test-api",
  reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
  cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
};

/** Build a complete turn result from the fields a test cares about. */
export function modelTurnResult(partial: PartialTurnResult = {}): AIModelTurnResult {
  const provider = partial.model?.provider ?? partial.providerId ?? "fixture";
  return {
    // The AI call id is a different brand of the same `llm_<uuid>` string.
    callId: (partial.callId ?? createProtocolCallId()) as AIModelTurnResult["callId"],
    providerId: partial.providerId ?? provider,
    model: partial.model ?? { provider, model: "fixture-model" },
    text: partial.text ?? "",
    toolCalls: partial.toolCalls ?? [],
    finishReason: partial.finishReason ?? "STOP",
    ...(partial.usage === undefined ? {} : { usage: partial.usage }),
    resolution: partial.resolution ?? DEFAULT_RESOLUTION,
  };
}

/** Build an AI failure with the frozen shape. It is a real `Error`, like the production one. */
export function aiError(code: AIErrorCode, extra: Partial<AIError> = {}): AIError {
  const retryable = code === "AI_RATE_LIMIT" || code === "AI_NETWORK" || code === "AI_TIMEOUT";
  const error = new Error(extra.message ?? `test ${code}`) as AIError & {
    code: AIErrorCode;
    retryable: boolean;
    retryAfterMs?: number;
  };
  error.name = "AIError";
  error.code = code;
  error.retryable = retryable;
  if (extra.retryAfterMs !== undefined) error.retryAfterMs = extra.retryAfterMs;
  return error;
}
/** The executor's script: what one call returns, or throws. */
export type ModelTurnScript = (
  request: AIModelRequest,
  signal: AbortSignal,
  callIndex: number,
) => Promise<PartialTurnResult> | PartialTurnResult;

export interface FakeModelTurnExecutor extends ModelTurnExecutor {
  readonly requests: readonly AIModelRequest[];
  readonly signals: readonly AbortSignal[];
  callCount(): number;
}

/**
 * A scripted `ModelTurnExecutor`.
 *
 * It records every request and signal, so a test can assert what the AgentLoop
 * actually built and prove that no hidden retry happened.
 */
export function fakeModelTurnExecutor(script: ModelTurnScript): FakeModelTurnExecutor {
  const requests: AIModelRequest[] = [];
  const signals: AbortSignal[] = [];

  return {
    requests,
    signals,
    callCount: () => requests.length,
    async execute(input: ModelTurnExecutionInput): Promise<AIModelTurnResult> {
      const callIndex = requests.length;
      requests.push(input.request);
      signals.push(input.signal);
      return modelTurnResult(await script(input.request, input.signal, callIndex));
    },
  };
}

/** An executor that always returns the same turn. */
export function fixedModelTurnExecutor(partial: PartialTurnResult = {}): FakeModelTurnExecutor {
  return fakeModelTurnExecutor(() => partial);
}

/** An executor that always throws the same AI failure. */
export function failingModelTurnExecutor(error: AIError): FakeModelTurnExecutor {
  return fakeModelTurnExecutor(() => {
    throw error;
  });
}

/** An executor that replays a sequence, then repeats the last entry. */
export function sequencedModelTurnExecutor(
  sequence: readonly (PartialTurnResult | AIError)[],
): FakeModelTurnExecutor {
  return fakeModelTurnExecutor((_request, _signal, callIndex) => {
    const step = sequence[Math.min(callIndex, sequence.length - 1)]!;
    if (isAIError(step)) throw step;
    return step;
  });
}

function isAIError(value: PartialTurnResult | AIError): value is AIError {
  return typeof (value as AIError).code === "string";
}

/**
 * A permissive model catalog for tests that do not care about model metadata.
 *
 * Every ref resolves to one descriptor so the AgentLoop's model resolution always
 * succeeds; tests about metadata authority build their own catalog.
 */
export function testModelCatalog(descriptor?: ModelDescriptor): ModelCatalog {
  const source: ModelDescriptorSourcePort & { list(): readonly ModelDescriptor[] } = {
    id: "core-test",
    priority: 0,
    resolve: (ref: AIModelRef): ModelDescriptor =>
      descriptor ?? {
        ref,
        api: "test-api",
        limits: { contextWindowTokens: 100_000, maxOutputTokens: 8_000 },
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
    list: () => [],
  };

  return {
    resolve: (ref: AIModelRef) => source.resolve(ref) as ModelDescriptor,
    has: () => true,
    list: () => [],
  };
}

/** A catalog that throws, for tests about an unresolvable model. */
export function emptyModelCatalog(): ModelCatalog {
  return {
    resolve: () => {
      throw aiError("AI_MODEL_METADATA_INCOMPLETE");
    },
    has: () => false,
    list: () => [],
  };
}
