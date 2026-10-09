import { describe, expect, it } from "vitest";
import {
  createObservationId,
  createTimestampMs,
  createToolInvocationId,
  createStepId,
  createVerificationCheckId,
  createVerificationEvidenceId,
} from "@caelush/protocol";

import {
  classifyCompletionEffectSettlement,
  CompletionGateIdentityError,
  createCompletionGateObservation,
  RunExecutionConflictError,
} from "../src/index.js";
import {
  awaitingVerification,
  candidateTurn,
  committedRepairBoundary,
  completionGateOver,
  harness3e,
  restoreCommittedCandidateBoundary,
  stubGit,
  stubReviewer,
  stubWorkspace,
  WORKSPACE_AND_TASK,
  type Phase3EHarness,
} from "./support/phase-3e-completion.js";
import { toolTurn } from "./support/phase-3d-tool-turn.js";

/**
 * Phase 3E — the production CompletionGate, driven by the production driver.
 *
 * ```text
 * AgentLoop -> FINAL_CANDIDATE -> boundary opener -> VERIFYING + plan
 *        ↓
 * Coordinator -> EVALUATE_COMPLETION -> RunExecutionDriver -> real CompletionGate
 *        ↓
 * ACCEPT / REPAIR / REJECT / ERROR -> RunController commits the lifecycle
 * ```
 *
 * These tests are about the *migrated* boundary: verification authority lives behind the frozen
 * `CompletionGate` contract, the Run Layer only settles what that gate decided, and a completion
 * evaluation never drives the Agent loop or a Tool batch.
 */

/** The durable Run identity this harness's Run carries. */
function identityOf(harness: Phase3EHarness) {
  const run = harness.store.snapshot.run;
  return { runId: run.id, sessionId: run.sessionId, goal: run.goal };
}

/** A Git-only plan, so a Git freshness verdict is the only thing that can decide the completion. */
const GIT_ONLY = [{ kind: "GIT", requirement: "REQUIRED", stage: "CHANGE_REVIEW" }] as const;

