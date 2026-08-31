import {
  createEventId,
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
import { makeRun, makeSession, makeState, makeStep } from "./support/fixtures.js";

const stores: Array<Awaited<ReturnType<typeof openCaelushStorage>>> = [];

function plan(): VerificationPlan {
  const planId = createVerificationPlanId();
  const runId = makeRun(createSessionId()).id;
  const sourceStepId = createStepId();
  return {
    id: planId,
    runId,
    sourceStepId,
    plannerVersion: "phase-11a.v1",
    planHash: "a".repeat(64),
    checks: [
      {
        id: createVerificationCheckId(),
        planId,
        ordinal: 0,
        stage: "BEHAVIORAL",
        requirement: "IF_AVAILABLE",
        spec: { kind: "PROJECT", purpose: "TEST", source: "SYSTEM" },
        status: "PENDING",
        createdAt: createTimestampMs(100),
      },
    ],
    createdAt: createTimestampMs(100),
  };
}

function changePlan(): VerificationPlan {
  const value = plan();
  return {
    ...value,
    checks: [
      {
        ...value.checks[0]!,
        spec: { kind: "WORKSPACE", purpose: "CHANGESET_SANITY", source: "SYSTEM" },
      },
    ],
  };
}

function discovery(planValue: VerificationPlan) {
  return {
    id: createVerificationEvidenceId(),
    planId: planValue.id,
    checkId: planValue.checks[0]!.id,
    kind: "DISCOVERY" as const,
    summary: "Project verification command discovered",
    details: {
      available: true,
      resolver: "NODE_PACKAGE_SCRIPT@phase-11b.v1",
      ecosystem: "NODE",
      evidencePath: "package.json",
      candidateHash: "b".repeat(64),
    },
    capturedAt: createTimestampMs(110),
  };
}

function commandEvidence(planValue: VerificationPlan) {
  return {
    id: createVerificationEvidenceId(),
    planId: planValue.id,
    checkId: planValue.checks[0]!.id,
    kind: "COMMAND" as const,
    summary: "project test",
    details: { candidateHash: "b".repeat(64), exitCode: 0, totalOutputBytes: 2, omittedBytes: 0 },
    capturedAt: createTimestampMs(120),
  };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((storage) => storage.close()));
});

describe("atomic verification execution persistence", () => {
  it("commits start and settlement with their check events", async () => {
    const storage = await openCaelushStorage({
      path: ":memory:",
    });
    stores.push(storage);
    const value = plan();
    const session = makeSession({ id: createSessionId() });
    const run = makeRun(session.id, { id: value.runId, status: "VERIFYING" });
    const step = makeStep(run.id, { id: value.sourceStepId, status: "COMPLETED" });
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.steps.insert(step);
    await storage.runStates.save(makeState(run));
    await storage.verification.createPlan(value);

    const discoveryEvidence = discovery(value);
    const start = await storage.verificationExecution.startCheck({
      runId: value.runId,
      sessionId: session.id,
      check: { ...value.checks[0]!, status: "RUNNING", startedAt: createTimestampMs(111) },
      discoveryEvidence,
    });
    expect(start.check.status).toBe("RUNNING");
    expect(start.events).toHaveLength(1);
    expect(start.events[0]!.type).toBe("verification.check.started");
    expect(await storage.verification.listEvidence(value.id)).toHaveLength(1);

    await expect(
      storage.verificationExecution.settleCheck({
        runId: value.runId,
        sessionId: session.id,
        check: { ...start.check, status: "PASSED", finishedAt: createTimestampMs(121) },
        evidence: [discoveryEvidence],
      }),
    ).rejects.toThrow();
    expect((await storage.verification.getPlan(value.id))?.checks[0]?.status).toBe("RUNNING");
    expect(await storage.verification.listEvidence(value.id)).toHaveLength(1);
    expect(await storage.events.latestSequence(value.runId)).toBe(1);

    const settled = await storage.verificationExecution.settleCheck({
      runId: value.runId,
      sessionId: session.id,
      check: { ...start.check, status: "PASSED", finishedAt: createTimestampMs(121) },
      evidence: [commandEvidence(value)],
    });
    expect(settled.check.status).toBe("PASSED");
    expect(settled.events).toHaveLength(1);
    expect(settled.events[0]!.type).toBe("verification.check.completed");
    expect(await storage.verification.listEvidence(value.id)).toHaveLength(2);
    expect(await storage.events.latestSequence(value.runId)).toBe(2);

    const duplicate = await storage.verificationExecution.settleCheck({
      runId: value.runId,
      sessionId: session.id,
      check: settled.check,
      evidence: [commandEvidence(value)],
    });
    expect(duplicate.events).toEqual([]);
    expect(await storage.events.latestSequence(value.runId)).toBe(2);
  });

  it("uses the shared durable event sequence and never exposes a raw command in events", async () => {
    expect(createEventId()).toMatch(/^evt_/);
  });

  it("persists non-project change checks through the same execution store", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const value = changePlan();
    const session = makeSession({ id: createSessionId() });
    const run = makeRun(session.id, { id: value.runId, status: "VERIFYING" });
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.steps.insert(makeStep(run.id, { id: value.sourceStepId, status: "COMPLETED" }));
    await storage.runStates.save(makeState(run));
    await storage.verification.createPlan(value);

    const started = await storage.verificationExecution.startCheck({
      runId: value.runId,
      sessionId: session.id,
      check: { ...value.checks[0]!, status: "RUNNING", startedAt: createTimestampMs(111) },
      discoveryEvidence: {
        ...discovery(value),
        kind: "DISCOVERY",
        summary: "Workspace inspection prepared",
        details: { kind: "WORKSPACE", purpose: "CHANGESET_SANITY" },
      },
    });

    expect(started.events[0]?.type).toBe("verification.check.started");
    expect(started.events[0]?.payload).toMatchObject({ kind: "WORKSPACE" });
    expect(await storage.verificationExecution.countPlans?.(value.runId)).toBe(1);
  });
});
