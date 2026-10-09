import {
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  createRunId,
  createSessionId,
  createStepId,
  type VerificationCheck,
  type VerificationEvidence,
  type VerificationPlan,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  VerificationStageRunner,
  type VerificationCheckExecutor,
  type VerificationExecutionRecoveryStorePort,
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

function recoveryStore(
  plan: VerificationPlan,
  settle: (
    input: Parameters<VerificationExecutionRecoveryStorePort["settleCheck"]>[0],
  ) => void = () => {},
) {
  let current = plan.checks[0]!;
  const rows: VerificationEvidence[] = [];
  const settleStatuses: string[] = [];
  return {
    rows,
    settleStatuses,
    current: () => current,
    store: {
      async startCheck(input: Parameters<VerificationExecutionRecoveryStorePort["startCheck"]>[0]) {
        current = input.check;
        rows.push(input.discoveryEvidence);
        return { check: current, events: [] };
      },
      async settleCheck(
        input: Parameters<VerificationExecutionRecoveryStorePort["settleCheck"]>[0],
      ) {
        settleStatuses.push(input.check.status);
        settle(input);
        current = input.check;
        rows.push(...input.evidence);
        return { check: current, events: [] };
      },
      async getPlanExecutionSnapshot() {
        return { plan: { ...plan, checks: [current] }, evidence: [...rows] };
      },
    } satisfies VerificationExecutionRecoveryStorePort,
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

  it("keeps executor exceptions out of evidence and settles them as infrastructure ERROR", async () => {
    const plan = planFor(["WORKSPACE"]);
    const ledger = recoveryStore(plan);
    const result = await new VerificationStageRunner().run({
      runId: plan.runId,
      sessionId: createSessionId(),
      plan,
      store: ledger.store,
      executors: {
        WORKSPACE: {
          async execute() {
            throw new Error("C:\\Users\\private\\api-key=secret");
          },
        },
      },
      discoveryEvidence: (check) => evidence(check),
      evidenceIdFactory: createVerificationEvidenceId,
      now: () => 2_000 as never,
    });

    expect(result.errorCheckIds).toEqual([plan.checks[0]!.id]);
    expect(ledger.current().status).toBe("ERROR");
    expect(ledger.rows.at(-1)?.details).toMatchObject({
      errorCode: "VERIFICATION_EXECUTOR_ERROR",
      classification: "INFRASTRUCTURE",
    });
    expect(JSON.stringify(ledger.rows.at(-1))).not.toContain("private");
    expect(JSON.stringify(ledger.rows.at(-1))).not.toContain("secret");
  });

  it("settles invalid oversized executor evidence as a minimal ERROR before Storage", async () => {
    const plan = planFor(["WORKSPACE"]);
    const ledger = recoveryStore(plan);
    let executionCount = 0;
    const result = await new VerificationStageRunner().run({
      runId: plan.runId,
      sessionId: createSessionId(),
      plan,
      store: ledger.store,
      executors: {
        WORKSPACE: {
          async execute(check) {
            executionCount += 1;
            return {
              status: "PASSED",
              evidence: [{ ...evidence(check), details: { body: "x".repeat(33 * 1024) } }],
            };
          },
        },
      },
      discoveryEvidence: (check) => evidence(check),
      evidenceIdFactory: createVerificationEvidenceId,
      now: () => 2_000 as never,
    });

    expect(executionCount).toBe(1);
    expect(result.outcome).toBe("BLOCKED");
    expect(result.passedCount).toBe(0);
    expect(result.errorCheckIds).toEqual([plan.checks[0]!.id]);
    expect(ledger.current().status).toBe("ERROR");
    expect(ledger.rows.at(-1)?.details).toMatchObject({
      errorCode: "VERIFICATION_EVIDENCE_SIZE_ERROR",
      classification: "INFRASTRUCTURE",
    });
  });

  it("settles an unencodable cyclic result as ERROR without submitting it to Storage", async () => {
    const plan = planFor(["WORKSPACE"]);
    const ledger = recoveryStore(plan);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = await new VerificationStageRunner().run({
      runId: plan.runId,
      sessionId: createSessionId(),
      plan,
      store: ledger.store,
      executors: {
        WORKSPACE: {
          async execute(check) {
            return {
              status: "PASSED",
              evidence: [{ ...evidence(check), details: cyclic } as VerificationEvidence],
            };
          },
        },
      },
      discoveryEvidence: (check) => evidence(check),
      evidenceIdFactory: createVerificationEvidenceId,
      now: () => 2_000 as never,
    });

    expect(result.outcome).toBe("BLOCKED");
    expect(result.passedCount).toBe(0);
    expect(ledger.current().status).toBe("ERROR");
    expect(ledger.rows.at(-1)?.details).toMatchObject({
      errorCode: "VERIFICATION_EVIDENCE_ENCODING_ERROR",
      classification: "INFRASTRUCTURE",
    });
  });

  it("performs one bounded ERROR settlement after a durable result write fails", async () => {
    const plan = planFor(["WORKSPACE"]);
    const settleCalls: string[] = [];
    const ledger = recoveryStore(plan, (input) => {
      settleCalls.push(input.check.status);
      if (settleCalls.length === 1) throw new Error("sqlite write fault");
    });
    let executionCount = 0;
    const result = await new VerificationStageRunner().run({
      runId: plan.runId,
      sessionId: createSessionId(),
      plan,
      store: ledger.store,
      executors: {
        WORKSPACE: {
          async execute(check) {
            executionCount += 1;
            return { status: "PASSED", evidence: [evidence(check)] };
          },
        },
      },
      discoveryEvidence: (check) => evidence(check),
      evidenceIdFactory: createVerificationEvidenceId,
      now: () => 2_000 as never,
    });

    expect(executionCount).toBe(1);
    expect(settleCalls).toEqual(["PASSED", "ERROR"]);
    expect(result.outcome).toBe("BLOCKED");
    expect(result.passedCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(ledger.current().status).toBe("ERROR");
    expect(ledger.rows.at(-1)?.details).toMatchObject({
      errorCode: "VERIFICATION_SETTLEMENT_ERROR",
      classification: "INFRASTRUCTURE",
    });
  });

  it("does not retry settlement when committed-event notification rejects", async () => {
    const plan = planFor(["WORKSPACE"]);
    const ledger = recoveryStore(plan);
    let executionCount = 0;
    const result = await new VerificationStageRunner().run({
      runId: plan.runId,
      sessionId: createSessionId(),
      plan,
      store: ledger.store,
      executors: {
        WORKSPACE: {
          async execute(check) {
            executionCount += 1;
            return { status: "PASSED", evidence: [evidence(check)] };
          },
        },
      },
      discoveryEvidence: (check) => evidence(check),
      onCommittedEvents: () => Promise.reject(new Error("observer down")),
      now: () => 2_000 as never,
    });

    expect(result.outcome).toBe("PASSED");
    expect(executionCount).toBe(1);
    expect(ledger.current().status).toBe("PASSED");
    expect(ledger.settleStatuses).toEqual(["PASSED"]);
  });

  it("leaves durable RUNNING truth when both the result and bounded ERROR write fail", async () => {
    const plan = planFor(["WORKSPACE"]);
    const settleCalls: string[] = [];
    const ledger = recoveryStore(plan, (input) => {
      settleCalls.push(input.check.status);
      throw new Error("sqlite unavailable");
    });
    await expect(
      new VerificationStageRunner().run({
        runId: plan.runId,
        sessionId: createSessionId(),
        plan,
        store: ledger.store,
        executors: {
          WORKSPACE: {
            async execute(check) {
              return { status: "PASSED", evidence: [evidence(check)] };
            },
          },
        },
        discoveryEvidence: (check) => evidence(check),
        now: () => 2_000 as never,
      }),
    ).rejects.toThrow("Verification check settlement could not be confirmed");

    expect(settleCalls).toEqual(["PASSED", "ERROR"]);
    expect(ledger.current().status).toBe("RUNNING");
    expect(ledger.rows).toHaveLength(1);
  });
});
