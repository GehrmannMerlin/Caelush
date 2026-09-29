import {
  AgentRunSchema,
  createLLMCallId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createVerificationCheckId,
  createVerificationPlanId,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { TaskAcceptanceReviewer } from "../src/index.js";
import type { RunBudgetPort, RunLLMBudgetAdmissionInput } from "../src/budget-ports.js";
import { buildTaskReviewBundle } from "@caelush/verification";
import { fakeModelTurnExecutor } from "./support/fake-model-turn-executor.js";

function fixture() {
  const run = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "Implement the requested change.",
    status: "VERIFYING",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "fixture", model: "reviewer" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 3, maxToolCalls: 10, timeoutMs: 1_000, maxTokens: 10_000 },
    createdAt: createTimestampMs(0),
  });
  const planId = createVerificationPlanId();
  const taskCheck = {
    id: createVerificationCheckId(),
    planId,
    ordinal: 0,
    stage: "ACCEPTANCE" as const,
    requirement: "REQUIRED" as const,
    spec: { kind: "TASK" as const, purpose: "ACCEPTANCE" as const, source: "SYSTEM" as const },
    status: "PENDING" as const,
    createdAt: createTimestampMs(0),
  };
  const bundle = buildTaskReviewBundle({
    originalGoal: run.goal,
    candidateText: "Implemented it.",
    plan: {
      id: planId,
      runId: run.id,
      sourceStepId: createStepId(),
      plannerVersion: "test",
      planHash: "a".repeat(64),
      checks: [taskCheck],
      createdAt: createTimestampMs(0),
    },
    evidence: [],
    changedFiles: [],
  });
  return { run, bundle };
}

/**
 * A complete, structurally-typed budget port.
 *
 * It is a real `RunBudgetPort`, not a partial object behind a cast: the reviewer is exercised against
 * the same contract production uses, and every required method is implemented so a test never has to
 * reach for `as unknown as` to satisfy the compiler.
 */
interface BudgetSpy extends RunBudgetPort {
  /** Every admission and settlement the reviewer performed, in order. */
  readonly calls: string[];
}

function budget(
  hooks: {
    readonly onAdmission?: (admission: RunLLMBudgetAdmissionInput) => void;
    readonly claimOwner?: (ownerId: string) => void;
  } = {},
): BudgetSpy {
  const calls: string[] = [];
  return {
    calls,
    async admitLLM() {
      // The Run path's admission, never the reviewer's. Reaching it would mean the reviewer charged a
      // Step budget instead of a verification budget.
      calls.push("admitLLM");
      return { kind: "ALLOWED" };
    },
    async settleLLM() {
      calls.push("settleLLM");
    },
    async admitVerificationLLM(input) {
      hooks.claimOwner?.(input.ownerId);
      calls.push(`admit:${input.ownerId}`);
      hooks.onAdmission?.(input.admission);
      return { kind: "ALLOWED" };
    },
    async settleVerificationLLM(input) {
      calls.push(`settle:${input.ownerId}`);
      return { kind: "SETTLED" };
    },
    async markVerificationLLMConservative(input) {
      calls.push(`conservative:${input.ownerId}`);
    },
  };
}

function turn(
  text: string,
  toolCalls: [] | [{ id: string; name: "read_file"; input: { path: string } }] = [],
) {
  return {
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "reviewer" },
    text,
    toolCalls,
    finishReason: "STOP" as const,
    usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
  };
}

