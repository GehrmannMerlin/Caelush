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
import { createAIError } from "@caelush/ai";
import type { AgentExecutionIdentity, ModelTurnExecutor } from "@caelush/agent";
import { createLegacyModelTurnExecutor } from "@caelush/core";
import type { LegacyModelTurnExecutor } from "@caelush/core";
import type { RunId, SessionId, StepId } from "@caelush/protocol";

/** The legacy throwing port Core's AgentLoop consumes. */
type ModelTurnExecutionInput = Parameters<LegacyModelTurnExecutor["execute"]>[0];

/**
 * Core test support for the post-2C model seams.
 *
 * It fakes only the model turn port and `ModelCatalog` — the contracts Core now depends on.
 * It deliberately does not fake a provider, an SDK, a gateway or an adapter: a test that
 * needs those is an integration test and must use the real implementation over a controlled
 * transport.
 *
 * Phase 3A aligned the agent executor with the frozen union result and put the legacy
 * throwing facade at the Core boundary, so this fake reproduces the facade's *observable*
 * behaviour: a script throws an AI failure, and the loop sees a thrown AI failure. That is
 * what keeps the existing failure-mapping assertions meaningful rather than merely
 * compiling.
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

/** Build an AI failure with the frozen shape. This is the real `AIError`. */
export function aiError(code: AIErrorCode, extra: Partial<AIError> = {}): AIError {
  return createAIError(code, extra.message ?? `test ${code}`, {
    ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
  });
}

/** The executor's script: what one call returns, or throws. */
export type ModelTurnScript = (
  request: AIModelRequest,
  signal: AbortSignal,
  callIndex: number,
) => Promise<PartialTurnResult> | PartialTurnResult;

export interface FakeModelTurnExecutor extends LegacyModelTurnExecutor {
  readonly requests: readonly AIModelRequest[];
  readonly signals: readonly AbortSignal[];
  callCount(): number;
}

/**
 * A scripted legacy model turn executor.
 *
 * It records every request and signal, so a test can assert what the AgentLoop actually
 * built and prove that no hidden retry happened. A throwing script is reported the way the
 * production facade reports a failed frozen execution: the AI code survives the round trip.
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

/** Turn any thrown value into the mapped AI failure the facade would throw. */
function toLegacyError(error: unknown): AIError {
  if (error instanceof Error && typeof (error as AIError).code === "string") {
    return error as AIError;
  }
  return createAIError("AI_PROVIDER_ERROR", "The model turn failed.", { cause: error });
}

/**
 * A Run identity for a test that does not care which Run it is.
 *
 * The frozen model turn executor requires an identity because the durable model turn
 * boundary commits against a Run and a Session.
 */
export function testTurnIdentity(): AgentExecutionIdentity {
  return {
    runId: "run_0195f3a0-0000-7000-8000-000000000000" as RunId,
    sessionId: "ses_0195f3a0-0000-7000-8000-000000000000" as SessionId,
    goal: "test run",
  };
}

/**
 * Drive the real frozen executor through the transitional legacy facade.
 *
 * The production daemon does exactly this, so an end-to-end test that wires the real
 * gateway into the Core loop must adapt the same way rather than reaching for a second
 * executor implementation.
 */
export function legacyModelTurns(executor: ModelTurnExecutor): LegacyModelTurnExecutor {
  return createLegacyModelTurnExecutor({
    executor,
    identity: testTurnIdentity,
    createStepId: () => "stp_0195f3a0-0000-7000-8000-000000000000" as StepId,
  });
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
