import { createRunId, createStepId, type AgentStep } from "@caelush/protocol";
import { describe, expect, it } from "vitest";

import {
  classifyInterruptedStep,
  type InterruptedStepFacts,
} from "../src/interrupted-step-recovery.js";

const stepId = createStepId();

function facts(overrides: Partial<InterruptedStepFacts> = {}): InterruptedStepFacts {
  return {
    run: { status: "RUNNING" },
    activeStep: { id: stepId },
    providerAttemptStarted: false,
    conversationRecords: [],
    ...overrides,
  };
}

describe("classifyInterruptedStep", () => {
  it("replays a RUNNING Step that produced no durable message", () => {
    expect(classifyInterruptedStep(facts())).toBe("REPLAY_SAFE");
  });

  it("fails closed when the Step produced an assistant record", () => {
    expect(
      classifyInterruptedStep(
        facts({
          conversationRecords: [{ messageType: "ASSISTANT", sourceStepId: stepId }],
        }),
      ),
    ).toBe("FAIL_CLOSED");
  });

  it("fails closed when provider I/O started or its boundary is unknown", () => {
    expect(classifyInterruptedStep(facts({ providerAttemptStarted: true }))).toBe("FAIL_CLOSED");
    expect(classifyInterruptedStep(facts({ providerAttemptStarted: undefined }))).toBe(
      "FAIL_CLOSED",
    );
  });

  it("ignores records that belong to another Step", () => {
    expect(
      classifyInterruptedStep(
        facts({
          conversationRecords: [
            { messageType: "ASSISTANT", sourceStepId: createStepId() },
            { messageType: "USER" },
          ],
        }),
      ),
    ).toBe("REPLAY_SAFE");
  });

  it("fails closed when a continuation already owns the boundary", () => {
    expect(
      classifyInterruptedStep(
        facts({
          continuation: {
            type: "WAITING_RETRY",
            runId: createRunId(),
            failedStepId: stepId,
            attempt: 1,
            maxAttempts: 6,
            nextAttemptAt: 1 as AgentStep["startedAt"],
            errorCode: "LLM_NETWORK",
            mode: "START",
          },
        }),
      ),
    ).toBe("FAIL_CLOSED");
  });

  it("never replays from a status that owns a different boundary", () => {
    for (const status of ["VERIFYING", "WAITING_APPROVAL", "WAITING_RESOURCE"] as const) {
      expect(classifyInterruptedStep(facts({ run: { status } }))).toBe("FAIL_CLOSED");
    }
  });

  it("fails closed when there is no active Step to settle", () => {
    expect(classifyInterruptedStep(facts({ activeStep: undefined }))).toBe("FAIL_CLOSED");
  });
});
