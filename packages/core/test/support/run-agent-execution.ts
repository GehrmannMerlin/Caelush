import { createAIError } from "@caelush/ai";
import type {
  AIMessage,
  AIModelRequest,
  AIModelTurnResult,
  AIToolResultMessage,
  AIToolSpec,
  ModelDescriptor,
} from "@caelush/ai";
import { toModelTurnExecutionError } from "@caelush/agent";
import type {
  AgentTurnRef,
  ContextEnginePort,
  ContextPrepareInput,
  ModelTurnExecutionResult,
  ModelTurnExecutor,
  PreparedModelContext,
} from "@caelush/agent";
import type { StepId } from "@caelush/protocol";

import type { RunAgentExecutionContextFactory } from "../../src/run-agent-execution.js";
import {
  modelTurnResult,
  testModelCatalog,
  type PartialTurnResult,
} from "./fake-model-turn-executor.js";

/**
 * Test support for the production direct Agent execution path.
 *
 * ```text
 * RunController → createAgentLoop(...) → createRunExecutionDriver(...) → AgentLoop.advance()
 * ```
 *
 * Phase 3C checkpoint 6 retired the legacy Core `AgentLoop` facade, so a test that drives a Run no
 * longer hands the controller a facade plus a throwing `LegacyModelTurnExecutor`. It hands it the
 * frozen collaborator ports — a `ModelCatalog`, a frozen `ModelTurnExecutor`, a Step identity
 * factory and a `ContextEnginePort` — exactly as the daemon composition does.
 *
 * This module is the test-side projection of that composition, and it is deliberately thin: a
 * scripted frozen executor that returns the *frozen union* (so a failure is a value, never a
 * thrown exception) and a minimal context engine that renders the turn the way the general loop
 * expects to see it.
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
 * A scripted frozen model turn executor.
 *
 * A script that throws a real `AIError` is reported as the mapped `FAILED` union member, which is
 * exactly what the production executor does — so a test can keep scripting a provider failure while
 * observing the frozen contract.
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
        return { kind: "FAILED", error: toModelTurnExecutionError(asAIError(error)) };
      }
    },
  };
}

function isFrozenResult(value: unknown): value is ModelTurnExecutionResult {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { readonly kind?: unknown }).kind;
  return kind === "COMPLETED" || kind === "FAILED" || kind === "CANCELLED";
}

/** Normalize a thrown test fixture into the AI error the frozen mapper consumes. */
function asAIError(error: unknown): Error {
  if (error instanceof Error && typeof (error as { readonly code?: unknown }).code === "string") {
    return error;
  }
  return createAIError("AI_PROVIDER_ERROR", "The model turn failed.", { cause: error });
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
 * It renders the current turn the way the general loop describes it — previous history, the
 * pending assistant tool call when there is one, then the turn's own messages — which is what a
 * test needs in order to assert what the model was shown. It reads nothing from the environment and
 * has no project knowledge: a general kernel test has none to give it.
 */
export function fakeContextEngine(
  overrides: { readonly report?: PreparedModelContext["report"] } = {},
): FakeContextEngine {
  const preparations: PreparedTestContext[] = [];
  const engine: FakeContextEngine = {
    preparations,
    async prepare(input: ContextPrepareInput): Promise<PreparedModelContext> {
      if (engine.prepareFailure !== undefined) throw engine.prepareFailure;
      preparations.push({ mode: input.mode, messages: input.history });
      return {
        messages: [...input.history, ...turnMessages(input)],
        report: overrides.report ?? defaultReport(input),
        observationPolicy: { maxSingleObservationTokens: 4_000, maxObservationBatchTokens: 12_000 },
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

function defaultReport(input: ContextPrepareInput): PreparedModelContext["report"] {
  return {
    estimatedInputTokens: 1,
    effectiveInputLimitTokens: input.model.limits.contextWindowTokens,
    remainingTokens: input.model.limits.contextWindowTokens - 1,
    pressure: "NORMAL",
    compactionCount: 0,
    contributions: [],
  };
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
  /**
   * Observe every provider turn the Run Layer dispatches.
   *
   * The frozen `ModelTurnExecutor` is the only object that sees both the `AgentTurnRef` the Run
   * Layer allocated *and* the request it was sent, so a test that asserts Step ownership or
   * model-visible history hooks here rather than at a facade that no longer exists.
   */
  readonly onTurn?: (turn: AgentTurnRef, request: AIModelRequest) => void;
}): TestRunAgentExecution {
  const contextEngine = options.contextEngine ?? fakeContextEngine();
  const models = testModelCatalog();
  const stepIds = { create: options.createStepId ?? defaultStepIdFactory() };
  const observed = observeTurns(options.executor, options.onTurn);
  const factory: RunAgentExecutionContextFactory = {
    async resolve(): Promise<Awaited<ReturnType<RunAgentExecutionContextFactory["resolve"]>>> {
      return {
        models,
        modelTurnExecutor: observed,
        stepIds,
        tools: options.tools ?? [],
        ...(options.historyPrefix === undefined ? {} : { historyPrefix: options.historyPrefix }),
        createContextEngine: () => options.createContextEngine?.() ?? contextEngine,
      };
    },
  };
  return { factory, executor: options.executor, contextEngine };
}

/** Wrap an executor so the turn reference it was handed is observable. */
function observeTurns(
  executor: FakeFrozenModelTurnExecutor,
  onTurn?: (turn: AgentTurnRef, request: AIModelRequest) => void,
): ModelTurnExecutor {
  if (onTurn === undefined) return executor;
  return {
    execute: async (input) => {
      onTurn(input.turn, input.request);
      return executor.execute(input);
    },
  };
}

function defaultStepIdFactory(): () => StepId {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `stp_0195f3a0-0000-7000-8000-${String(sequence).padStart(12, "0")}` as StepId;
  };
}

/** The descriptor a test catalog resolves to, for assertions about the resolved model authority. */
export function testModelDescriptor(
  provider = "fixture",
  model = "fixture-model",
): ModelDescriptor {
  return testModelCatalog().resolve({ provider, model });
}

export type { AIModelTurnResult, AIToolSpec };
