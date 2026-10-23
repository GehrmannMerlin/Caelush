import {
  RunEventSchema,
  createEventId,
  createRunId,
  createSessionId,
  type RunEvent,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

import { DefaultPublicEventProjector } from "../src/events/public-event-projector.js";

/**
 * What the public stream may say about a Context preparation failure.
 *
 * ```text
 * published    the closed classification: stage, reason code, and a measured bound when one exists
 * withheld     everything else in `details` — free-form is where a message, a path or a prompt
 *              would travel, and the projector is the last place that can still refuse it
 * ```
 *
 * The projector is exercised directly rather than through a Run: this is a boundary test, and a
 * boundary that only held because some upstream producer happened to be well behaved would not be a
 * boundary at all.
 */

const projector = new DefaultPublicEventProjector();

function makeErrorEvent(details: unknown): RunEvent {
  return RunEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: 1,
    runId: createRunId(),
    sessionId: createSessionId(),
    type: "llm.failed",
    timestamp: 1_700_000_000_000,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence: 1 },
    payload: {
      model: { provider: "loopback", model: "scripted-model" },
      error: {
        code: "INTERNAL_ERROR",
        message: "The task context could not be prepared for this step.",
        retryable: false,
        phase: "INTERNAL",
        details,
      },
    },
  });
}

function projectedDetails(event: RunEvent): Record<string, unknown> | undefined {
  const projected = projector.project(event);
  expect(projected).not.toBeNull();
  const payload = projected?.payload as { error?: { details?: Record<string, unknown> } };
  return payload.error?.details;
}

describe("public projection of a Context preparation failure", () => {
  it("publishes the closed classification and the bound it measured", () => {
    const details = projectedDetails(
      makeErrorEvent({
        contextPreparation: {
          reasonCode: "CONTEXT_SURFACE_PERSISTENCE_FAILED",
          stage: "surface_persistence",
          dimension: "SECTION_STATES",
          observed: 2_049,
          limit: 2_048,
        },
      }),
    );

    expect(details).toStrictEqual({
      contextPreparation: {
        reasonCode: "CONTEXT_SURFACE_PERSISTENCE_FAILED",
        stage: "surface_persistence",
        dimension: "SECTION_STATES",
        observed: 2_049,
        limit: 2_048,
      },
    });
  });

  it("publishes nothing beside the classification, whatever else the detail carries", () => {
    const details = projectedDetails(
      makeErrorEvent({
        contextPreparation: {
          reasonCode: "CONTEXT_PREPARATION_FAILED",
          stage: "unknown",
        },
        prompt: "CANARY the whole task description",
        hostPath: "C:/Users/owner/.env",
        apiKey: "sk-CANARY",
        reasonCode: "CANARY_NOT_A_TOOL_CODE",
      }),
    );

    expect(details).toStrictEqual({
      contextPreparation: { reasonCode: "CONTEXT_PREPARATION_FAILED", stage: "unknown" },
    });
    const published = JSON.stringify(details);
    expect(published).not.toContain("CANARY");
    expect(published).not.toContain("Users");
  });

  it("withholds a detail it cannot validate instead of relaying it", () => {
    const details = projectedDetails(
      makeErrorEvent({
        contextPreparation: {
          reasonCode: "CONTEXT_CANARY_FAILURE",
          stage: "surface_capacity\nCANARY",
          observed: -1,
          limit: 1.5,
          dimension: "CANARY dimension with spaces",
        },
      }),
    );

    // Nothing survived validation, so the error carries no details at all rather than a shape the
    // projector could not vouch for.
    expect(details).toBeUndefined();
  });

  it("keeps publishing Tool reason codes unchanged", () => {
    const details = projectedDetails(makeErrorEvent({ reasonCode: "TOOL_PREPARATION_FAILED" }));

    expect(details).toStrictEqual({ reasonCode: "TOOL_PREPARATION_FAILED" });
  });
});
