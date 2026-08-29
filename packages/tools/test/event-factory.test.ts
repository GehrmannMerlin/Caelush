import {
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createRequestedToolInvocation } from "../src/invocation-lifecycle.js";
import {
  createToolCompletedEvent,
  createToolFailedEvent,
  createToolRequestedEvent,
  createToolStartedEvent,
} from "../src/event-factory.js";

function invocation() {
  return createRequestedToolInvocation({
    id: createToolInvocationId(),
    runId: createRunId(),
    stepId: createStepId(),
    externalCallId: "call-1",
    toolName: "echo_value",
    args: { secret: "private" },
    riskLevel: "LOW",
    createdAt: createTimestampMs(100),
  });
}

describe("tool lifecycle event factory", () => {
  it("creates sanitized durable lifecycle drafts", () => {
    const value = invocation();
    const common = {
      eventId: createEventId(),
      sessionId: createSessionId(),
      timestamp: createTimestampMs(100),
    };
    const requested = createToolRequestedEvent({ ...common, invocation: value });
    const started = createToolStartedEvent({ ...common, invocation: value });
    const completed = createToolCompletedEvent({
      ...common,
      invocation: value,
      observationId: createObservationId(),
    });
    const failed = createToolFailedEvent({
      ...common,
      invocation: value,
      error: {
        code: "TOOL_EXECUTION_ERROR",
        message: "safe",
        retryable: false,
        phase: "TOOL",
      },
    });

    expect([requested, started, completed, failed].map((event) => event.durability.kind)).toEqual([
      "DURABLE",
      "DURABLE",
      "DURABLE",
      "DURABLE",
    ]);
    expect(requested.payload).not.toHaveProperty("args");
    expect(JSON.stringify([requested, started, completed, failed])).not.toContain("private");
  });
});
