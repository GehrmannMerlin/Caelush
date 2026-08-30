import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { resolveRunTerminationAuthority } from "../src/run-termination-authority.js";

function makeRun(status: "RUNNING" | "TIMEOUT" = "RUNNING") {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "test termination",
    status,
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "test", model: "test" },
    runtime: { id: "local", kind: "test" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(100),
    startedAt: createTimestampMs(200),
  });
}

describe("resolveRunTerminationAuthority", () => {
  it("preserves an existing terminal Run", () => {
    expect(
      resolveRunTerminationAuthority({ run: makeRun("TIMEOUT"), now: createTimestampMs(9999) }),
    ).toBe("TERMINAL");
  });

  it("gives durable cancellation priority before timeout settlement", () => {
    const run = makeRun();
    expect(
      resolveRunTerminationAuthority({
        run,
        now: createTimestampMs(1200),
        cancellationIntent: {
          runId: run.id,
          cause: "USER_REQUESTED",
          requestedAt: createTimestampMs(1200),
        },
        abortCause: "DEADLINE_EXCEEDED",
      }),
    ).toBe("CANCELLED");
  });

  it("resolves an expired Run as timeout", () => {
    expect(
      resolveRunTerminationAuthority({
        run: makeRun(),
        now: createTimestampMs(1200),
        abortCause: "DEADLINE_EXCEEDED",
      }),
    ).toBe("TIMEOUT");
  });

  it("does not classify an unrelated abort as cancellation", () => {
    expect(
      resolveRunTerminationAuthority({
        run: makeRun(),
        now: createTimestampMs(300),
        aborted: true,
      }),
    ).toBe("UNEXPECTED_ABORT");
  });
});
