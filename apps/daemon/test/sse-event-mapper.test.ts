import {
  AgentEventSchema,
  createEventId,
  createRunId,
  createSessionId,
  createToolInvocationId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { mapAgentEventToSse } from "../src/transport/sse-event-mapper.js";

function makeEvent(kind: "DURABLE" | "EPHEMERAL") {
  return AgentEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: 1,
    runId: createRunId(),
    sessionId: createSessionId(),
    type: "shell.output",
    timestamp: 1_700_000_000_000,
    visibility: "USER_VISIBLE",
    durability:
      kind === "DURABLE" ? { kind: "DURABLE", version: 1, sequence: 10 } : { kind: "EPHEMERAL" },
    payload: { invocationId: createToolInvocationId(), stream: "stdout", chunk: "hello" },
  });
}

describe("SSE event mapper", () => {
  it("maps a Durable event sequence to the SSE id", () => {
    const event = makeEvent("DURABLE");
    expect(mapAgentEventToSse(event)).toEqual({
      event: "shell.output",
      id: "10",
      data: event,
    });
  });

  it("does not assign an SSE id to an Ephemeral event", () => {
    const event = makeEvent("EPHEMERAL");
    const mapped = mapAgentEventToSse(event);
    expect(mapped.event).toBe("shell.output");
    expect(mapped.data).toEqual(event);
    expect(mapped).not.toHaveProperty("id");
  });
});