describe("TaskAcceptanceReviewer", () => {
  it("uses the current model with no tools and settles shared reviewer budget", async () => {
    const { run, bundle } = fixture();
    const calls: unknown[] = [];
    const reviewer = new TaskAcceptanceReviewer({
      modelTurns: fakeModelTurnExecutor(async (request) => {
        calls.push(request);
        return turn('{"verdict":"PASS","summary":"The evidence supports the goal."}');
      }),
      budget: budget(),
      clock: { now: () => createTimestampMs(50) },
    });
    const result = await reviewer.review({
      run,
      candidateText: "Implemented it.",
      bundle,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("PASSED");
    expect(result.reviewInputHash).toBe(bundle.reviewInputHash);
    expect(calls).toHaveLength(1);
    // The reviewer is not an agent turn: it asks the same gateway for a tool-free turn.
    expect(calls[0]).toMatchObject({
      model: { provider: "fixture", model: "reviewer" },
      toolChoice: { type: "NONE" },
    });
  });

  it("reserves reasoning headroom for protocol-valid reviewer output", async () => {
    const { run, bundle } = fixture();
    const requests: unknown[] = [];
    const configuredOutputTokens: number[] = [];
    const reviewer = new TaskAcceptanceReviewer({
      modelTurns: fakeModelTurnExecutor(async (request) => {
        requests.push(request);
        return turn('{"verdict":"PASS","summary":"The evidence supports the goal."}');
      }),
      budget: budget({
        onAdmission: (admission) => {
          if (admission.configuredMaxOutputTokens !== undefined) {
            configuredOutputTokens.push(admission.configuredMaxOutputTokens);
          }
        },
      }),
      clock: { now: () => createTimestampMs(50) },
    });

    await reviewer.review({
      run,
      candidateText: "Implemented it.",
      bundle,
      signal: new AbortController().signal,
    });

    expect(configuredOutputTokens).toEqual([8_192]);
    expect(requests[0]).toMatchObject({ settings: { maxOutputTokens: 8_192 } });
  });

  it("fails closed for tool calls and malformed reviewer output", async () => {
    const { run, bundle } = fixture();
    const make = (response: ReturnType<typeof turn>) =>
      new TaskAcceptanceReviewer({
        modelTurns: fakeModelTurnExecutor(async () => response),
        budget: budget(),
        clock: { now: () => createTimestampMs(50) },
      });
    await expect(
      make(turn("{}", [{ id: "x", name: "read_file", input: { path: "x" } }])).review({
        run,
        candidateText: "Implemented it.",
        bundle,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "ERROR", errorCode: "REVIEWER_TOOLS_FORBIDDEN" });
    await expect(
      make(turn("not-json")).review({
        run,
        candidateText: "Implemented it.",
        bundle,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "ERROR", errorCode: "REVIEWER_RESPONSE_INVALID" });
  });

  it("retries one protocol-invalid reviewer response before accepting a valid verdict", async () => {
    const { run, bundle } = fixture();
    const responses = ["not-json", '{"verdict":"PASS","summary":"Evidence matches."}'];
    const modelTurns = fakeModelTurnExecutor(async (_request, _signal, callIndex) =>
      turn(responses[callIndex] ?? "not-json"),
    );
    const budgets = budget();
    const reviewer = new TaskAcceptanceReviewer({
      modelTurns,
      budget: budgets,
      clock: { now: () => createTimestampMs(50) },
    });

    const result = await reviewer.review({
      run,
      candidateText: "Implemented it.",
      bundle,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("PASSED");
    expect(modelTurns.callCount()).toBe(2);
    expect(budgets.calls.filter((call) => call.startsWith("admit:")).length).toBe(2);
    expect(budgets.calls.filter((call) => call.startsWith("settle:")).length).toBe(2);
    expect(modelTurns.requests[1]?.messages[0]?.content).toContain("single JSON object");
  });

  it("bounds protocol retry after two invalid reviewer responses", async () => {
    const { run, bundle } = fixture();
    const modelTurns = fakeModelTurnExecutor(async () => turn("not-json"));
    const reviewer = new TaskAcceptanceReviewer({
      modelTurns,
      budget: budget(),
      clock: { now: () => createTimestampMs(50) },
    });

    const result = await reviewer.review({
      run,
      candidateText: "Implemented it.",
      bundle,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: "ERROR", errorCode: "REVIEWER_RESPONSE_INVALID" });
    expect(modelTurns.callCount()).toBe(2);
  });

  it("uses a fresh durable budget owner for each review invocation", async () => {
    const { run, bundle } = fixture();
    const ownerIds: string[] = [];
    const responses = ["not-json", "not-json", '{"verdict":"PASS","summary":"Evidence matches."}'];
    const modelTurns = fakeModelTurnExecutor(async (_request, _signal, callIndex) =>
      turn(responses[callIndex] ?? "not-json"),
    );
    // A durable budget owner is claimed exactly once per review invocation: a second admission with
    // the same owner is a protocol violation, so the fake fails loudly instead of silently reusing it.
    const durableBudget = budget({
      claimOwner: (ownerId) => {
        if (ownerIds.includes(ownerId)) {
          throw new Error("duplicate verification budget owner");
        }
        ownerIds.push(ownerId);
      },
    });
    const reviewer = new TaskAcceptanceReviewer({
      modelTurns,
      budget: durableBudget,
      clock: { now: () => createTimestampMs(50) },
    });

    await expect(
      reviewer.review({
        run,
        candidateText: "Implemented it.",
        bundle,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "ERROR", errorCode: "REVIEWER_RESPONSE_INVALID" });
    await expect(
      reviewer.review({
        run,
        candidateText: "Implemented it.",
        bundle,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "PASSED" });

    expect(ownerIds).toHaveLength(3);
    expect(new Set(ownerIds).size).toBe(ownerIds.length);
  });
});
