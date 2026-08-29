import {
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createObservationId,
  type AgentError,
  type ToolInvocation,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  assertToolInvocationInvariant,
  assertToolInvocationTransition,
  assertToolObservationInvariant,
  completeToolInvocation,
  createRequestedToolInvocation,
  createToolObservation,
  failToolInvocation,
  markToolInvocationWaitingApproval,
  startToolInvocation,
} from "../src/invocation-lifecycle.js";

function makeRequested(): ToolInvocation {
  return createRequestedToolInvocation({
    id: createToolInvocationId(),
    runId: createRunId(),
    stepId: createStepId(),
    toolName: "echo_value",
    externalCallId: "call-1",
    args: { value: "hello" },
    riskLevel: "LOW",
    createdAt: createTimestampMs(100),
  });
}

const error: AgentError = {
  code: "TOOL_EXECUTION_ERROR",
  message: "Tool execution returned an error result.",
  retryable: false,
  phase: "TOOL",
};

describe("ToolInvocation lifecycle", () => {
  it("allows the durable requested-to-terminal lifecycle", () => {
    const requested = makeRequested();
    const running = startToolInvocation(requested, createTimestampMs(110));
    const completed = completeToolInvocation(running, createTimestampMs(120));

    expect(requested.status).toBe("REQUESTED");
    expect(running.status).toBe("RUNNING");
    expect(completed.status).toBe("COMPLETED");
    expect(completed.error).toBeUndefined();
    assertToolInvocationInvariant(completed);
  });

  it("allows approval and failure before the handler starts", () => {
    const waiting = markToolInvocationWaitingApproval(makeRequested());
    const failed = failToolInvocation(makeRequested(), error, createTimestampMs(130));

    expect(waiting.status).toBe("WAITING_APPROVAL");
    expect(waiting.startedAt).toBeUndefined();
    expect(failed.status).toBe("FAILED");
    expect(failed.startedAt).toBeUndefined();
    expect(failed.error).toEqual(error);
    assertToolInvocationInvariant(waiting);
    assertToolInvocationInvariant(failed);
  });

  it("rejects transitions out of terminal states and unsupported approval resume", () => {
    expect(() => assertToolInvocationTransition("COMPLETED", "RUNNING")).toThrow();
    expect(() => assertToolInvocationTransition("WAITING_APPROVAL", "RUNNING")).toThrow();
    expect(() => assertToolInvocationTransition("REQUESTED", "COMPLETED")).toThrow();
  });

  it("requires a matching tool observation for terminal settlement", () => {
    const invocation = completeToolInvocation(
      startToolInvocation(makeRequested(), createTimestampMs(110)),
      createTimestampMs(120),
    );
    const observation = createToolObservation({
      id: createObservationId(),
      runId: invocation.runId,
      stepId: invocation.stepId,
      toolInvocationId: invocation.id,
      content: "hello",
      details: { echoed: "hello" },
      isError: false,
      createdAt: createTimestampMs(120),
    });

    assertToolObservationInvariant(observation, invocation);
    expect(() =>
      assertToolObservationInvariant(
        { ...observation, toolInvocationId: createToolInvocationId() },
        invocation,
      ),
    ).toThrow();
  });

  it("enforces monotonic timestamps and one settlement timestamp", () => {
    const invocation = makeRequested();
    const invalidFailed = {
      ...invocation,
      status: "FAILED" as const,
      startedAt: createTimestampMs(99),
      finishedAt: createTimestampMs(101),
      error,
    };
    expect(() => assertToolInvocationInvariant(invalidFailed)).toThrow("startedAt");

    const completed = completeToolInvocation(
      startToolInvocation(invocation, createTimestampMs(100)),
      createTimestampMs(101),
    );
    const observation = createToolObservation({
      id: createObservationId(),
      runId: completed.runId,
      stepId: completed.stepId,
      toolInvocationId: completed.id,
      content: "hello",
      details: {},
      isError: false,
      createdAt: createTimestampMs(102),
    });
    expect(() => assertToolObservationInvariant(observation, completed)).toThrow(
      "settlement timestamp",
    );
  });
});
