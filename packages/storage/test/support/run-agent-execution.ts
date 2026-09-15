import type { AIMessage, AIModelRequest, AIToolResultMessage, AIToolSpec } from "@caelush/ai";
import type {
  ContextEnginePort,
  ContextPrepareInput,
  ModelTurnExecutionResult,
  ModelTurnExecutor,
  PreparedModelContext,
} from "@caelush/agent";
import type { RunAgentExecutionContextFactory } from "@caelush/core";
import type { StepId } from "@caelush/protocol";

import { isTestAIError, modelTurnResult, type PartialTurnResult } from "./model-turns.js";

/**
 * Storage test support for the production direct Agent execution path.
 *
 * ```text
 * RunController → createAgentLoop(...) → createRunExecutionDriver(...) → AgentLoop.advance()
 * ```
 *
 * Phase 3C checkpoint 6 retired the legacy Core `AgentLoop` facade from production composition, so a
 * Storage test that drives a Run no longer hands the controller a facade plus a throwing
 * `LegacyModelTurnExecutor`. It hands it the frozen collaborator ports — a `ModelCatalog`, a frozen
 * `ModelTurnExecutor`, a Step identity factory and a `ContextEnginePort` — exactly as the daemon
 * composition does.
 *
 * This is a deliberate small copy of `packages/core/test/support/run-agent-execution.ts`: importing
 * another package's test tree would violate the workspace import boundary. It names the Core port
 * types only through `@caelush/core`'s public surface, so Storage gains no production dependency it
 * did not already have.
 */

/** A script that answers one frozen model turn, either as a partial result or as a raw union. */
export type FrozenModelTurnScript = (
  request: AIModelRequest,
  signal: AbortSignal,
  callIndex: number,
) =>
  | Promise<PartialTurnResult | ModelTurnExecutionResult>
  | PartialTurnResult
  | ModelTurnExecutionResult;

export interface FakeFrozenModelTurnExecutor extends ModelTurnExecutor {
  readonly requests: readonly AIModelRequest[];
  readonly signals: readonly AbortSignal[];
  callCount(): number;
}

/**
 * A scripted *frozen* model turn executor.
 *
 * It resolves the frozen union instead of throwing. A script that throws a test `AIError` is
 * reported as the mapped `FAILED` member, so an existing failure fixture keeps its meaning while the
 * contract the production path observes becomes the value-based one.
 */
export function fakeFrozenModelTurnExecutor(
  script: FrozenModelTurnScript,
): FakeFrozenModelTurnExecutor {
  const requests: AIModelRequest[] = [];
  const signals: AbortSignal[] = [];

  return {
    requests,
    signals,
    callCount: () => requests.length,
    async execute(input): Promise<ModelTurnExecutionResult> {
      const callIndex = requests.length;
      requests.push(input.request);
      signals.push(input.signal);
      if (input.signal.aborted) return { kind: "CANCELLED" };
      try {
        const answer = await script(input.request, input.signal, callIndex);
        if (isFrozenResult(answer)) return answer;
        return { kind: "COMPLETED", result: modelTurnResult(answer) };
      } catch (error) {
        if (input.signal.aborted) return { kind: "CANCELLED" };
        return { kind: "FAILED", error: toFrozenFailure(error) };
      }
    },
  };
}

function isFrozenResult(value: unknown): value is ModelTurnExecutionResult {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { readonly kind?: unknown }).kind;
  return kind === "COMPLETED" || kind === "FAILED" || kind === "CANCELLED";
}

/** The frozen failure-code table, mirrored so this fake needs no AI core dependency. */
function toFrozenFailure(error: unknown): { code: never; message: string; retryable: boolean } {
  const code = isTestAIError(error) ? error.code : "AI_PROVIDER_ERROR";
  const mapped =
    code === "AI_RATE_LIMIT"
      ? "RATE_LIMIT"
      : code === "AI_NETWORK"
        ? "NETWORK"
        : code === "AI_TIMEOUT"
          ? "TIMEOUT"
          : code === "AI_AUTHENTICATION"
            ? "AUTHENTICATION"
            : code === "AI_INVALID_RESPONSE"
              ? "INVALID_RESPONSE"
              : code === "AI_CONTEXT_OVERFLOW"
                ? "CONTEXT_OVERFLOW"
                : "PROVIDER_ERROR";
  const retryAfterMs =
    typeof (error as { readonly retryAfterMs?: unknown })?.retryAfterMs === "number"
      ? (error as { readonly retryAfterMs: number }).retryAfterMs
      : undefined;
  return {
    code: mapped as never,
    message: "The model turn failed.",
    retryable: mapped === "RATE_LIMIT" || mapped === "NETWORK" || mapped === "TIMEOUT",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  } as { code: never; message: string; retryable: boolean };
}