describe("Phase 3E production completion gate", () => {
  it("accepts a verified candidate and completes the Run", async () => {
    const harness = harness3e({ script: () => candidateTurn("the answer") });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("COMPLETED");
    const snapshot = harness.snapshot();
    expect(snapshot.run.status).toBe("COMPLETED");
    expect(snapshot.state?.status).toBe("COMPLETED");
    expect(snapshot.continuation).toBeUndefined();
    expect(snapshot.run.finalResult).toMatchObject({
      type: "VERIFIED_COMPLETION",
      text: "the answer",
    });
  });

  it("reviews the candidate exactly once and never replays a durable check", async () => {
    const reviewer = stubReviewer({ status: "PASSED" });
    const harness = harness3e({ script: () => candidateTurn("done"), reviewer });

    await harness.controller.start(harness.store.snapshot.run.id);

    expect(reviewer.bundles).toHaveLength(1);
    expect(harness.turns).toHaveLength(1);
    expect(harness.verification.settled).toHaveLength(1);
  });

  it("fails the Run when the host composed no verification", async () => {
    const harness = harness3e({
      script: () => candidateTurn("done"),
      verificationStore: false,
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.run.status).toBe("FAILED");
    const snapshot = harness.snapshot();
    expect(snapshot.continuation).toBeUndefined();
    expect(harness.eventTypes().filter((type) => type === "run.failed")).toHaveLength(1);
    expect(harness.reviewer.bundles).toHaveLength(0);
  });

  it("repairs a failed verification with the durable repair boundary", async () => {
    const harness = harness3e({
      // The repair returns the Run to RUNNING, so the model answers again. That second turn asks for
      // a Tool, and with no Tool coordinator composed the Run parks on its durable Tool boundary —
      // which is what lets this test stop at the repair instead of driving a whole second attempt.
      script: (call) =>
        call === 0 ? candidateTurn("done") : toolTurn([{ id: "call_a", name: "read_file" }]),
      reviewer: stubReviewer({ status: "FAILED", repairInstructions: ["do better"] }),
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.status).toBe("WAITING_TOOL_RESULTS");
    // The repair boundary is read from the ledger, not from the end state: the Run was returned to
    // RUNNING and its next Reason is already parked on a Tool boundary behind it.
    const repaired = committedRepairBoundary(harness);
    const checkpoint = repaired.checkpoint;
    expect(checkpoint.repairCycle).toBe(0);
    expect(checkpoint.failedCheckIds.length).toBeGreaterThan(0);
    expect(checkpoint.evidenceIds.length).toBeGreaterThan(0);
    // The provenance is the observation's, not the frozen repair metadata's: it names a plan the
    // verification execution actually holds for this Run.
    expect(harness.verification.plans.get(checkpoint.failedPlanId)?.runId).toBe(
      harness.store.snapshot.run.id,
    );
    expect(harness.eventTypes()).toContain("verification.repair.started");
    // The Run really did return to RUNNING, and it really did get another Reason.
    expect(repaired.run.status).toBe("RUNNING");
    expect(harness.turns).toHaveLength(2);
  });

  it("rejects the candidate once the repair policy is exhausted", async () => {
    const harness = harness3e({
      script: () => candidateTurn("done"),
      reviewer: stubReviewer({ status: "FAILED" }),
      planCount: async () => 4,
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.status).toBe("FAILED");
    expect(harness.snapshot().run.status).toBe("FAILED");
    expect(harness.eventTypes()).not.toContain("run.completed");
    expect(harness.eventTypes()).not.toContain("verification.repair.started");
    expect(harness.verified).toHaveLength(0);
  });

  it("keeps the workspace freshness recheck immediately before acceptance", async () => {
    const workspace = stubWorkspace((call) =>
      call === 1
        ? { inspectionComplete: true, paths: [] }
        : { inspectionComplete: false, paths: [] },
    );
    const harness = harness3e({
      script: () => candidateTurn("done"),
      checks: WORKSPACE_AND_TASK,
      workspace,
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.status).toBe("FAILED");
    expect(harness.snapshot().run.status).toBe("FAILED");
    expect(harness.verified).toHaveLength(0);
    expect(harness.eventTypes().filter((type) => type === "run.failed")).toHaveLength(1);
    // One inspection for the check, one for the recheck that must precede acceptance.
    expect(workspace.inspections).toBe(2);
  });

  it("reports the verified completion to the host once", async () => {
    const seen: unknown[] = [];
    const harness = harness3e({
      script: () => candidateTurn("done"),
      onVerifiedCompletion: (input) => seen.push(input.finalResult),
    });

    await harness.controller.start(harness.store.snapshot.run.id);

    expect(seen).toHaveLength(1);
    expect(harness.verified).toHaveLength(1);
  });

  it("accounts no Agent Step for the completion evaluation", async () => {
    const harness = harness3e({ script: () => candidateTurn("done") });

    await harness.controller.start(harness.store.snapshot.run.id);

    // One Step for the candidate's Reason, and none for the host action that verified it.
    expect(harness.allocatedSteps).toHaveLength(1);
    expect(harness.snapshot().state?.usage.steps).toBe(1);
  });

  it("publishes the completion events in canonical order", async () => {
    const harness = harness3e({ script: () => candidateTurn("done") });

    await harness.controller.start(harness.store.snapshot.run.id);

    const types = harness.eventTypes();
    expect(types.slice(-3)).toEqual(["verification.finalized", "status.changed", "run.completed"]);
    expect(types).toContain("verification.check.started");
    expect(types).toContain("verification.check.completed");
  });
});

describe("Phase 3E completion termination", () => {
  it("never completes a Run the termination authority has claimed", async () => {
    const harness: Phase3EHarness = harness3e({
      script: () => candidateTurn("done"),
      reviewer: stubReviewer({ status: "ERROR", errorCode: "REVIEWER_TIMEOUT" }),
    });
    const runId = harness.store.snapshot.run.id;
    harness.reviewer.onReview = async () => {
      await harness.store.requestCancellation(runId, {
        runId,
        cause: "USER_REQUESTED",
        requestedAt: createTimestampMs(1_000_000),
      });
    };

    const result = await harness.controller.start(runId);

    expect(result.run.status).toBe("CANCELLED");
    expect(harness.snapshot().run.status).toBe("CANCELLED");
    expect(harness.eventTypes()).not.toContain("run.completed");
    expect(harness.verified).toHaveLength(0);
    expect(harness.eventTypes()).not.toContain("run.failed");
  });
});

/** Restore the durable candidate boundary so a test can call the gate directly. */
async function parkOnVerification(
  options: {
    readonly reviewer?: ReturnType<typeof stubReviewer>;
    readonly persistence?: (
      port: import("../src/index.js").RunCompletionPersistencePort,
    ) => import("../src/index.js").RunCompletionPersistencePort;
  } = {},
): Promise<Phase3EHarness> {
  const harness = harness3e({
    script: () => candidateTurn("the candidate"),
    // No verification execution store exercises the error path. The helper below restores the
    // previously committed candidate boundary only for direct gate contract tests.
    verificationStore: false,
    ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
    ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
  });
  const result = await harness.controller.start(harness.store.snapshot.run.id);
  expect(result.status).toBe("FAILED");
  restoreCommittedCandidateBoundary(harness);
  return harness;
}

describe("Phase 3E completion gate identity and integrity", () => {
  it("refuses a completion evaluation that is not this Run's", async () => {
    const harness = await parkOnVerification();
    const { gate } = completionGateOver(harness);
    const continuation = awaitingVerification(harness);
    const base = {
      sourceStepId: continuation.sourceStepId,
      candidate: continuation.finalDecision,
      mode: "EXECUTE" as const,
      signal: new AbortController().signal,
    };

    await expect(
      gate.evaluate({
        ...base,
        identity: {
          runId: continuation.runId,
          sessionId: "ses_0195f3a0-0000-7000-8000-000000000000" as never,
          goal: harness.store.snapshot.run.goal,
        },
      }),
    ).rejects.toBeInstanceOf(CompletionGateIdentityError);

    await expect(
      gate.evaluate({
        ...base,
        sourceStepId: "stp_0195f3a0-0000-7000-8000-000000000000" as never,
        identity: identityOf(harness),
      }),
    ).rejects.toBeInstanceOf(CompletionGateIdentityError);

    await expect(
      gate.evaluate({
        ...base,
        candidate: { ...continuation.finalDecision, candidateText: "a candidate nobody produced" },
        identity: identityOf(harness),
      }),
    ).rejects.toBeInstanceOf(CompletionGateIdentityError);

    await expect(
      gate.evaluate({
        ...base,
        candidate: {
          ...continuation.finalDecision,
          modelTurn: {
            ...continuation.finalDecision.modelTurn,
            callId: "llm_0195f3a0-0000-7000-8000-000000000000" as never,
          },
        },
        identity: identityOf(harness),
      }),
    ).rejects.toBeInstanceOf(CompletionGateIdentityError);

    // Every refusal happened before any verification ran.
    expect(harness.reviewer.bundles).toHaveLength(0);
    expect(harness.verification.started).toHaveLength(0);
  });

  it("returns a bounded error when the evaluation is already aborted", async () => {
    const harness = await parkOnVerification();
    const { gate } = completionGateOver(harness);
    const continuation = awaitingVerification(harness);
    const controller = new AbortController();
    controller.abort();

    const decision = await gate.evaluate({
      identity: identityOf(harness),
      sourceStepId: continuation.sourceStepId,
      candidate: continuation.finalDecision,
      mode: "EXECUTE",
      signal: controller.signal,
    });

    expect(decision).toMatchObject({ kind: "ERROR", retryable: false });
    expect(harness.reviewer.bundles).toHaveLength(0);
  });

  it("returns a non-retryable error when the Run's plan is missing from the ledger", async () => {
    const harness = await parkOnVerification();
    const { gate } = completionGateOver(harness, {
      persistence: {
        loadVerificationPlan: async () => null,
        commitCandidateBoundary: (command) => harness.store.commitCandidateBoundary(command),
        commitVerifiedCompletion: (command) => harness.store.commitVerifiedCompletion(command),
      },
    });
    const continuation = awaitingVerification(harness);

    const decision = await gate.evaluate({
      identity: identityOf(harness),
      sourceStepId: continuation.sourceStepId,
      candidate: continuation.finalDecision,
      mode: "EXECUTE",
      signal: new AbortController().signal,
    });

    expect(decision).toMatchObject({ kind: "ERROR", retryable: false });
    expect(harness.reviewer.bundles).toHaveLength(0);
  });

  it("returns a non-retryable error when the candidate does not match the plan", async () => {
    let plan: import("@caelush/protocol").VerificationPlan | undefined;
    const harness = await parkOnVerification({
      persistence: (port) => ({
        loadVerificationPlan: async (runId, planId) => {
          const loaded = await port.loadVerificationPlan(runId, planId);
          if (loaded === null) return null;
          plan = { ...loaded, candidateHash: "0".repeat(64) };
          return plan;
        },
        commitCandidateBoundary: (command) => port.commitCandidateBoundary(command),
        commitVerifiedCompletion: (command) => port.commitVerifiedCompletion(command),
      }),
    });
    const { gate } = completionGateOver(harness, {
      persistence: {
        loadVerificationPlan: async () => plan ?? null,
        commitCandidateBoundary: (command) => harness.store.commitCandidateBoundary(command),
        commitVerifiedCompletion: (command) => harness.store.commitVerifiedCompletion(command),
      },
    });
    const continuation = awaitingVerification(harness);

    const decision = await gate.evaluate({
      identity: identityOf(harness),
      sourceStepId: continuation.sourceStepId,
      candidate: continuation.finalDecision,
      mode: "EXECUTE",
      signal: new AbortController().signal,
    });

    expect(decision).toMatchObject({ kind: "ERROR", retryable: false });
    expect(harness.reviewer.bundles).toHaveLength(0);
  });
});

describe("Phase 3E verification freshness", () => {
  it("accepts a candidate whose workspace is provably unchanged", async () => {
    const workspace = stubWorkspace({ inspectionComplete: true, paths: [] });
    const harness = harness3e({
      script: () => candidateTurn("done"),
      checks: WORKSPACE_AND_TASK,
      workspace,
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.run.status).toBe("COMPLETED");
    expect(workspace.inspections).toBe(2);
  });

  it("accepts a candidate whose repository review passed", async () => {
    const git = stubGit({ available: true, clean: true, entries: [] });
    const harness = harness3e({
      script: () => candidateTurn("done"),
      checks: GIT_ONLY,
      git,
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.run.status).toBe("COMPLETED");
    // One status/diff pair for the check, one for the recheck that must precede acceptance.
    expect(git.statusCalls).toBe(2);
  });
  it("accepts a candidate when an optional Git review is unavailable", async () => {
    const harness = harness3e({
      script: () => candidateTurn("done"),
      checks: [{ kind: "GIT", requirement: "IF_AVAILABLE", stage: "CHANGE_REVIEW" }],
      git: stubGit({ available: false }),
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.run.status).toBe("COMPLETED");
    expect(harness.store.snapshot.run.finalResult).toMatchObject({ type: "VERIFIED_COMPLETION" });
  });

  it("rejects a candidate when a required Git review is unavailable", async () => {
    const harness = harness3e({
      script: () => candidateTurn("done"),
      checks: [{ kind: "GIT", requirement: "REQUIRED", stage: "CHANGE_REVIEW" }],
      git: stubGit({ available: false }),
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.run.status).toBe("FAILED");
    expect(harness.eventTypes()).not.toContain("run.completed");
  });

  it("fails when the repository moved after the evidence was taken", async () => {
    const git = stubGit((call) =>
      call === 1
        ? { available: true, clean: true, entries: [] }
        : {
            available: true,
            clean: false,
            entries: [
              { path: "src/a.ts", indexStatus: " ", worktreeStatus: "M", kind: "TRACKED" as const },
            ],
          },
    );
    const harness = harness3e({
      script: () => candidateTurn("done"),
      checks: GIT_ONLY,
      git,
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.status).toBe("FAILED");
    expect(harness.snapshot().run.status).toBe("FAILED");
    expect(harness.verified).toHaveLength(0);
    expect(git.statusCalls).toBe(2);
  });
});

describe("Phase 3E durable verification work", () => {
  it("settles a BLOCKED project runner without continuing to task review", async () => {
    const harness = harness3e({
      script: () => candidateTurn("done"),
      composition: "CANONICAL_ASSEMBLY",
      checks: [
        { kind: "PROJECT", requirement: "REQUIRED", stage: "FAST_STATIC" },
        { kind: "TASK", requirement: "REQUIRED", stage: "ACCEPTANCE" },
      ],
      profileProvider: {
        async getFreshProfile() {
          return {
            ecosystems: ["NODE"],
            packageManager: { name: "pnpm" },
            tooling: [],
            isMonorepo: false,
            rootPackage: { relativePath: ".", scripts: [] },
          };
        },
      },
      execution: {
        async executeArgv() {
          throw new Error("the blocked project runner owns this fixture");
        },
        async interact() {
          throw new Error("the blocked project runner owns this fixture");
        },
      },
      security: { assess: () => ({ kind: "ALLOW", safeReason: "test" }) },
    });
    let runnerCalls = 0;
    harness.projectRunner.run = async ({ plan }) => {
      runnerCalls += 1;
      const projectCheck = plan.checks.find((check) => check.spec.kind === "PROJECT");
      if (projectCheck === undefined) throw new Error("project check was not planned");
      harness.verification.seed({
        ...plan,
        checks: plan.checks.map((check) =>
          check.id === projectCheck.id
            ? { ...check, status: "ERROR" as const, finishedAt: createTimestampMs(1_005) }
            : check,
        ),
      });
      harness.verification.evidence.push({
        id: createVerificationEvidenceId(),
        planId: plan.id,
        checkId: projectCheck.id,
        kind: "COMMAND",
        summary: "Project check failed to start",
        details: {
          label: "project test",
          candidateHash: plan.candidateHash ?? "0".repeat(64),
          errorCode: "SPAWN_FAILED",
          totalOutputBytes: 0,
          omittedBytes: 0,
          truncated: false,
        },
        capturedAt: createTimestampMs(1_005),
      });
      return {
        outcome: "BLOCKED",
        executedCount: 1,
        passedCount: 0,
        failedCount: 0,
        errorCount: 1,
        skippedCount: 0,
        blockingCheckId: projectCheck.id,
      };
    };

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.run.status).toBe("FAILED");
    expect(runnerCalls).toBe(1);
    expect(harness.reviewer.bundles).toHaveLength(0);
    expect(harness.store.snapshot.continuation).toBeUndefined();
  });

  it("keeps VERIFYING only while a project check is durably running", async () => {
    const harness = await parkOnVerification();
    const original = [...harness.verification.plans.values()][0];
    if (original === undefined) throw new Error("candidate plan was not persisted");
    const projectCheck = {
      id: createVerificationCheckId(),
      planId: original.id,
      ordinal: 0,
      stage: "FAST_STATIC" as const,
      requirement: "REQUIRED" as const,
      spec: { kind: "PROJECT" as const, purpose: "TEST" as const, source: "SYSTEM" as const },
      status: "PENDING" as const,
      createdAt: original.createdAt,
    };
    const plan = { ...original, checks: [projectCheck] };
    harness.verification.seed(plan);

    let releaseRunner!: () => void;
    let notifyRunnerEntered!: () => void;
    const runnerReleased = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const runnerEntered = new Promise<void>((resolve) => {
      notifyRunnerEntered = resolve;
    });
    const { gate } = completionGateOver(harness, {
      mode: "RECOVER",
      persistence: {
        loadVerificationPlan: async (_runId, planId) =>
          harness.verification.plans.get(planId) ?? null,
        commitCandidateBoundary: (command) => harness.store.commitCandidateBoundary(command),
        commitVerifiedCompletion: (command) => harness.store.commitVerifiedCompletion(command),
      },
      runner: {
        async run() {
          harness.verification.seed({
            ...plan,
            checks: [{ ...projectCheck, status: "RUNNING", startedAt: createTimestampMs(1_004) }],
          });
          notifyRunnerEntered();
          await runnerReleased;
          return {
            outcome: "PROJECT_CHECKS_PASSED",
            executedCount: 1,
            passedCount: 1,
            failedCount: 0,
            errorCount: 0,
            skippedCount: 0,
          };
        },
      },
      profileProvider: {
        async getFreshProfile() {
          return {
            ecosystems: ["NODE"],
            packageManager: { name: "pnpm" },
            tooling: [],
            isMonorepo: false,
            rootPackage: { relativePath: ".", scripts: [] },
          };
        },
      },
      execution: {
        async executeArgv() {
          throw new Error("not used by the held runner");
        },
        async interact() {
          throw new Error("not used by the held runner");
        },
      },
      security: { assess: () => ({ kind: "ALLOW", safeReason: "test" }) },
      evidenceSanitizer: {
        redactText: (value) => value,
        boundText: (value, maxBytes) => ({
          text: value.slice(0, maxBytes),
          omittedBytes: Math.max(0, Buffer.byteLength(value, "utf8") - maxBytes),
          truncated: Buffer.byteLength(value, "utf8") > maxBytes,
        }),
      },
    });
    const continuation = awaitingVerification(harness);
    const evaluation = gate.evaluate({
      identity: identityOf(harness),
      sourceStepId: continuation.sourceStepId,
      candidate: continuation.finalDecision,
      mode: "RECOVER",
      signal: new AbortController().signal,
    });

    await runnerEntered;
    const active = await harness.verification.getPlanExecutionSnapshot(plan.id);
    expect(harness.store.snapshot.run.status).toBe("VERIFYING");
    expect(active?.plan.checks[0]?.status).toBe("RUNNING");
    releaseRunner();
    await expect(evaluation).resolves.toMatchObject({ kind: "ERROR", retryable: false });
  });

  it("fails a recovered ERROR plus PENDING plan without running the pending check", async () => {
    const harness = harness3e({
      script: () => candidateTurn("done"),
    });
    const completed = await harness.controller.start(harness.store.snapshot.run.id);
    expect(completed.run.status).toBe("COMPLETED");

    const original = [...harness.verification.plans.values()][0];
    if (original === undefined) throw new Error("candidate plan was not persisted");
    const task = original.checks.find((check) => check.spec.kind === "TASK");
    if (task === undefined) throw new Error("task check was not planned");
    const errorCheck = {
      id: createVerificationCheckId(),
      planId: original.id,
      ordinal: 0,
      stage: "FAST_STATIC" as const,
      requirement: "REQUIRED" as const,
      spec: { kind: "PROJECT" as const, purpose: "TEST" as const, source: "SYSTEM" as const },
      status: "ERROR" as const,
      createdAt: original.createdAt,
      finishedAt: createTimestampMs(1_002),
    };
    const pendingCheck = {
      id: createVerificationCheckId(),
      ordinal: original.checks.length,
      planId: original.id,
      status: "PENDING" as const,
      stage: "FAST_STATIC" as const,
      requirement: "REQUIRED" as const,
      spec: { kind: "PROJECT" as const, purpose: "BUILD" as const, source: "SYSTEM" as const },
      createdAt: original.createdAt,
    };
    const plan = { ...original, checks: [errorCheck, task, pendingCheck] };
    harness.verification.seed(plan);
    harness.verification.evidence.push({
      id: createVerificationEvidenceId(),
      planId: plan.id,
      checkId: errorCheck.id,
      kind: "COMMAND",
      summary: "Project check failed to start",
      details: {
        label: "project test",
        candidateHash: plan.candidateHash ?? "0".repeat(64),
        errorCode: "SPAWN_FAILED",
        totalOutputBytes: 0,
        omittedBytes: 0,
        truncated: false,
      },
      capturedAt: createTimestampMs(1_003),
    });
    restoreCommittedCandidateBoundary(harness);
    harness.notifications.splice(0, harness.notifications.length);
    const projectRunsBeforeRecovery = harness.projectRunner.runs.length;

    const failed = await harness.controller.recover(harness.store.snapshot.run.id);
    const reopened = await harness.controller.recover(harness.store.snapshot.run.id);

    expect(failed.run.status).toBe("FAILED");
    expect(reopened.run.status).toBe("FAILED");
    expect(harness.projectRunner.runs).toHaveLength(projectRunsBeforeRecovery);
    expect(harness.eventTypes().filter((type) => type === "run.failed")).toHaveLength(1);
  });

  it("does not execute a pending project check when recovery finds a durable blocker", async () => {
    const harness = await parkOnVerification();
    const original = [...harness.verification.plans.values()][0];
    if (original === undefined) throw new Error("candidate plan was not persisted");
    const [task] = original.checks;
    if (task === undefined) throw new Error("task acceptance check was not planned");
    const errorCheck = {
      id: createVerificationCheckId(),
      planId: original.id,
      ordinal: 0,
      stage: "FAST_STATIC" as const,
      requirement: "REQUIRED" as const,
      spec: { kind: "PROJECT" as const, purpose: "TEST" as const, source: "SYSTEM" as const },
      status: "ERROR" as const,
      createdAt: original.createdAt,
      finishedAt: createTimestampMs(1_001),
    };
    const pendingProjectCheck = {
      id: createVerificationCheckId(),
      planId: original.id,
      ordinal: 1,
      stage: "FAST_STATIC" as const,
      requirement: "REQUIRED" as const,
      spec: { kind: "PROJECT" as const, purpose: "BUILD" as const, source: "SYSTEM" as const },
      status: "PENDING" as const,
      createdAt: original.createdAt,
    };
    const pendingTaskCheck = { ...task, ordinal: 2 };
    const plan = {
      ...original,
      checks: [errorCheck, pendingProjectCheck, pendingTaskCheck],
    };
    harness.verification.seed(plan);
    harness.verification.evidence.push({
      id: createVerificationEvidenceId(),
      planId: plan.id,
      checkId: errorCheck.id,
      kind: "COMMAND",
      summary: "Project test command failed to start",
      details: {
        label: "project test",
        candidateHash: plan.candidateHash ?? "0".repeat(64),
        errorCode: "SPAWN_FAILED",
        totalOutputBytes: 0,
        omittedBytes: 0,
        truncated: false,
      },
      capturedAt: createTimestampMs(1_001),
    });

    let projectRunnerCalls = 0;
    const { gate } = completionGateOver(harness, {
      mode: "RECOVER",
      persistence: {
        loadVerificationPlan: async (_runId, planId) =>
          harness.verification.plans.get(planId) ?? null,
        commitCandidateBoundary: (command) => harness.store.commitCandidateBoundary(command),
        commitVerifiedCompletion: (command) => harness.store.commitVerifiedCompletion(command),
      },
      runner: {
        async run() {
          projectRunnerCalls += 1;
          return {
            outcome: "PROJECT_CHECKS_PASSED",
            executedCount: 0,
            passedCount: 0,
            failedCount: 0,
            errorCount: 0,
            skippedCount: 0,
          };
        },
      },
      profileProvider: {
        async getFreshProfile() {
          return {
            ecosystems: ["NODE"],
            packageManager: { name: "pnpm" },
            tooling: [],
            isMonorepo: false,
            rootPackage: { relativePath: ".", scripts: [] },
          };
        },
      },
      execution: {
        async executeArgv() {
          throw new Error("the pending project check must not execute");
        },
        async interact() {
          throw new Error("the pending project check must not interact");
        },
      },
      security: { assess: () => ({ kind: "ALLOW", safeReason: "test" }) },
      evidenceSanitizer: {
        redactText: (value) => value,
        boundText: (value, maxBytes) => ({
          text: value.slice(0, maxBytes),
          omittedBytes: Math.max(0, Buffer.byteLength(value, "utf8") - maxBytes),
          truncated: Buffer.byteLength(value, "utf8") > maxBytes,
        }),
      },
    });
    const continuation = awaitingVerification(harness);

    const decision = await gate.evaluate({
      identity: identityOf(harness),
      sourceStepId: continuation.sourceStepId,
      candidate: continuation.finalDecision,
      mode: "RECOVER",
      signal: new AbortController().signal,
    });

    expect(decision.kind).toBe("ERROR");
    expect(projectRunnerCalls).toBe(0);
  });

  it("settles an interrupted check once and never replays it", async () => {
    let firstPlanId: string | undefined;
    const harness = harness3e({
      script: () => candidateTurn("done"),
      persistence: (port) => ({
        loadVerificationPlan: (runId, planId) => port.loadVerificationPlan(runId, planId),
        commitCandidateBoundary: (command) => {
          // A restart found a check that was already RUNNING. Its side-effect boundary is unknown, so
          // it must be settled as bounded interrupted-error evidence rather than executed again.
          firstPlanId = command.verificationPlan.id;
          const [first, ...rest] = command.verificationPlan.checks;
          return port.commitCandidateBoundary({
            ...command,
            verificationPlan: {
              ...command.verificationPlan,
              checks: [
                { ...first!, status: "RUNNING" as const, startedAt: command.state.updatedAt },
                ...rest,
              ],
            },
          });
        },
        commitVerifiedCompletion: (command) => port.commitVerifiedCompletion(command),
      }),
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.run.status).toBe("FAILED");
    expect(harness.reviewer.bundles).toHaveLength(0);
    expect(harness.projectRunner.runs).toHaveLength(0);
    expect(harness.verification.settlements(firstPlanId as never)).toBe(1);
    // Exactly one row: the bounded interrupted-error evidence. No check was executed, so no discovery
    // row and no review row exists for it.
    expect(harness.verification.evidence).toHaveLength(1);
    expect(harness.verification.evidence.at(-1)?.details).toMatchObject({
      errorCode: "VERIFICATION_INTERRUPTED",
    });
  });

  it("fails a Run when its verification plan is missing and never recovers it", async () => {
    let planLoaded = false;
    const reviewer = stubReviewer({ status: "PASSED" });
    const harness = harness3e({
      script: () => candidateTurn("done"),
      reviewer,
      workspace: stubWorkspace({ inspectionComplete: true, paths: [] }),
      checks: WORKSPACE_AND_TASK,
      persistence: (port) => ({
        // The first evaluation cannot read the plan at all, which is a real transient ledger failure.
        loadVerificationPlan: (runId, planId) => {
          if (!planLoaded) {
            planLoaded = true;
            return Promise.resolve(null);
          }
          return port.loadVerificationPlan(runId, planId);
        },
        commitCandidateBoundary: (command) => port.commitCandidateBoundary(command),
        commitVerifiedCompletion: (command) => port.commitVerifiedCompletion(command),
      }),
    });

    const failed = await harness.controller.start(harness.store.snapshot.run.id);
    expect(failed.run.status).toBe("FAILED");
    expect(reviewer.bundles).toHaveLength(0);

    const recovered = await harness.controller.recover(harness.store.snapshot.run.id);

    expect(recovered.run.status).toBe("FAILED");
    expect(harness.eventTypes().filter((type) => type === "run.failed")).toHaveLength(1);
    expect(reviewer.bundles).toHaveLength(0);
    expect(harness.turns).toHaveLength(1);
  });

  it("re-uses a durable passed check instead of reviewing the candidate twice", async () => {
    const reviewer = stubReviewer({ status: "PASSED" });
    const workspace = stubWorkspace((call) =>
      call === 2
        ? { inspectionComplete: false, paths: [] }
        : { inspectionComplete: true, paths: [] },
    );
    const harness = harness3e({
      script: () => candidateTurn("done"),
      reviewer,
      workspace,
      checks: WORKSPACE_AND_TASK,
    });

    const failed = await harness.controller.start(harness.store.snapshot.run.id);
    expect(failed.status).toBe("FAILED");
    expect(reviewer.bundles).toHaveLength(1);

    const recovered = await harness.controller.recover(harness.store.snapshot.run.id);

    expect(recovered.run.status).toBe("FAILED");
    expect(reviewer.bundles).toHaveLength(1);
    // The failed verification is terminal; recovery does not perform another inspection.
    expect(workspace.inspections).toBe(2);
  });

  it("fails when completion cannot be committed", async () => {
    const harness = harness3e({
      script: () => candidateTurn("done"),
      persistence: (port) => ({
        loadVerificationPlan: (runId, planId) => port.loadVerificationPlan(runId, planId),
        commitCandidateBoundary: (command) => port.commitCandidateBoundary(command),
        commitVerifiedCompletion: () =>
          Promise.reject(new RunExecutionConflictError("completion conflict")),
      }),
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    // The model turn and the review each ran once, and neither was replayed to resolve the conflict.
    expect(harness.turns).toHaveLength(1);
    expect(harness.reviewer.bundles).toHaveLength(1);
    expect(harness.eventTypes()).not.toContain("run.completed");
    expect(result.run.status).toBe("FAILED");
    expect(harness.snapshot().run.status).toBe("FAILED");
    expect(harness.eventTypes().filter((type) => type === "run.failed")).toHaveLength(1);
    const errorEvent = harness.notifications.find((event) => event.type === "error");
    expect(errorEvent?.payload).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        phase: "VERIFICATION",
        details: { reasonCode: "VERIFICATION_COMPLETION_COMMIT_ERROR" },
      },
    });
    expect(JSON.stringify(errorEvent?.payload)).not.toContain("completion conflict");
  });
});

describe("Phase 3E task acceptance review", () => {
  it("fails the Run when the reviewer cannot reach a verdict", async () => {
    const harness = harness3e({
      script: () => candidateTurn("done"),
      reviewer: stubReviewer({ status: "ERROR", errorCode: "REVIEWER_TIMEOUT" }),
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.run.status).toBe("FAILED");
    expect(harness.store.snapshot.continuation).toBeUndefined();
    expect(harness.eventTypes().filter((type) => type === "run.failed")).toHaveLength(1);
    expect(harness.eventTypes()).not.toContain("run.completed");
    // An unreviewable candidate is an errored check. Without a durable retry schedule, the Run fails.
    expect(harness.eventTypes()).not.toContain("verification.repair.started");
  });

  it("fails a reviewer infrastructure error without scheduling a recovery retry", async () => {
    const reviewer = stubReviewer({ status: "ERROR", errorCode: "REVIEWER_RESPONSE_INVALID" });
    const harness = harness3e({
      script: () => candidateTurn("done"),
      reviewer,
      checks: WORKSPACE_AND_TASK,
    });

    const failed = await harness.controller.start(harness.store.snapshot.run.id);
    expect(failed.run.status).toBe("FAILED");
    expect(reviewer.bundles).toHaveLength(1);
    expect(harness.verification.started).toHaveLength(2);

    const recovered = await harness.controller.recover(harness.store.snapshot.run.id);

    expect(recovered.run.status).toBe("FAILED");
    expect(reviewer.bundles).toHaveLength(1);
    expect(harness.verification.started).toHaveLength(2);
    expect(harness.workspace.inspections).toBe(1);
    const errorEvent = harness.notifications.find((event) => event.type === "error");
    expect(errorEvent?.payload).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        phase: "VERIFICATION",
        details: { reasonCode: "REVIEWER_INFRASTRUCTURE_ERROR" },
      },
    });
    expect(JSON.stringify(errorEvent?.payload)).not.toContain("reviewer response");
  });

  it("keeps a real failed review classified as VERIFICATION_FAILED", async () => {
    const harness = harness3e({
      script: () => candidateTurn("done"),
      reviewer: stubReviewer({ status: "FAILED" }),
      repairPolicy: { maxAutoRepairs: 0, canRepair: () => false },
    });

    const failed = await harness.controller.start(harness.store.snapshot.run.id);
    const errorEvent = harness.notifications.find((event) => event.type === "error");
    const plan = [...harness.verification.plans.values()][0];
    const taskCheck = plan?.checks.find((check) => check.spec.kind === "TASK");

    expect(failed.run.status).toBe("FAILED");
    expect(
      plan === undefined || taskCheck === undefined
        ? undefined
        : harness.verification.check(plan.id, taskCheck.id)?.status,
    ).toBe("FAILED");
    expect(errorEvent?.payload).toMatchObject({
      error: {
        code: "VERIFICATION_FAILED",
        phase: "VERIFICATION",
      },
    });
    expect(errorEvent?.payload).not.toHaveProperty("error.details.reasonCode");
  });

  it("never lets a task review read its own verdict as evidence", async () => {
    const reviewer = stubReviewer({ status: "PASSED" });
    const harness = harness3e({ script: () => candidateTurn("done"), reviewer });

    await harness.controller.start(harness.store.snapshot.run.id);

    const bundle = reviewer.bundles[0]!;
    expect(bundle.candidateText).toBe("done");
    expect(bundle.originalGoal).toBe(harness.store.snapshot.run.goal);
    // The only evidence the reviewer may see is the inspection row that preceded it.
    expect(bundle.evidence.map((item) => item.kind)).toEqual(["DISCOVERY"]);
    expect(bundle.plan.checks.map((check) => check.status)).toEqual(["PENDING"]);
  });

  it("includes bounded durable Agent Tool observations in the task review bundle", async () => {
    const reviewer = stubReviewer({ status: "PASSED" });
    const harness = harness3e({
      script: () => candidateTurn("done"),
      reviewer,
      composition: "CANONICAL_ASSEMBLY",
      toolObservations: (runId) => [
        {
          observation: {
            id: createObservationId(),
            runId,
            stepId: createStepId(),
            kind: "TOOL",
            toolInvocationId: createToolInvocationId(),
            content: "javac exit=0",
            details: { status: "EXITED", exitCode: 0, workdir: "fixture" },
            isError: false,
            createdAt: createTimestampMs(1_001),
          },
          toolName: "exec_command",
          invocationStatus: "COMPLETED",
        },
      ],
    });

    await harness.controller.start(harness.store.snapshot.run.id);
    expect(reviewer.bundles[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "COMMAND",
          details: expect.objectContaining({
            source: "AGENT_TOOL_OBSERVATION",
            toolName: "exec_command",
            content: "javac exit=0",
          }),
        }),
      ]),
    );
  });
});

describe("Phase 3E completion settlement routing", () => {
  const error = {
    code: "INTERNAL_ERROR",
    message: "no decision",
    retryable: false,
    phase: "VERIFICATION",
  } as const;

  it("routes retryable completion errors through canonical Run failure", () => {
    const route = classifyCompletionEffectSettlement({
      decision: { kind: "ERROR", error, retryable: true },
      observation: createCompletionGateObservation({ effectiveMode: "EXECUTE" }),
      terminationDecided: false,
    });

    expect(route.route).toBe("CANONICAL_REJECT");
  });

  it("settles a non-retryable completion error as a rejection", () => {
    const route = classifyCompletionEffectSettlement({
      decision: {
        kind: "ERROR",
        error: { ...error, code: "VERIFICATION_FAILED" },
        retryable: false,
      },
      observation: createCompletionGateObservation({ effectiveMode: "EXECUTE" }),
      terminationDecided: false,
    });

    expect(route.route).toBe("CANONICAL_REJECT");
  });

  it("refuses a repair the gate did not establish the provenance for", () => {
    expect(() =>
      classifyCompletionEffectSettlement({
        decision: {
          kind: "REPAIR",
          repair: { repairRef: "vplan_x", cycle: 0, reason: "policy allows another attempt" },
        },
        observation: createCompletionGateObservation({ effectiveMode: "EXECUTE" }),
        terminationDecided: false,
      }),
    ).toThrow(TypeError);
  });

  it("gives the termination authority precedence over every completion decision", () => {
    const observation = createCompletionGateObservation({ effectiveMode: "EXECUTE" });
    for (const decision of [
      { kind: "ACCEPT", finalResult: { type: "VERIFIED_COMPLETION", text: "done" } },
      { kind: "REJECT", error },
      { kind: "ERROR", error, retryable: true },
    ] as const) {
      expect(
        classifyCompletionEffectSettlement({ decision, observation, terminationDecided: true })
          .route,
      ).toBe("TERMINATION_AUTHORITY");
    }
  });

  it("preserves termination authority over a simultaneous verification error", () => {
    const route = classifyCompletionEffectSettlement({
      decision: { kind: "ERROR", error, retryable: false },
      observation: createCompletionGateObservation({ effectiveMode: "EXECUTE" }),
      terminationDecided: true,
    });

    expect(route.route).toBe("TERMINATION_AUTHORITY");
  });
});
