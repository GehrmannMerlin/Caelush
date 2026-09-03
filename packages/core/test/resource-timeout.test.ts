import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { deriveRunDeadline } from "../src/run-deadline.js";

function makeRun(overrides: Record<string, unknown> = {}) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "long task",
    status: "RUNNING",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "test", model: "test" },
    runtime: { id: "local", kind: "test" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: {
      maxSteps: Number.MAX_SAFE_INTEGER,
      maxToolCalls: Number.MAX_SAFE_INTEGER,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    },
    resourcePolicy: {
      mode: "ADAPTIVE",
      operationalLease: { maxAgentTurns: 24, maxToolOperations: 64 },
      batch: { maxToolCallsPerTurn: 16 },
      progress: {
        windowTurns: 8,
        identicalCallNudgeThreshold: 3,
        noProgressTurnsBeforeReplan: 4,
        replansBeforePause: 2,
      },
      hardLimits: {},
      inactivity: {},
    },
    createdAt: createTimestampMs(100),
    startedAt: createTimestampMs(200),
    ...overrides,
  });
}

describe("Adaptive Run deadline", () => {
  it("does not create an implicit lifetime deadline without an explicit hard wall-clock limit", () => {
    expect(deriveRunDeadline(makeRun())).toBeUndefined();
  });

  it("uses the explicit Adaptive hard wall-clock limit from the original startedAt", () => {
    const deadline = deriveRunDeadline(
      makeRun({
        resourcePolicy: {
          ...makeRun().resourcePolicy,
          hardLimits: { maxWallClockMs: 1_000 },
        },
      }),
    );
    expect(deadline).toEqual({ startedAt: 200, timeoutMs: 1_000, deadlineAt: 1_200 });
  });

  it("keeps legacy timeout behavior unchanged", () => {
    const run = makeRun({
      resourcePolicy: undefined,
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1_000 },
    });
    expect(deriveRunDeadline(run)).toEqual({ startedAt: 200, timeoutMs: 1_000, deadlineAt: 1_200 });
  });
});
