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
import type { RunBudgetPort } from "../src/budget-ports.js";
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

function budget() {
  const calls: string[] = [];
  const value = {
    calls,
    async admitVerificationLLM(
      input: Parameters<NonNullable<RunBudgetPort["admitVerificationLLM"]>>[0],
    ) {
      calls.push(`admit:${input.ownerId}`);
      return { kind: "ALLOWED" as const };
    },
    async settleVerificationLLM(
      input: Parameters<NonNullable<RunBudgetPort["settleVerificationLLM"]>>[0],
    ) {
      calls.push(`settle:${input.ownerId}`);
      return { kind: "SETTLED" as const };
    },
  };
  return value as unknown as RunBudgetPort;
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
});
