import { AIError, createAIError } from "@caelush/ai";
import type { AIModelRequest, AIModelTurnResult } from "@caelush/ai";
import type {
  AgentTurnRef,
  ModelTurnExecutionInput,
  ModelTurnExecutionResult,
  ModelTurnExecutor,
} from "@caelush/agent";
import { createStepId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createLegacyModelTurnExecutor } from "../src/legacy-model-turn-executor.js";

/**
 * The transitional legacy facade over the frozen `ModelTurnExecutor`.
 *
 * Phase 3A aligned the agent executor with the frozen union result. The Core consumers that
 * were written against the previous throw-based semantics keep working through this
 * adapter, and these tests pin the three mappings that matter — including the cancellation
 * mapping, because turning a cancellation into a retryable provider failure would be a real
 * behavioural regression.
 */

const CALL_ID = "llm_0195f3a0-0000-7000-8000-000000000000";

const REQUEST: AIModelRequest = {
  model: { provider: "test", model: "model-a" },
  messages: [{ role: "user", content: "hello" }],
};

const TURN_RESULT: AIModelTurnResult = {
  callId: CALL_ID as never,
  providerId: "test",
  model: { provider: "test", model: "model-a" },
  text: "answer",
  toolCalls: [],
  finishReason: "STOP",
  resolution: {
    api: "test-api",
    reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
    cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
  } as never,
};

const RUN = {
  runId: "run_0195f3a0-0000-7000-8000-000000000000",
  sessionId: "ses_0195f3a0-0000-7000-8000-000000000000",
  goal: "answer the question",
} as const;

function adapter(result: ModelTurnExecutionResult): {
  readonly executor: ReturnType<typeof createLegacyModelTurnExecutor>;
  turns(): readonly AgentTurnRef[];
  inputs(): readonly ModelTurnExecutionInput[];
} {
  const turns: AgentTurnRef[] = [];
  const inputs: ModelTurnExecutionInput[] = [];
  const frozen: ModelTurnExecutor = {
    execute: (input) => {
      turns.push(input.turn);
      inputs.push(input);
      return Promise.resolve(result);
    },
  };
  return {
    executor: createLegacyModelTurnExecutor({
      executor: frozen,
      identity: () => ({
        runId: RUN.runId as never,
        sessionId: RUN.sessionId as never,
        goal: RUN.goal,
      }),
      createStepId,
    }),
    turns: () => turns,
    inputs: () => inputs,
  };
}

describe("LegacyModelTurnExecutorAdapter", () => {
  it("returns the turn result for COMPLETED", async () => {
    const fake = adapter({ kind: "COMPLETED", result: TURN_RESULT });

    await expect(
      fake.executor.execute({ request: REQUEST, signal: new AbortController().signal }),
    ).resolves.toBe(TURN_RESULT);
  });

  it("throws the mapped AI error for FAILED", async () => {
    const fake = adapter({
      kind: "FAILED",
      error: { code: "RATE_LIMIT", message: "slow down", retryable: true, retryAfterMs: 1_500 },
    });

    await expect(
      fake.executor.execute({ request: REQUEST, signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "AI_RATE_LIMIT",
      retryable: true,
      retryAfterMs: 1_500,
      message: "slow down",
    });
  });

  it.each([
    ["AUTHENTICATION", "AI_AUTHENTICATION"],
    ["NETWORK", "AI_NETWORK"],
    ["TIMEOUT", "AI_TIMEOUT"],
    ["CONTEXT_OVERFLOW", "AI_CONTEXT_OVERFLOW"],
    ["INVALID_RESPONSE", "AI_INVALID_RESPONSE"],
    ["UNSUPPORTED_MODEL", "AI_MODEL_UNSUPPORTED"],
    ["UNSUPPORTED_CAPABILITY", "AI_CAPABILITY_UNSUPPORTED"],
    ["PROVIDER_ERROR", "AI_PROVIDER_ERROR"],
  ])("maps the frozen %s code back onto %s", async (frozenCode, aiCode) => {
    const fake = adapter({
      kind: "FAILED",
      error: { code: frozenCode as never, message: "failed", retryable: false },
    });

    await expect(
      fake.executor.execute({ request: REQUEST, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: aiCode });
  });

  it("throws a cancellation signal rather than a retryable failure for CANCELLED", async () => {
    const fake = adapter({ kind: "CANCELLED" });

    const error = await fake.executor
      .execute({ request: REQUEST, signal: new AbortController().signal })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(AIError);
    expect(error).toMatchObject({ code: "AI_ABORTED", retryable: false });
  });

  it("supplies a turn ref with a sequence of at least one and a caller-owned step id", async () => {
    const fake = adapter({ kind: "COMPLETED", result: TURN_RESULT });

    await fake.executor.execute({ request: REQUEST, signal: new AbortController().signal });
    await fake.executor.execute({ request: REQUEST, signal: new AbortController().signal });

    const turns = fake.turns();
    expect(turns).toHaveLength(2);
    for (const turn of turns) {
      expect(turn.sequence).toBeGreaterThanOrEqual(1);
      expect(turn.stepId).toMatch(/^stp_/);
    }
    expect(turns[0]?.sequence).toBe(1);
    expect(turns[1]?.sequence).toBe(2);
  });

  it("passes the Run identity and the caller signal through unchanged", async () => {
    const fake = adapter({ kind: "COMPLETED", result: TURN_RESULT });
    const controller = new AbortController();

    await fake.executor.execute({ request: REQUEST, signal: controller.signal });

    expect(fake.inputs()[0]?.identity).toEqual(RUN);
    expect(fake.inputs()[0]?.signal).toBe(controller.signal);
    expect(fake.inputs()[0]?.request).toBe(REQUEST);
  });

  it("keeps the original frozen error reachable as the cause and out of the message", async () => {
    const fake = adapter({
      kind: "FAILED",
      error: { code: "NETWORK", message: "provider unreachable", retryable: true },
    });

    await expect(
      fake.executor.execute({ request: REQUEST, signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      cause: { code: "NETWORK", message: "provider unreachable", retryable: true },
    });
  });

  it("keeps cancellation distinguishable from an ordinary mapped failure", () => {
    // `AI_ABORTED` is the code the legacy error mapper reads to reach CANCELLED, and the
    // frozen AI table marks it non-retryable, so a cancellation can never become a retry.
    expect(createAIError("AI_ABORTED").retryable).toBe(false);
    expect(createAIError("AI_RATE_LIMIT").retryable).toBe(true);
  });
});
