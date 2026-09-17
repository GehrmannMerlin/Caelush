import { describe, expect, it } from "vitest";
import { createTimestampMs } from "@caelush/protocol";

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

  it("leaves the Run on its durable boundary when the host composed no verification", async () => {
    const harness = harness3e({
      script: () => candidateTurn("done"),
      verificationStore: false,
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    expect(result.status).toBe("AWAITING_VERIFICATION");
    const snapshot = harness.snapshot();
    expect(snapshot.run.status).toBe("VERIFYING");
    expect(awaitingVerification(harness).sourceStepId).toBeDefined();
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

    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(harness.snapshot().run.status).toBe("VERIFYING");
    expect(harness.verified).toHaveLength(0);
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
      reviewer: stubReviewer({ status: "PASSED" }),
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
  });
});

/** Park a Run on its durable verification boundary without evaluating it. */
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
    // No verification execution store: the gate cannot reach a decision, so the Run stays exactly on
    // the boundary the candidate opened. That is a real production state, not a fabricated one.
    verificationStore: false,
    ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
    ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
  });
  const result = await harness.controller.start(harness.store.snapshot.run.id);
  expect(result.status).toBe("AWAITING_VERIFICATION");
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

  it("suspends rather than deciding when the evaluation is already aborted", async () => {
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

    expect(decision).toMatchObject({ kind: "ERROR", retryable: true });
    expect(harness.reviewer.bundles).toHaveLength(0);
  });

  it("suspends when the Run's plan is missing from the ledger", async () => {
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

    expect(decision).toMatchObject({ kind: "ERROR", retryable: true });
    expect(harness.reviewer.bundles).toHaveLength(0);
  });

  it("suspends when the candidate is not the one the plan bounded", async () => {
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

    expect(decision).toMatchObject({ kind: "ERROR", retryable: true });
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

  it("suspends when the repository moved after the evidence was taken", async () => {
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

    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(harness.snapshot().run.status).toBe("VERIFYING");
    expect(harness.verified).toHaveLength(0);
    expect(git.statusCalls).toBe(2);
  });
});

describe("Phase 3E durable verification work", () => {
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

  it("re-evaluates the same candidate after a suspension without redoing the review", async () => {
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

    const suspended = await harness.controller.start(harness.store.snapshot.run.id);
    expect(suspended.status).toBe("AWAITING_VERIFICATION");
    expect(reviewer.bundles).toHaveLength(0);

    const recovered = await harness.controller.recover(harness.store.snapshot.run.id);

    expect(recovered.run.status).toBe("COMPLETED");
    // One review and one provider turn for the whole Run: recovery re-used the durable work.
    expect(reviewer.bundles).toHaveLength(1);
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

    const suspended = await harness.controller.start(harness.store.snapshot.run.id);
    expect(suspended.status).toBe("AWAITING_VERIFICATION");
    expect(reviewer.bundles).toHaveLength(1);

    const recovered = await harness.controller.recover(harness.store.snapshot.run.id);

    expect(recovered.run.status).toBe("COMPLETED");
    expect(reviewer.bundles).toHaveLength(1);
    // One inspection for the check, one stale recheck, one recheck that finally agrees.
    expect(workspace.inspections).toBe(3);
  });

  it("refuses to commit a completion whose durable revision moved", async () => {
    const harness = harness3e({
      script: () => candidateTurn("done"),
      persistence: (port) => ({
        loadVerificationPlan: (runId, planId) => port.loadVerificationPlan(runId, planId),
        commitCandidateBoundary: (command) => port.commitCandidateBoundary(command),
        commitVerifiedCompletion: () =>
          Promise.reject(new RunExecutionConflictError("completion conflict")),
      }),
    });

    await expect(harness.controller.start(harness.store.snapshot.run.id)).rejects.toBeInstanceOf(
      RunExecutionConflictError,
    );

    // The model turn and the review each ran once, and neither was replayed to resolve the conflict.
    expect(harness.turns).toHaveLength(1);
    expect(harness.reviewer.bundles).toHaveLength(1);
    expect(harness.eventTypes()).not.toContain("run.completed");
    expect(harness.snapshot().run.status).toBe("VERIFYING");
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
    expect(harness.eventTypes()).not.toContain("run.completed");
    // An unreviewable candidate is an errored check, not a refused one — and an errored check is
    // never repairable, so this is terminal rather than a new attempt.
    expect(harness.eventTypes()).not.toContain("verification.repair.started");
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
});

describe("Phase 3E completion settlement routing", () => {
  const error = {
    code: "INTERNAL_ERROR",
    message: "no decision",
    retryable: false,
    phase: "VERIFICATION",
  } as const;

  it("suspends a retryable completion error instead of failing the Run", () => {
    const route = classifyCompletionEffectSettlement({
      decision: { kind: "ERROR", error, retryable: true },
      observation: createCompletionGateObservation({ effectiveMode: "EXECUTE" }),
      terminationDecided: false,
    });

    expect(route.route).toBe("RETRYABLE_ERROR_SUSPEND");
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
});
