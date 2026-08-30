import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  deriveRunDeadline,
  isRunDeadlineExceeded,
  remainingRunTimeMs,
} from "../src/run-deadline.js";

function makeRun(overrides: Record<string, unknown> = {}) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "test deadline",
    status: "RUNNING",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "test", model: "test" },
    runtime: { id: "local", kind: "test" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(100),
    startedAt: createTimestampMs(200),
    ...overrides,
  });
}

describe("Run deadline", () => {
  it("derives from startedAt instead of createdAt", () => {
    const deadline = deriveRunDeadline(makeRun());

    expect(deadline).toEqual({ startedAt: 200, timeoutMs: 1000, deadlineAt: 1200 });
  });

  it("does not create a deadline for a pending unstarted Run", () => {
    expect(deriveRunDeadline(makeRun({ status: "PENDING", startedAt: undefined }))).toBeUndefined();
  });

  it("treats the exact deadline as expired", () => {
    const deadline = deriveRunDeadline(makeRun())!;

    expect(isRunDeadlineExceeded(deadline, createTimestampMs(1199))).toBe(false);
    expect(isRunDeadlineExceeded(deadline, createTimestampMs(1200))).toBe(true);
    expect(isRunDeadlineExceeded(deadline, createTimestampMs(1201))).toBe(true);
  });

  it("rejects unsafe timeout and deadline arithmetic", () => {
    expect(() =>
      deriveRunDeadline(makeRun({ limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1.5 } })),
    ).toThrow();
    expect(() =>
      deriveRunDeadline(
        makeRun({
          startedAt: Number.MAX_SAFE_INTEGER - 1,
          limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 2 },
        }),
      ),
    ).toThrow();
  });

  it("returns non-negative remaining wall-clock time", () => {
    const deadline = deriveRunDeadline(makeRun())!;

    expect(remainingRunTimeMs(deadline, createTimestampMs(800))).toBe(400);
    expect(remainingRunTimeMs(deadline, createTimestampMs(1400))).toBe(0);
  });
});
