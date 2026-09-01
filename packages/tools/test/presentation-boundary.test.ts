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
import {
  createToolCompletedEvent,
  createToolOutputEvent,
  createToolRequestedEvent,
  createRequestedToolInvocation,
  type ToolPresentationPort,
} from "../src/index.js";

const invocation = createRequestedToolInvocation({
  id: createToolInvocationId(),
  runId: createRunId(),
  stepId: createStepId(),
  externalCallId: "call-1",
  toolName: "read_file",
  args: { path: "src/index.ts" },
  riskLevel: "LOW",
  createdAt: createTimestampMs(1),
});

const presentation: ToolPresentationPort = {
  presentInvocation: () => ({ title: "Read file", summary: "Read file src/index.ts" }),
  presentResult: () => ({
    title: "Read file",
    summary: "Read file completed",
    output: { stream: "stdout", chunk: "2 lines" },
  }),
  presentShellCommand: () => "Run command",
};

describe("Tool presentation boundary", () => {
  it("keeps presentation data outside the Tool event payload contract", () => {
    const common = {
      eventId: createEventId(),
      sessionId: createSessionId(),
      timestamp: createTimestampMs(1),
      invocation,
    };
    const requested = createToolRequestedEvent({ ...common, presentation });
    const completed = createToolCompletedEvent({
      ...common,
      presentation,
      observationId: createObservationId(),
    });

    expect(requested).toMatchObject({
      type: "tool.requested",
      title: "Read file",
      summary: "Read file src/index.ts",
    });
    expect(completed).toMatchObject({
      type: "tool.completed",
      title: "Read file",
      summary: "Read file completed",
    });
    expect(JSON.stringify([requested, completed])).not.toContain('"args"');
  });

  it("creates a bounded output event from a presentation result", () => {
    const event = createToolOutputEvent({
      eventId: createEventId(),
      sessionId: createSessionId(),
      timestamp: createTimestampMs(1),
      invocation,
      presentation,
    });

    expect(event).toBeDefined();
    if (event === undefined) throw new Error("expected a presentation output event");
    expect(event).toMatchObject({
      type: "tool.output",
      payload: { invocationId: invocation.id, stream: "stdout", chunk: "2 lines" },
    });
    expect(event.durability.kind).toBe("DURABLE");
  });

  it("omits presentation fields when the projector fails closed", () => {
    const failing: ToolPresentationPort = {
      presentInvocation: () => {
        throw new Error("unsafe");
      },
      presentResult: () => {
        throw new Error("unsafe");
      },
      presentShellCommand: () => {
        throw new Error("unsafe");
      },
    };
    const event = createToolRequestedEvent({
      eventId: createEventId(),
      sessionId: createSessionId(),
      timestamp: createTimestampMs(1),
      invocation,
      presentation: failing,
    });

    expect(event).not.toHaveProperty("title");
    expect(event).not.toHaveProperty("summary");
    expect(JSON.stringify(event)).not.toContain("unsafe");
  });

  it("rejects malformed or oversized presentation values without blocking settlement", () => {
    const malformed: ToolPresentationPort = {
      presentInvocation: () => ({ title: "", summary: "safe summary" }),
      presentResult: () => ({
        title: "safe title",
        summary: "safe summary",
        output: { stream: "stdout", chunk: "x".repeat(8 * 1024 + 1) },
      }),
      presentShellCommand: () => "safe command",
    };
    const common = {
      eventId: createEventId(),
      sessionId: createSessionId(),
      timestamp: createTimestampMs(1),
      invocation,
      presentation: malformed,
    };

    const requested = createToolRequestedEvent(common);
    const completed = createToolCompletedEvent({
      ...common,
      observationId: createObservationId(),
    });
    const output = createToolOutputEvent(common);

    expect(requested).not.toHaveProperty("title");
    expect(requested).toHaveProperty("summary", "safe summary");
    expect(completed).toHaveProperty("title", "safe title");
    expect(output).toBeUndefined();
  });
});
