import { describe, expect, it } from "vitest";
import { projectProcessOutcome } from "../src/tools/operations/process-outcome.js";
import {
  aggregateTaskPlanEvidenceState,
  resolveTaskPlanEvidence,
  type TaskPlanEvidenceFact,
} from "../src/tools/plan/task-plan-evidence.js";

const identity = { sessionId: "session-current", runId: "run-current" };

function fact(overrides: Partial<TaskPlanEvidenceFact> = {}): TaskPlanEvidenceFact {
  return {
    reference: "observation:obs-1",
    kind: "OBSERVATION",
    sessionId: identity.sessionId,
    runId: identity.runId,
    sourceStepId: "step-1",
    sourceCallId: "call-1",
    observedAt: 10,
    outcome: "EXITED_NONZERO",
    dependenciesKnown: false,
    ...overrides,
  };
}

describe("task plan evidence", () => {
  it("treats a completed invocation with exit code 2 as a known failure", () => {
    expect(projectProcessOutcome({ status: "EXITED", exitCode: 2 })).toEqual({
      kind: "EXITED_NONZERO",
      exitCode: 2,
    });
    expect(
      resolveTaskPlanEvidence({
        identity,
        refs: ["observation:obs-1"],
        facts: [fact()],
      }),
    ).toEqual([{ reference: "observation:obs-1", kind: "OBSERVATION", state: "FAILED" }]);
  });

  it("keeps a running preview service unknown and incomplete output incomplete", () => {
    expect(projectProcessOutcome({ status: "RUNNING", sessionId: "proc-1" })).toEqual({
      kind: "RUNNING",
    });
    const resolved = resolveTaskPlanEvidence({
      identity,
      refs: ["observation:obs-running", "observation:obs-truncated"],
      facts: [
        fact({ reference: "observation:obs-running", outcome: "RUNNING" }),
        fact({ reference: "observation:obs-truncated", outcome: "EXITED_OK", truncated: true }),
      ],
    });
    expect(resolved.map((item) => item.state)).toEqual(["UNKNOWN", "INCOMPLETE"]);
  });

  it("rejects missing and cross-Run or cross-Session evidence references", () => {
    const resolved = resolveTaskPlanEvidence({
      identity,
      refs: [
        "observation:missing",
        "observation:foreign-run",
        "observation:foreign-session",
        "bad reference",
      ],
      facts: [
        fact({ reference: "observation:foreign-run", runId: "run-other", outcome: "CHECK_PASSED" }),
        fact({
          reference: "observation:foreign-session",
          sessionId: "session-other",
          outcome: "EXITED_OK",
        }),
      ],
    });
    expect(resolved.map((item) => item.state)).toEqual([
      "UNKNOWN",
      "UNKNOWN",
      "UNKNOWN",
      "UNKNOWN",
    ]);
  });

  it("marks passed verification stale after a matching dependency changes", () => {
    const resolved = resolveTaskPlanEvidence({
      identity,
      refs: ["verification:check-1", "verification:check-2", "verification:check-3"],
      facts: [
        fact({
          reference: "verification:check-1",
          kind: "VERIFICATION",
          outcome: "CHECK_PASSED",
          dependenciesKnown: true,
          dependencies: ["packages/app/src"],
          laterMutations: [{ at: 20, path: "packages/app/src/main.ts" }],
        }),
        fact({
          reference: "verification:check-2",
          kind: "VERIFICATION",
          outcome: "CHECK_PASSED",
          dependenciesKnown: true,
          dependencies: ["packages/app/src"],
          laterMutations: [{ at: 20, path: "packages/other/README.md" }],
        }),
        fact({
          reference: "verification:check-3",
          kind: "VERIFICATION",
          outcome: "CHECK_PASSED",
          dependenciesKnown: false,
          mutationWatermark: 20,
        }),
      ],
    });
    expect(resolved.map((item) => item.state)).toEqual(["STALE", "PASSED", "STALE"]);
  });

  it("keeps the model's reported status separate from independent evidence state", () => {
    const refs = ["verification:failed", "observation:successful-shell"];
    const resolved = resolveTaskPlanEvidence({
      identity,
      refs,
      facts: [
        fact({
          reference: "verification:failed",
          kind: "VERIFICATION",
          outcome: "CHECK_FAILED",
        }),
        fact({ reference: "observation:successful-shell", outcome: "EXITED_OK" }),
      ],
    });
    const stateByReference = new Map(resolved.map((item) => [item.reference, item.state]));
    expect(aggregateTaskPlanEvidenceState(refs, stateByReference)).toBe("FAILED");
    expect(aggregateTaskPlanEvidenceState(["observation:successful-shell"], stateByReference)).toBe(
      "UNVERIFIED",
    );
  });
});
