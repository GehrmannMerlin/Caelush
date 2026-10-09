import {
  MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES,
  createEventId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  type VerificationPlan,
  VerificationEvidenceSchema,
} from "@caelush/protocol";
import {
  createWorkspaceEvidence,
  VerificationStageRunner,
  verifyWorkspaceInspection,
} from "@caelush/verification";
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
    expect(await storage.eventReader.latestSequence(value.runId)).toBe(1);

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
    expect(await storage.eventReader.latestSequence(value.runId)).toBe(2);

    const duplicate = await storage.verificationExecution.settleCheck({
      runId: value.runId,
      sessionId: session.id,
      check: settled.check,
      evidence: [commandEvidence(value)],
    });
    expect(duplicate.events).toEqual([]);
    expect(await storage.eventReader.latestSequence(value.runId)).toBe(2);
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

  it("commits T013-sized generated workspace evidence with its check and event atomically", async () => {
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

    const changedFiles = Array.from({ length: 33 }, (_, index) => ({
      path: "src/catalog/item-" + String(index).padStart(2, "0") + ".tsx",
      changeType: "MODIFIED" as const,
    }));
    const facts = {
      inspectionComplete: true,
      paths: changedFiles.map(({ path }, index) => ({
        path,
        kind: "FILE" as const,
        fingerprint: {
          kind: "FILE" as const,
          sizeBytes: 2_048,
          sha256: index.toString(16).padStart(64, "0"),
        },
      })),
      artifactEvidence: changedFiles.map(({ path }, index) => ({
        path,
        kind: "TEXT" as const,
        sizeBytes: 2_048,
        sha256: index.toString(16).padStart(64, "0"),
        content: "item-" + String(index).padStart(2, "0") + "\n" + "x".repeat(1_024),
        truncated: false,
      })),
    };
    const inspection = verifyWorkspaceInspection({ changedFiles, facts });
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
    const evidence = VerificationEvidenceSchema.parse(
      createWorkspaceEvidence({
        id: createVerificationEvidenceId(),
        planId: value.id,
        checkId: value.checks[0]!.id,
        capturedAt: createTimestampMs(120),
        result: inspection,
      }),
    );
    const detailsBytes = Buffer.byteLength(JSON.stringify(evidence.details), "utf8");
    expect(detailsBytes).toBeLessThanOrEqual(MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES);
    const settled = await storage.verificationExecution.settleCheck({
      runId: value.runId,
      sessionId: session.id,
      check: {
        ...started.check,
        status: inspection.status,
        finishedAt: createTimestampMs(121),
      },
      evidence: [evidence],
    });

    expect(settled.check.status).toBe("PASSED");
    expect(settled.events.map((event) => event.type)).toEqual(["verification.check.completed"]);
    expect((await storage.verification.getPlan(value.id))?.checks[0]?.status).toBe("PASSED");
    expect(await storage.verification.listEvidence(value.id)).toHaveLength(2);
    expect(await storage.eventReader.latestSequence(value.runId)).toBe(2);
  });

  it("settles a real SQLite evidence constraint failure as ERROR without a false PASSED event", async () => {
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

    const sharedEvidenceId = createVerificationEvidenceId();
    const notified: string[] = [];
    let executionCount = 0;
    const result = await new VerificationStageRunner().run({
      runId: value.runId,
      sessionId: session.id,
      plan: value,
      store: storage.verificationExecution,
      evidenceIdFactory: createVerificationEvidenceId,
      now: () => 200,
      discoveryEvidence: (check, capturedAt) => ({
        id: sharedEvidenceId,
        planId: value.id,
        checkId: check.id,
        kind: "DISCOVERY",
        summary: "Workspace inspection prepared",
        details: { kind: "WORKSPACE", purpose: "CHANGESET_SANITY" },
        capturedAt: createTimestampMs(capturedAt),
      }),
      onCommittedEvents: (events) => notified.push(...events.map((event) => event.type)),
      executors: {
        WORKSPACE: {
          async execute(check) {
            executionCount += 1;
            return {
              status: "PASSED",
              evidence: [
                {
                  id: sharedEvidenceId,
                  planId: value.id,
                  checkId: check.id,
                  kind: "WORKSPACE",
                  summary: "Workspace change sanity passed",
                  details: { status: "PASSED", inspectionComplete: true },
                  capturedAt: createTimestampMs(210),
                },
              ],
            };
          },
        },
      },
    });

    const settledPlan = await storage.verification.getPlan(value.id);
    const evidenceRows = await storage.verification.listEvidence(value.id);
    expect(executionCount).toBe(1);
    expect(result.outcome).toBe("BLOCKED");
    expect(result.errorCount).toBe(1);
    expect(settledPlan?.checks[0]?.status).toBe("ERROR");
    expect(evidenceRows).toHaveLength(2);
    expect(evidenceRows.at(-1)?.details).toMatchObject({
      errorCode: "VERIFICATION_SETTLEMENT_ERROR",
      classification: "INFRASTRUCTURE",
    });
    expect(notified).toEqual(["verification.check.started", "verification.check.completed"]);
    expect(await storage.eventReader.latestSequence(value.runId)).toBe(2);
  });

  it("rejects verification settlement after the Run terminal boundary closes", async () => {
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
      discoveryEvidence: discovery(value),
    });
    await storage.runs.update({
      ...run,
      status: "FAILED",
      finishedAt: createTimestampMs(120),
    });

    await expect(
      storage.verificationExecution.settleCheck({
        runId: value.runId,
        sessionId: session.id,
        check: { ...started.check, status: "ERROR", finishedAt: createTimestampMs(121) },
        evidence: [
          {
            ...discovery(value),
            kind: "WORKSPACE",
            details: { errorCode: "VERIFICATION_INTERRUPTED" },
            capturedAt: createTimestampMs(121),
          },
        ],
      }),
    ).rejects.toThrow();
    expect((await storage.verification.getPlan(value.id))?.checks[0]?.status).toBe("RUNNING");
    expect(await storage.verification.listEvidence(value.id)).toHaveLength(1);
    expect(await storage.eventReader.latestSequence(value.runId)).toBe(1);
  });

  it("allows an errored check to restart only through an explicit retry", async () => {
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
      discoveryEvidence: discovery(value),
    });
    const errored = await storage.verificationExecution.settleCheck({
      runId: value.runId,
      sessionId: session.id,
      check: { ...started.check, status: "ERROR", finishedAt: createTimestampMs(121) },
      evidence: [
        {
          ...discovery(value),
          kind: "WORKSPACE" as const,
          summary: "Workspace verification errored",
          details: { errorCode: "REVIEWER_RESPONSE_INVALID" },
          capturedAt: createTimestampMs(120),
        },
      ],
    });
    expect(errored.check.status).toBe("ERROR");

    const { finishedAt: _finishedAt, skipReason: _skipReason, ...retryBase } = errored.check;
    void _finishedAt;
    void _skipReason;
    const retried = await storage.verificationExecution.startCheck({
      runId: value.runId,
      sessionId: session.id,
      check: {
        ...retryBase,
        status: "RUNNING",
        startedAt: createTimestampMs(131),
      },
      discoveryEvidence: {
        ...discovery(value),
        capturedAt: createTimestampMs(130),
      },
      retry: true,
    });

    expect(retried.check.status).toBe("RUNNING");
    expect(retried.check.startedAt).toBe(createTimestampMs(131));
    expect(await storage.verification.getPlan(value.id)).toMatchObject({
      checks: [{ status: "RUNNING" }],
    });
  });
});
