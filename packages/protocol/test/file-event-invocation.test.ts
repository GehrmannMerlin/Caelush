import {
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  RunEventSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const runId = createRunId();
const sessionId = createSessionId();
const stepId = createStepId();
const invocationId = "tinv_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a";

function fileEvent(type: string, payload: Record<string, unknown>) {
  return RunEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    stepId,
    timestamp: 1_700_000_000_000,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence: 1 },
    type,
    payload,
  });
}

describe("file effect event invocation identity", () => {
  it("accepts legacy file events and scopes new file effects to a ToolInvocation", () => {
    const legacy = fileEvent("file.created", {
      summary: { path: "login.html", changeType: "CREATED", additions: 214, deletions: 0 },
    });
    expect(legacy.type).toBe("file.created");

    const correlated = fileEvent("file.created", {
      invocationId,
      summary: { path: "login.html", changeType: "CREATED", additions: 214, deletions: 0 },
    });
    expect(correlated).toMatchObject({
      type: "file.created",
      payload: { invocationId, summary: { path: "login.html" } },
    });

    expect(
      fileEvent("file.moved", {
        invocationId,
        fromPath: "old.html",
        toPath: "new.html",
        additions: 3,
        deletions: 1,
      }),
    ).toMatchObject({
      type: "file.moved",
      payload: {
        invocationId,
        fromPath: "old.html",
        toPath: "new.html",
        additions: 3,
        deletions: 1,
      },
    });
  });
});
