import {
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  createRunId,
  createSessionId,
  createStepId,
  type VerificationCheck,
  type VerificationPlan,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  VerificationStageRunner,
  type VerificationCheckExecutor,
  type VerificationExecutionStorePort,
} from "../src/index.js";

function planFor(kinds: readonly VerificationCheck["spec"]["kind"][]): VerificationPlan {
  const id = createVerificationPlanId();
  return {
    id,
    runId: createRunId(),
    sourceStepId: createStepId(),
    plannerVersion: "phase-11c.test",
    planHash: "a".repeat(64),
    checks: kinds.map((kind, ordinal) => ({
      id: createVerificationCheckId(),
      planId: id,
      ordinal,
      stage: kind === "TASK" ? ("ACCEPTANCE" as const) : ("CHANGE_REVIEW" as const),
      requirement: "REQUIRED" as const,
      spec:
        kind === "PROJECT"
          ? { kind, purpose: "LINT" as const, source: "SYSTEM" as const }
          : kind === "WORKSPACE"
            ? { kind, purpose: "CHANGESET_SANITY" as const, source: "SYSTEM" as const }
            : kind === "GIT"
              ? { kind, purpose: "CHANGESET_REVIEW" as const, source: "SYSTEM" as const }
              : { kind, purpose: "ACCEPTANCE" as const, source: "SYSTEM" as const },
      status: "PENDING" as const,
      createdAt: 1_000 as never,
    })),
    createdAt: 1_000 as never,
  };
}

function evidence(check: VerificationCheck) {
  return {
    id: createVerificationEvidenceId(),
    planId: check.planId,
    checkId: check.id,
    kind: check.spec.kind === "TASK" ? ("TASK" as const) : ("WORKSPACE" as const),
    summary: `${check.spec.kind} evidence`,
    capturedAt: 1_003 as never,
  };
}

describe("verification stage runner", () => {
  it("runs checks in ordinal order and persists RUNNING before inspection", async () => {
    const plan = planFor(["PROJECT", "WORKSPACE", "GIT", "TASK"]);
    const calls: string[] = [];
    const store: VerificationExecutionStorePort = {
      async startCheck(input) {
        calls.push(`start:${input.check.spec.kind}`);
        return { check: input.check, events: [] };
      },
      async settleCheck(input) {
        calls.push(`settle:${input.check.spec.kind}`);
        return { check: input.check, events: [] };
      },
    };
    const executor: VerificationCheckExecutor = {
      async execute(check) {
        calls.push(`inspect:${check.spec.kind}`);
        return { status: "PASSED", evidence: [evidence(check)] };
      },
    };

    const result = await new VerificationStageRunner().run({
      runId: plan.runId,
      sessionId: createSessionId(),
      plan,
      store,
      executors: { PROJECT: executor, WORKSPACE: executor, GIT: executor, TASK: executor },
      discoveryEvidence: (check) => evidence(check),
      now: () => 2_000 as never,
    });

    expect(result.outcome).toBe("PASSED");
    expect(calls).toEqual([
      "start:PROJECT",
      "inspect:PROJECT",
      "settle:PROJECT",
      "start:WORKSPACE",
      "inspect:WORKSPACE",
      "settle:WORKSPACE",
      "start:GIT",
      "inspect:GIT",
      "settle:GIT",
      "start:TASK",
      "inspect:TASK",
      "settle:TASK",
    ]);
  });

  it("stops at the first blocking failed check and classifies errors separately", async () => {
    const plan = planFor(["WORKSPACE", "GIT", "TASK"]);
    const executed: string[] = [];
    const store: VerificationExecutionStorePort = {
      async startCheck(input) {
        return { check: input.check, events: [] };
      },
      async settleCheck(input) {
        return { check: input.check, events: [] };
      },
    };
    const executor: VerificationCheckExecutor = {
      async execute(check) {
        executed.push(check.spec.kind);
        return {
          status: check.spec.kind === "WORKSPACE" ? "FAILED" : "ERROR",
          evidence: [evidence(check)],
        };
      },
    };

    const result = await new VerificationStageRunner().run({
      runId: plan.runId,
      sessionId: createSessionId(),
      plan,
      store,
      executors: { WORKSPACE: executor, GIT: executor, TASK: executor },
      discoveryEvidence: (check) => evidence(check),
      now: () => 2_000 as never,
    });

    expect(executed).toEqual(["WORKSPACE"]);
    expect(result.outcome).toBe("BLOCKED");
    expect(result.failedCheckIds).toHaveLength(1);
    expect(result.errorCheckIds).toEqual([]);
  });

  it("durably skips unavailable optional checks with discovery evidence", async () => {
    const plan = planFor(["GIT"]);
    const settled: string[] = [];
    const store: VerificationExecutionStorePort = {
      async startCheck(input) {
        throw new Error(`must not start ${input.check.id}`);
      },
      async settleCheck(input) {
        settled.push(input.check.status);
        return { check: input.check, events: [] };
      },
    };
    const result = await new VerificationStageRunner().run({
      runId: plan.runId,
      sessionId: createSessionId(),
      plan: {
        ...plan,
        checks: [{ ...plan.checks[0]!, requirement: "IF_AVAILABLE" }],
      },
      store,
      executors: {},
      discoveryEvidence: (check) => evidence(check),
      now: () => 2_000 as never,
    });
    expect(result.outcome).toBe("PASSED");
    expect(result.skippedCount).toBe(1);
    expect(settled).toEqual(["SKIPPED"]);
  });

  it("settles verification infrastructure failures as ERROR", async () => {
    const plan = planFor(["GIT"]);
    const settled: string[] = [];
    const store: VerificationExecutionStorePort = {
      async startCheck(input) {
        return { check: input.check, events: [] };
      },
      async settleCheck(input) {
        settled.push(input.check.status);
        return { check: input.check, events: [] };
      },
    };
    const result = await new VerificationStageRunner().run({
      runId: plan.runId,
      sessionId: createSessionId(),
      plan,
      store,
      executors: {
        GIT: {
          preflight: async () => {
            throw new Error("git status failed");
          },
          execute: async () => ({ status: "PASSED", evidence: [] }),
        },
      },
      discoveryEvidence: (check) => evidence(check),
      now: () => 2_000 as never,
    });
    expect(result.outcome).toBe("BLOCKED");
    expect(result.errorCheckIds).toEqual([plan.checks[0]!.id]);
    expect(settled).toEqual(["ERROR"]);
  });
});
