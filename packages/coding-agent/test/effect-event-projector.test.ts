import {
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createToolInvocationId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { toolEffectsToEvents } from "../src/tools/effects/event-projector.js";

describe("Coding Tool effect event identity", () => {
  it("writes the owning invocation id on each newly projected file effect", () => {
    const invocationId = createToolInvocationId();
    const events = toolEffectsToEvents(
      [
        {
          type: "FILE_CHANGE",
          invocationId,
          summary: { path: "login.html", changeType: "CREATED", additions: 214, deletions: 0 },
        },
        {
          type: "FILE_CHANGE",
          invocationId,
          fromPath: "old.html",
          toPath: "new.html",
          summary: { path: "new.html", changeType: "MOVED", additions: 2, deletions: 1 },
        },
      ],
      {
        runId: createRunId(),
        sessionId: createSessionId(),
        stepId: createStepId(),
        timestamp: 1_700_000_000_000 as never,
        nextEventId: createEventId,
      },
    );

    expect(events.map((event) => event.payload.invocationId)).toEqual([invocationId, invocationId]);
    expect(events[1]?.payload).toMatchObject({ additions: 2, deletions: 1 });
  });
});