/** The context one prepared turn carries, as a test can inspect it. */
export interface PreparedTestContext {
  readonly messages: readonly AIMessage[];
  readonly mode: ContextPrepareInput["mode"];
}

export interface FakeContextEngine extends ContextEnginePort {
  readonly preparations: readonly PreparedTestContext[];
  /** A failure to throw from `prepare()`, so a test can prove a context failure costs no Step. */
  prepareFailure?: unknown;
}

/**
 * A minimal Context Engine.
 *
 * It renders the current turn the way the general loop describes it — previous history, the pending
 * assistant tool call when there is one, then the turn's own messages — which is what a test needs
 * in order to assert what the model was shown. It reads nothing from the environment.
 */
export function fakeContextEngine(): FakeContextEngine {
  const preparations: PreparedTestContext[] = [];
  const engine: FakeContextEngine = {
    preparations,
    async prepare(input: ContextPrepareInput): Promise<PreparedModelContext> {
      if (engine.prepareFailure !== undefined) throw engine.prepareFailure;
      preparations.push({ mode: input.mode, messages: input.history });
      return {
        messages: [...input.history, ...turnMessages(input)],
        report: {
          estimatedInputTokens: 1,
          effectiveInputLimitTokens: input.model.limits.contextWindowTokens,
          remainingTokens: input.model.limits.contextWindowTokens - 1,
          pressure: "NORMAL",
          compactionCount: 0,
          contributions: [],
        },
        observationPolicy: {
          maxSingleObservationTokens: 4_000,
          maxObservationBatchTokens: 12_000,
        },
      };
    },
  };
  return engine;
}

/** The messages one turn input contributes, in the order the model sees them. */
function turnMessages(input: ContextPrepareInput): readonly AIMessage[] {
  const turn = input.input;
  if (turn.kind === "USER_INPUT") return turn.messages;
  if (turn.kind === "CONTINUATION") return turn.messages ?? [];
  return [
    turn.pendingDecision.modelTurn.assistantMessage,
    ...(turn.results as readonly AIToolResultMessage[]),
  ];
}

/** What a test needs in order to compose the production direct Agent execution path. */
export interface TestRunAgentExecution {
  readonly factory: RunAgentExecutionContextFactory;
  readonly executor: FakeFrozenModelTurnExecutor;
  readonly contextEngine: FakeContextEngine;
}

/**
 * Compose the Run Layer's direct Agent execution dependencies for a test.
 *
 * The Step identity factory is deliberately injectable: a test that asserts Step ownership must be
 * able to observe the exact identifier the Run Layer allocated *before* `advance()` was entered.
 */
export function testRunAgentExecution(options: {
  readonly executor: FakeFrozenModelTurnExecutor;
  readonly contextEngine?: FakeContextEngine;
  readonly createStepId?: () => StepId;
  readonly createContextEngine?: () => ContextEnginePort;
  readonly tools?: readonly AIToolSpec[];
  readonly historyPrefix?: readonly AIMessage[];
}): TestRunAgentExecution {
  const contextEngine = options.contextEngine ?? fakeContextEngine();
  const stepIds = { create: options.createStepId ?? defaultStepIdFactory() };
  const factory: RunAgentExecutionContextFactory = {
    async resolve(): Promise<Awaited<ReturnType<RunAgentExecutionContextFactory["resolve"]>>> {
      return {
        models: testCatalogPort(),
        modelTurnExecutor: options.executor,
        stepIds,
        tools: options.tools ?? [],
        ...(options.historyPrefix === undefined ? {} : { historyPrefix: options.historyPrefix }),
        createContextEngine: () => options.createContextEngine?.() ?? contextEngine,
      };
    },
  };
  return { factory, executor: options.executor, contextEngine };
}

function defaultStepIdFactory(): () => StepId {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `stp_0195f3a0-0000-7000-8000-${String(sequence).padStart(12, "0")}` as StepId;
  };
}

/** The permissive catalog of `model-turns.ts`, re-read as the canonical `ModelCatalog` port. */
function testCatalogPort(): import("@caelush/ai").ModelCatalog {
  const descriptor = {
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
    resolve: (ref) =>
      ({ ...descriptor, ref }) as ReturnType<import("@caelush/ai").ModelCatalog["resolve"]>,
    has: () => true,
    list: () => [],
  };
}
