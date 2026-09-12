import { createLLMCallId } from "@caelush/protocol";
import type {
  AgentLoopDependencies,
  AIModelRequest,
  AIModelTurnResult,
  ModelUsage,
} from "@caelush/core";

/** The frozen AI error spellings the durable retry layer understands. */
export type TestAIErrorCode =
  | "AI_RATE_LIMIT"
  | "AI_NETWORK"
  | "AI_TIMEOUT"
  | "AI_AUTHENTICATION"
  | "AI_INVALID_RESPONSE"
  | "AI_PROVIDER_ERROR"
  | "AI_CONTEXT_OVERFLOW"
  | "AI_ABORTED";

/** A structurally valid AI failure. It is a real `Error`, like the production one. */
export interface TestAIError extends Error {
  readonly code: TestAIErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export interface TestAIErrorOptions {
  readonly message?: string;
  readonly retryAfterMs?: number;
}

/**
 * Storage test support for the post-2C model seams.
 *
 * Phase 2C made the AgentLoop depend on `ModelCatalog` + `ModelTurnExecutor` instead of
 * an LLM client. Storage tests only need to *feed* those ports, so every type here is
 * named through the Core port itself: Storage gains no dependency on `@caelush/ai` or
 * `@caelush/agent`, and the package keeps its frozen dependency direction.
 *
 * This mirrors `packages/core/test/support/fake-model-turn-executor.ts`. It is a
 * deliberate small copy: a cross-package import of another package's test tree would
 * violate the workspace import boundary.
 */

/** The input of one turn, named through the Core port. */
export type ModelTurnExecutionInput = Parameters<AgentLoopDependencies["modelTurns"]["execute"]>[0];

/** The executor port Core expects. */
export type ModelTurnExecutor = AgentLoopDependencies["modelTurns"];

/** The catalog port Core expects. */
export type ModelTurnCatalog = AgentLoopDependencies["models"];

/** The subset of a turn result a test usually cares about. */
export interface PartialTurnResult {
  readonly callId?: string;
  readonly providerId?: string;
  readonly model?: AIModelRequest["model"];
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
    // The AI call id and the Protocol call id are two brands of the same string.
    callId: (partial.callId ?? createLLMCallId()) as unknown as AIModelTurnResult["callId"],
    providerId: partial.providerId ?? provider,
    model: partial.model ?? { provider, model: "fixture-model" },
    text: partial.text ?? "",
    toolCalls: partial.toolCalls ?? [],
    finishReason: partial.finishReason ?? "STOP",
    ...(partial.usage === undefined ? {} : { usage: partial.usage }),
    resolution: partial.resolution ?? DEFAULT_RESOLUTION,
  };
}

/**
 * Build an AI failure with the frozen shape.
 *
 * Phase 2C routes every model turn through the AI core, so the durable retry layer now
 * reads AI codes. It deliberately does not understand legacy `LLM_*` error classes.
 */
export function aiError(code: TestAIErrorCode, options: TestAIErrorOptions = {}): TestAIError {
  const retryable = code === "AI_RATE_LIMIT" || code === "AI_NETWORK" || code === "AI_TIMEOUT";
  const error = new Error(options.message ?? `test ${code}`) as TestAIError & {
    code: TestAIErrorCode;
    retryable: boolean;
    retryAfterMs?: number;
  };
  error.name = "AIError";
  error.code = code;
  error.retryable = retryable;
  if (options.retryAfterMs !== undefined) error.retryAfterMs = options.retryAfterMs;
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
/** A scripted `ModelTurnExecutor` that records what the loop actually built. */
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

/**
 * A permissive model catalog for tests that do not care about model metadata.
 *
 * Every ref resolves to one descriptor so the AgentLoop's model resolution always
 * succeeds.
 */
export function testModelCatalog(): ModelTurnCatalog {
  const descriptor = {
    ref: { provider: "fixture", model: "fixture-model" },
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
  } as const;

  return {
    resolve: (ref) => ({ ...descriptor, ref }) as ReturnType<ModelTurnCatalog["resolve"]>,
    has: () => true,
    list: () => [],
  };
}
