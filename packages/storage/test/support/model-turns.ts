import type { AIModelRequest, AIModelTurnResult, ModelUsage } from "@caelush/ai";
import { createLLMCallId } from "@caelush/protocol";
import type { AgentLoopDependencies } from "@caelush/core";

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

/** The frozen retryability table, mirrored so the fake needs no AI core dependency. */
const RETRYABLE_TEST_CODES: readonly TestAIErrorCode[] = [
  "AI_RATE_LIMIT",
  "AI_NETWORK",
  "AI_TIMEOUT",
];

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
 * Phase 2C made the AgentLoop depend on `ModelCatalog` + a model turn executor instead of
 * an LLM client. Storage tests only need to *feed* those ports, so the port types here are
 * named through the Core dependency itself: Storage gains no production dependency on
 * `@caelush/agent`, and the package keeps its frozen dependency direction.
 *
 * Phase 3A aligned the agent executor with the frozen union result and kept the legacy
 * throwing facade at the Core boundary. The production `AgentLoop.send` path therefore
 * still observes a throwing executor, so this fake reproduces exactly that observable
 * behaviour — including the reverse error mapping the facade performs. It is a deliberate
 * small copy of `packages/core/test/support/fake-model-turn-executor.ts`: importing another
 * package's test tree would violate the workspace import boundary.
 */

/** The input of one turn, named through the Core port. */
export type ModelTurnExecutionInput =
  Parameters<AgentLoopDependencies["modelTurns"]["execute"]>[0];

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
 * Phase 2C routes every model turn through the AI core, so the durable retry layer reads
 * AI codes. It deliberately does not understand legacy `LLM_*` error classes. The shape is
 * structural rather than a real `AIError` instance because Storage may not depend on the AI
 * core, and the Core error mapper reads it structurally for exactly that reason.
 */
export function aiError(code: TestAIErrorCode, options: TestAIErrorOptions = {}): TestAIError {
  const error = new Error(options.message ?? `test ${code}`) as TestAIError & {
    code: TestAIErrorCode;
    retryable: boolean;
    retryAfterMs?: number;
  };
  error.name = "AIError";
  error.code = code;
  error.retryable = RETRYABLE_TEST_CODES.includes(code);
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

/**
 * A scripted executor that records what the loop actually built.
 *
 * A script that throws is reported the way the production facade reports a frozen
 * `FAILED` result: the thrown AI code is turned back into the same `AIError` the durable
 * retry layer has always read.
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
      try {
        return modelTurnResult(await script(input.request, input.signal, callIndex));
      } catch (error) {
        throw toLegacyError(error);
      }
    },
  };
}

/**
 * An executor that never produces a turn result.
 *
 * It mirrors the adapter's behaviour for a cancelled frozen execution: the legacy path is
 * throw-based, so cancellation surfaces as `AI_ABORTED` rather than as a provider failure.
 */
export function cancelledModelTurnExecutor(): FakeModelTurnExecutor {
  return {
    requests: [],
    signals: [],
    callCount: () => 0,
    execute: () => Promise.reject(aiError("AI_ABORTED", { message: "test cancellation" })),
  };
}

/** Turn any thrown value into the mapped AI failure the facade would throw. */
function toLegacyError(error: unknown): TestAIError {
  if (isTestAIError(error)) return error;
  return aiError("AI_PROVIDER_ERROR", { message: "The model turn failed." });
}

function isTestAIError(value: unknown): value is TestAIError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly code?: unknown; readonly retryable?: unknown };
  return typeof candidate.code === "string" && typeof candidate.retryable === "boolean";
}

/**
 * A permissive model catalog for tests that do not care about model metadata.
 *
 * Every ref resolves to one descriptor so the AgentLoop's model resolution always succeeds.
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
