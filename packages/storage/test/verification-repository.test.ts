import {
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  type VerificationPlan,
} from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { StorageConflictError } from "../src/errors.js";
import { makeRun, makeSession, makeState, makeStep } from "./support/fixtures.js";

const stores: Array<Awaited<ReturnType<typeof openCaelushStorage>>> = [];

function makePlan(): VerificationPlan {
  const runId = createRunId();
  const sourceStepId = createStepId();
  const planId = createVerificationPlanId();
  const checkId = createVerificationCheckId();
  return {
    id: planId,
    runId,
    sourceStepId,
    plannerVersion: "phase-11a.v1",
    planHash: "a".repeat(64),
    checks: [
      {
        id: checkId,
        planId,
        ordinal: 0,
        stage: "ACCEPTANCE",
        requirement: "REQUIRED",
        spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
        status: "PENDING",
        createdAt: createTimestampMs(100),
      },
    ],
    createdAt: createTimestampMs(100),
  };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((storage) => storage.close()));
});

describe("verification plan repository", () => {
  it("persists plans and checks, supports same-hash idempotency, and stores evidence", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const plan = makePlan();
    const session = makeSession({ id: createSessionId() });
    const run = makeRun(session.id, { id: plan.runId, status: "VERIFYING" });
    const step = makeStep(run.id, { id: plan.sourceStepId, status: "COMPLETED" });
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.steps.insert(step);
    await storage.runStates.save(makeState(run));

    await expect(storage.verification.createPlan(plan)).resolves.toEqual(plan);
    await expect(storage.verification.createPlan(plan)).resolves.toEqual(plan);
    await expect(storage.verification.getPlan(plan.id)).resolves.toEqual(plan);
    await expect(
      storage.verification.getPlanForRun(plan.runId, plan.sourceStepId),
    ).resolves.toEqual(plan);
    await expect(storage.verification.listChecks(plan.id)).resolves.toEqual(plan.checks);

    const evidence = {
      id: createVerificationEvidenceId(),
      planId: plan.id,
      checkId: plan.checks[0]!.id,
      kind: "TASK" as const,
      summary: "Task evidence",
      details: { accepted: true },
      capturedAt: createTimestampMs(101),
    };
    await storage.verification.addEvidence(evidence);
    await expect(storage.verification.listEvidence(plan.id, plan.checks[0]!.id)).resolves.toEqual([
      evidence,
    ]);

    await expect(
      storage.verification.createPlan({ ...plan, planHash: "b".repeat(64) }),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("rolls back the plan when a later check insert fails", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const first = makePlan();
    const second = makePlan();
    const firstSession = makeSession({ id: createSessionId() });
    const secondSession = makeSession({ id: createSessionId() });
    const firstRun = makeRun(firstSession.id, { id: first.runId });
    const secondRun = makeRun(secondSession.id, { id: second.runId });
    await storage.sessions.insert(firstSession);
    await storage.sessions.insert(secondSession);
    await storage.runs.insert(firstRun);
    await storage.runs.insert(secondRun);
    await storage.steps.insert(makeStep(first.runId, { id: first.sourceStepId }));
    await storage.steps.insert(makeStep(second.runId, { id: second.sourceStepId }));
    await storage.verification.createPlan(first);

    const conflicting = {
      ...second,
      checks: [{ ...second.checks[0]!, planId: second.id, id: first.checks[0]!.id }],
    };
    await expect(storage.verification.createPlan(conflicting)).rejects.toBeInstanceOf(
      StorageConflictError,
    );
    await expect(storage.verification.getPlan(second.id)).resolves.toBeNull();
    await expect(storage.verification.listPlans(second.runId)).resolves.toEqual([]);
  });
});
