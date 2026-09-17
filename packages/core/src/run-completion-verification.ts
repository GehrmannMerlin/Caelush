import type {
  AgentError,
  AgentRun,
  AgentState,
  VerificationCheck,
  VerificationCheckId,
  VerificationEvidence,
  VerificationPlan,
} from "@caelush/protocol";
import { VerificationEvidenceSchema, createVerificationEvidenceId } from "@caelush/protocol";
import type { CompletionGateDecision } from "@caelush/agent";
import {
  VerificationStageRunner,
  buildTaskReviewBundle,
  computeVerificationEvidenceDigest,
  computeWorkspaceFreshnessHash,
  createDiscoveryEvidence,
  createGitEvidence,
  createTaskAcceptanceEvidence,
  createVerificationCompletionSeal,
  createVerificationRepairPolicy,
  createWorkspaceEvidence,
  evaluateVerification,
  ProjectCheckResolverRegistry,
  repairCycleForPlanCount,
  reviewGitChangeset,
  verifyWorkspaceInspection,
  type VerificationExecutionRecoveryStorePort,
  type TaskReviewBundle,
} from "@caelush/verification";

import {
  createVerifiedRunFinalResult,
  evaluateCompletionAuthority,
  type CompletionFreshness,
  type CompletionGitFreshness,
} from "./completion-authority.js";
import type { DurableAgentEvent } from "./run-execution-store.js";
import type { CompletionGateObservation } from "./run-completion-observation.js";
import type {
  CompletionBoundaryOpening,
  RunCompletionGateDependencies,
} from "./run-completion-context.js";

/**
 * The verification body of the coding completion gate.
 *
 * ```text
 * PROJECT checks        the project's own lint / typecheck / test / build, through the Runner
 * WORKSPACE check       did the files the candidate claims to have changed actually change that way
 * GIT check             is the repository still the one the evidence was taken from
 * TASK check            an independent model review of the task acceptance bundle
 *        ↓
 * freshness re-check    immediately before a completion may be established
 *        ↓
 * completion authority  the frozen Phase 11D rules
 *        ↓
 * seal + verified result
 * ```
 *
 * It is deliberately separate from the gate that calls it. The gate owns the *contract* — one typed
 * decision, no lifecycle write — and this module owns the *workflow*, which is the largest single
 * piece of behaviour Phase 3E moved out of the RunController.
 *
 * Every durability rule the verification subsystem already had is preserved verbatim:
 *
 * ```text
 * a RUNNING check after a restart is settled once as interrupted ERROR evidence and never replayed
 * a durable PASSED / FAILED / ERROR / SKIPPED check is never executed again
 * evidence is committed by the verification store, with its own event after the commit
 * ```

 * `PROJECT` checks run first and through the existing runner; the change checks then run through the
 * existing stage runner, whose three executors are the workspace, Git and task-review ports.
 */

/** What one verification pass concluded. */
export type CompletionVerificationOutcome =
  | {
      readonly kind: "ACCEPT";
      readonly finalResult: import("@caelush/protocol").VerifiedRunFinalResult;
    }
  | { readonly kind: "REPAIR"; readonly decision: CompletionGateDecision }
  | { readonly kind: "REJECT"; readonly decision: CompletionGateDecision }
  | { readonly kind: "ERROR"; readonly decision: CompletionGateDecision };

/** Everything one verification pass needs, which is everything the gate captured plus its topic. */
export type CompletionVerificationContext = RunCompletionGateDependencies;

export async function runCompletionVerification(
  dependencies: CompletionVerificationContext,
  observation: CompletionGateObservation,
  plan: VerificationPlan,
  candidateHash: string,
): Promise<CompletionVerificationOutcome> {
  const recovery = recoveryStore(dependencies);
  if (recovery === undefined) {
    return errorOutcome("VERIFICATION_STORE_UNAVAILABLE");
  }

  // ```text
  // a check a restart interrupted has no known outcome
  //        ↓
  // settle it once as bounded ERROR evidence
  //        ↓
  // never replay it
  // ```
  if (plan.checks.some((check) => check.status === "RUNNING")) {
    await settleInterruptedChecks(dependencies, plan);
    const reloaded = await loadPlan(dependencies);
    if (reloaded === null) return errorOutcome("VERIFICATION_PLAN_MISSING");
    return continueVerification(dependencies, observation, reloaded, candidateHash, true);
  }
  return continueVerification(dependencies, observation, plan, candidateHash, false);
}

async function continueVerification(
  dependencies: CompletionVerificationContext,
  observation: CompletionGateObservation,
  plan: VerificationPlan,
  candidateHash: string,
  recheckAfterInterruption: boolean,
): Promise<CompletionVerificationOutcome> {
  const withProjectChecks = await ensureProjectChecks(dependencies, plan, recheckAfterInterruption);
  if (withProjectChecks.kind !== "CONTINUE") return withProjectChecks.outcome;
  const current = withProjectChecks.plan;

  const recovery = recoveryStore(dependencies);
  if (recovery === undefined) return errorOutcome("VERIFICATION_STORE_UNAVAILABLE");
  const execution = await recovery.getPlanExecutionSnapshot(current.id);
  if (execution === null) return errorOutcome("VERIFICATION_EVIDENCE_MISSING");
  observation.plan = execution.plan;

  const evaluation = evaluateVerification(execution.plan, execution.evidence);
  observation.verificationStatus = evaluation.status;
  observation.failedCheckIds = evaluation.failedCheckIds;
  observation.errorCheckIds = evaluation.errorCheckIds;

  if (evaluation.status === "FAILED") {
    return repairOrReject(
      dependencies,
      observation,
      execution.plan,
      execution.evidence,
      evaluation,
    );
  }
  if (evaluation.status === "ERROR") {
    return {
      kind: "REJECT",
      decision: rejectDecision(
        evaluation.status,
        evaluation.failedCheckIds,
        evaluation.errorCheckIds,
      ),
    };
  }

  const blockingBeforeChange = execution.plan.checks.some(
    (check) => check.status === "FAILED" || check.status === "ERROR" || check.status === "RUNNING",
  );
  if (blockingBeforeChange) return errorOutcome("VERIFICATION_BLOCKED");

  const pendingChangeChecks = execution.plan.checks.some(
    (check) => check.spec.kind !== "PROJECT" && check.status === "PENDING",
  );
  const afterChange = pendingChangeChecks
    ? await runChangeChecks(dependencies, observation, execution.plan, candidateHash)
    : { kind: "CONTINUE" as const };
  if (afterChange.kind !== "CONTINUE") return afterChange.outcome;

  const settled = await recovery.getPlanExecutionSnapshot(execution.plan.id);
  if (settled === null) return errorOutcome("VERIFICATION_EVIDENCE_MISSING");
  observation.plan = settled.plan;
  const finalEvaluation = evaluateVerification(settled.plan, settled.evidence);
  observation.verificationStatus = finalEvaluation.status;
  observation.failedCheckIds = finalEvaluation.failedCheckIds;
  observation.errorCheckIds = finalEvaluation.errorCheckIds;

  if (finalEvaluation.status === "PASSED") {
    return finalizePassed(
      dependencies,
      observation,
      settled.plan,
      settled.evidence,
      finalEvaluation,
      candidateHash,
    );
  }
  if (finalEvaluation.status === "ERROR") {
    return {
      kind: "REJECT",
      decision: rejectDecision(
        finalEvaluation.status,
        finalEvaluation.failedCheckIds,
        finalEvaluation.errorCheckIds,
      ),
    };
  }
  if (finalEvaluation.status === "FAILED") {
    return repairOrReject(
      dependencies,
      observation,
      settled.plan,
      settled.evidence,
      finalEvaluation,
    );
  }
  return errorOutcome("VERIFICATION_INCOMPLETE");
}

/* ------------------------------------------------------ project checks */

type StepResult =
  | { readonly kind: "CONTINUE"; readonly plan: VerificationPlan }
  | { readonly kind: "STOP"; readonly outcome: CompletionVerificationOutcome };

/**
 * Run the plan's `PROJECT` checks, exactly once each.
 *
 * A plan with no pending project check is not re-run: the existing statuses are the durable answer,
 * and re-executing a settled `lint` or `test` would be a second physical verification of a Run that
 * already paid for the first one.
 */
async function ensureProjectChecks(
  dependencies: CompletionVerificationContext,
  plan: VerificationPlan,
  recheckAfterInterruption: boolean,
): Promise<StepResult> {
  const pending = plan.checks.some(
    (check) => check.spec.kind === "PROJECT" && check.status === "PENDING",
  );
  if (!pending) return { kind: "CONTINUE", plan };
  const runner = dependencies.runner;
  const execution = dependencies.execution;
  const executionStore = dependencies.executionStore;
  const security = dependencies.security;
  const sanitizer = dependencies.evidenceSanitizer;
  const profileProvider = dependencies.profileProvider;
  if (
    runner === undefined ||
    execution === undefined ||
    executionStore === undefined ||
    security === undefined ||
    sanitizer === undefined ||
    profileProvider === undefined
  ) {
    // A host that composed project verification out is not a completion failure: the plan's project
    // checks simply cannot run, and the Run stays on its durable boundary.
    return { kind: "STOP", outcome: errorOutcome("VERIFICATION_NOT_COMPOSED") };
  }
  const config = await dependencies.configResolver.resolve(dependencies.run);
  const profile = await profileProvider.getFreshProfile(dependencies.run, config);
  await runner.run({
    runId: dependencies.run.id,
    sessionId: dependencies.run.sessionId,
    plan,
    profile,
    permissionProfile: dependencies.run.permissionProfile,
    approvalPolicy: dependencies.run.approvalPolicy,
    signal: dependencies.signal,
    now: () => dependencies.clock.now(),
    resolverRegistry: dependencies.resolverRegistry ?? new ProjectCheckResolverRegistry(),
    security,
    execution,
    store: executionStore,
    evidenceIdFactory: dependencies.evidenceIdFactory ?? createVerificationEvidenceId,
    evidenceSanitizer: sanitizer,
    onCommittedEvents: (events) =>
      dependencies.notifyCommitted(events as readonly DurableAgentEvent[]),
  });
  void recheckAfterInterruption;
  const reloaded = await loadPlan(dependencies);
  if (reloaded === null)
    return { kind: "STOP", outcome: errorOutcome("VERIFICATION_PLAN_MISSING") };
  return { kind: "CONTINUE", plan: reloaded };
}

/* ------------------------------------------------------- change checks */

async function runChangeChecks(
  dependencies: CompletionVerificationContext,
  observation: CompletionGateObservation,
  plan: VerificationPlan,
  candidateHash: string,
): Promise<
  | { readonly kind: "CONTINUE" }
  | { readonly kind: "STOP"; readonly outcome: CompletionVerificationOutcome }
> {
  const recovery = recoveryStore(dependencies);
  const store = dependencies.executionStore ?? recovery;
  const workspace = dependencies.workspace;
  const git = dependencies.git;
  const reviewer = dependencies.reviewer;
  if (
    recovery === undefined ||
    store === undefined ||
    workspace === undefined ||
    git === undefined ||
    reviewer === undefined
  ) {
    return { kind: "STOP", outcome: errorOutcome("VERIFICATION_NOT_COMPOSED") };
  }
  const run = dependencies.run;
  const state = dependencies.state;
  const signal = dependencies.signal;
  const changedFiles = state.changedFiles;
  const evidenceId = dependencies.evidenceIdFactory ?? createVerificationEvidenceId;
  let cachedGitStatus: Awaited<ReturnType<typeof git.status>> | undefined;
  const stage = await new VerificationStageRunner().run({
    runId: run.id,
    sessionId: run.sessionId,
    plan,
    store,
    signal,
    now: () => dependencies.clock.now(),
    discoveryEvidence: (check, capturedAt) =>
      VerificationEvidenceSchema.parse({
        id: evidenceId(),
        planId: plan.id,
        checkId: check.id,
        kind: "DISCOVERY",
        summary: `${check.spec.kind} verification inspection prepared`,
        details: { kind: check.spec.kind, purpose: check.spec.purpose },
        capturedAt,
      }),
    onCommittedEvents: (events: readonly { readonly type: string }[]) =>
      dependencies.notifyCommitted(events as readonly DurableAgentEvent[]),
    executors: {
      WORKSPACE: {
        execute: async (check) => {
          const facts = await workspace.inspect({ workspace: run.workspace, changedFiles, signal });
          const result = verifyWorkspaceInspection({ changedFiles, facts });
          const evidence = createWorkspaceEvidence({
            id: evidenceId(),
            planId: plan.id,
            checkId: check.id,
            capturedAt: dependencies.clock.now(),
            result,
          });
          return { status: result.status, evidence: [evidence] };
        },
      },
      GIT: {
        preflight: async (check) => {
          cachedGitStatus = await git.status({ workspace: run.workspace, signal });
          if (cachedGitStatus.available || check.requirement === "REQUIRED") return undefined;
          return {
            status: "SKIPPED" as const,
            skipReason: "NOT_AVAILABLE" as const,
            evidence: [
              createDiscoveryEvidence({
                id: evidenceId(),
                planId: plan.id,
                checkId: check.id,
                capturedAt: dependencies.clock.now(),
                resolver: "runtime-git",
                ecosystem: "git",
                available: false,
                reason: "TOOLING_UNAVAILABLE",
              }),
            ],
          };
        },
        execute: async (check) => {
          const status =
            cachedGitStatus ??
            (cachedGitStatus = await git.status({ workspace: run.workspace, signal }));
          const diffs = await collectGitDiffs(git, run, changedFiles, status, signal);
          const result = reviewGitChangeset({
            changedFiles,
            requirement: check.requirement,
            status,
            diffs,
          });
          const evidence = createGitEvidence({
            id: evidenceId(),
            planId: plan.id,
            checkId: check.id,
            capturedAt: dependencies.clock.now(),
            result,
          });
          return { status: result.status, evidence: [evidence] };
        },
      },
      TASK: {
        execute: async (check) => {
          const bundle = buildTaskReviewBundle({
            originalGoal: run.goal,
            candidateText: dependencies.continuation.finalDecision.candidateText,
            plan,
            evidence: (await recovery.getPlanExecutionSnapshot(plan.id))?.evidence ?? [],
            changedFiles,
          });
          const review = await reviewer.review({
            run,
            candidateText: dependencies.continuation.finalDecision.candidateText,
            bundle,
            signal,
          });
          const evidence =
            review.review === undefined
              ? taskErrorEvidence(
                  dependencies,
                  plan.id,
                  check.id,
                  review.errorCode ?? "REVIEWER_ERROR",
                  review.reviewInputHash,
                )
              : createTaskAcceptanceEvidence({
                  id: evidenceId(),
                  planId: plan.id,
                  checkId: check.id,
                  capturedAt: dependencies.clock.now(),
                  reviewInputHash: review.reviewInputHash,
                  verdict: review.review.verdict,
                  summary: review.review.summary,
                  ...(review.review.repairInstructions === undefined
                    ? {}
                    : { repairInstructions: review.review.repairInstructions }),
                  reviewedEvidenceIds: bundle.evidence.map((item) => item.id),
                });
          return { status: review.status, evidence: [evidence] };
        },
      },
    },
  });
  if (stage.outcome === "CANCELLED")
    return { kind: "STOP", outcome: errorOutcome("VERIFICATION_CANCELLED") };
  void candidateHash;
  const reloaded = await loadPlan(dependencies);
  if (reloaded === null)
    return { kind: "STOP", outcome: errorOutcome("VERIFICATION_PLAN_MISSING") };
  observation.plan = reloaded;
  return { kind: "CONTINUE" };
}

/** Collect the bounded Git diff set for the change review. */
async function collectGitDiffs(
  git: NonNullable<RunCompletionGateDependencies["git"]>,
  run: AgentRun,
  changedFiles: AgentState["changedFiles"],
  status: Awaited<ReturnType<typeof git.status>>,
  signal: AbortSignal,
): Promise<readonly Awaited<ReturnType<typeof git.diff>>[]> {
  const diffs: Awaited<ReturnType<typeof git.diff>>[] = [];
  for (const changedFile of changedFiles.slice(0, 128)) {
    if (
      status.entries?.some((entry) => entry.path === changedFile.path && entry.kind === "UNTRACKED")
    ) {
      continue;
    }
    diffs.push(
      await git.diff({ workspace: run.workspace, path: changedFile.path, scope: "ALL", signal }),
    );
  }
  return diffs;
}

/* ------------------------------------------------------------ finalize */

/**
 * Establish, or refuse, a verified completion.
 *
 * ```text
 * freshness recheck      the workspace and repository must still be the ones the evidence describes
 * completion authority   the frozen Phase 11D rules, including the exact candidate hash
 * seal                   binds run, plan, source Step, plan hash, candidate hash and evidence digest
 * verified result        the exact candidate text plus verification identity
 * ```
 *
 * The recheck happens here, immediately before the decision, and nowhere earlier: a freshness check
 * taken before the last verification action would be a claim about a workspace that may already have
 * moved.
 */
async function finalizePassed(
  dependencies: CompletionVerificationContext,
  observation: CompletionGateObservation,
  plan: VerificationPlan,
  evidence: readonly VerificationEvidence[],
  evaluation: ReturnType<typeof evaluateVerification>,
  candidateHash: string,
): Promise<CompletionVerificationOutcome> {
  const run = dependencies.run;
  const continuation = dependencies.continuation;
  const workspaceFreshness = await recheckWorkspaceFreshness(dependencies, plan, evidence);
  observation.workspaceFreshness = workspaceFreshness;
  const gitFreshness = await recheckGitFreshness(dependencies, plan, evidence);
  observation.gitFreshness = gitFreshness;

  const authority = evaluateCompletionAuthority({
    run,
    plan,
    continuation,
    verificationStatus: evaluation.status,
    candidateHash,
    workspaceFreshness,
    gitFreshness,
    cancellationRequested: false,
  });
  if (authority.kind !== "COMPLETE") {
    // ```text
    // DEFER — nothing is wrong with the candidate, and nothing may be accepted either
    // ```
    //
    // A freshness verdict that cannot be *proven* leaves the Run on its durable boundary rather than
    // failing it. The candidate was never refused: the evidence simply does not yet establish that
    // the world it describes is still the world the Run is in. Reported as a retryable completion
    // ERROR, which is exactly the state the Run already holds.
    return errorOutcome(`COMPLETION_DEFERRED_${authority.reason}`);
  }
  if (plan.candidateHash === undefined) return errorOutcome("CANDIDATE_HASH_MISSING");

  const workspaceCheck = plan.checks.find((check) => check.spec.kind === "WORKSPACE");
  const workspaceHash = workspaceFreshnessHash(evidence, workspaceCheck);
  if (workspaceHash === undefined) return errorOutcome("WORKSPACE_FRESHNESS_UNPROVABLE");
  const evidenceDigest = computeVerificationEvidenceDigest(plan, evidence);
  const seal = createVerificationCompletionSeal({
    runId: run.id,
    planId: plan.id,
    sourceStepId: plan.sourceStepId,
    planHash: plan.planHash,
    candidateHash,
    evidenceDigest,
    workspaceFreshnessHash: workspaceHash,
  });
  const finalResult = createVerifiedRunFinalResult({
    run,
    plan,
    continuation,
    candidateHash,
    seal,
    counts: {
      total: plan.checks.length,
      passed: plan.checks.filter((check) => check.status === "PASSED").length,
      skipped: plan.checks.filter((check) => check.status === "SKIPPED").length,
      advisoryWarnings: evaluation.warnings.length,
    },
  });
  observation.seal = seal;
  observation.verifiedFinalResult = finalResult;
  return { kind: "ACCEPT", finalResult };
}

/** The workspace freshness verdict, re-derived from a fresh inspection. */
async function recheckWorkspaceFreshness(
  dependencies: CompletionVerificationContext,
  plan: VerificationPlan,
  evidence: readonly VerificationEvidence[],
): Promise<CompletionFreshness> {
  const workspaceCheck = plan.checks.find((check) => check.spec.kind === "WORKSPACE");
  if (workspaceCheck === undefined) return "FRESH";
  if (dependencies.workspace === undefined) return "UNPROVABLE";
  const prior = evidence.find(
    (item) => item.checkId === workspaceCheck.id && item.kind === "WORKSPACE",
  );
  const expectedHash = stringValue(objectDetails(prior?.details)?.workspaceFreshnessHash);
  const facts = await dependencies.workspace.inspect({
    workspace: dependencies.run.workspace,
    changedFiles: dependencies.state.changedFiles,
    signal: dependencies.signal,
  });
  const current = verifyWorkspaceInspection({
    changedFiles: dependencies.state.changedFiles,
    facts,
  });
  if (current.status !== "PASSED") return "STALE";
  if (expectedHash === undefined || current.workspaceFreshnessHash === undefined)
    return "UNPROVABLE";
  return current.workspaceFreshnessHash === expectedHash ? "FRESH" : "STALE";
}

/** The Git freshness verdict, re-derived from a fresh status and diff review. */
async function recheckGitFreshness(
  dependencies: CompletionVerificationContext,
  plan: VerificationPlan,
  evidence: readonly VerificationEvidence[],
): Promise<CompletionGitFreshness> {
  const gitCheck = plan.checks.find((check) => check.spec.kind === "GIT");
  if (gitCheck === undefined || gitCheck.status === "SKIPPED") return "SKIPPED";
  const git = dependencies.git;
  if (git === undefined) return "UNPROVABLE";
  const prior = evidence.find((item) => item.checkId === gitCheck.id && item.kind === "GIT");
  const status = await git.status({
    workspace: dependencies.run.workspace,
    signal: dependencies.signal,
  });
  const diffs = await collectGitDiffs(
    git,
    dependencies.run,
    dependencies.state.changedFiles,
    status,
    dependencies.signal,
  );
  const current = reviewGitChangeset({
    changedFiles: dependencies.state.changedFiles,
    requirement: gitCheck.requirement,
    status,
    diffs,
  });
  const priorDetails = objectDetails(prior?.details);
  const currentComparable = {
    attributedPaths: current.attributedPaths,
    unattributedDirtyPaths: current.unattributedDirtyPaths,
    unmergedPaths: current.unmergedPaths,
    diffHashes: current.diffHashes,
    noNetDiffPaths: current.noNetDiffPaths,
    truncated: current.truncated,
    reviewComplete: current.reviewComplete,
  };
  const priorComparable = {
    attributedPaths: arrayValue(priorDetails?.attributedPaths),
    unattributedDirtyPaths: arrayValue(priorDetails?.unattributedDirtyPaths),
    unmergedPaths: arrayValue(priorDetails?.unmergedPaths),
    diffHashes: objectValue(priorDetails?.diffHashes),
    noNetDiffPaths: arrayValue(priorDetails?.noNetDiffPaths),
    truncated: priorDetails?.truncated,
    reviewComplete: priorDetails?.reviewComplete,
  };
  if (current.status !== "PASSED") return "STALE";
  return JSON.stringify(currentComparable) === JSON.stringify(priorComparable) ? "FRESH" : "STALE";
}

function workspaceFreshnessHash(
  evidence: readonly VerificationEvidence[],
  workspaceCheck: VerificationCheck | undefined,
): string | undefined {
  const workspaceEvidence = evidence.find(
    (item) => item.kind === "WORKSPACE" && item.checkId === workspaceCheck?.id,
  );
  const hash = stringValue(objectDetails(workspaceEvidence?.details)?.workspaceFreshnessHash);
  if (hash !== undefined) return hash;
  return workspaceCheck === undefined ? computeWorkspaceFreshnessHash([]) : undefined;
}

/* ------------------------------------------------------ repair / reject */

/**
 * Decide between a repair and a terminal rejection.
 *
 * ```text
 * verification FAILED
 *        ↓
 * the host's repair policy and the Run's own plan count
 *        ↓
 * REPAIR keeps the Run alive with a new candidate; REJECT fails it
 * ```
 *
 * The repair cycle comes from `repairCycleForPlanCount`, which counts the plans this Run has already
 * been through — the one authority for "how many attempts is this". A gate that compared a cycle
 * against a number of its own would be a second repair policy.
 */
async function repairOrReject(
  dependencies: CompletionVerificationContext,
  observation: CompletionGateObservation,
  plan: VerificationPlan,
  evidence: readonly VerificationEvidence[],
  evaluation: ReturnType<typeof evaluateVerification>,
): Promise<CompletionVerificationOutcome> {
  const count = await planCount(dependencies);
  const repairCycle = repairCycleForPlanCount(count);
  observation.repairCycle = repairCycle;
  const policy = dependencies.repairPolicy ?? createVerificationRepairPolicy();
  if (!policy.canRepair({ ...evaluation, repairCycle })) {
    return {
      kind: "REJECT",
      decision: rejectDecision(
        evaluation.status,
        evaluation.failedCheckIds,
        evaluation.errorCheckIds,
      ),
    };
  }
  // The evidence the repair boundary points at is the *durable* evidence of the failed checks, read
  // from the verification execution. The frozen repair metadata is a host description; it is never
  // the authority for which checks failed or which evidence describes them.
  const evidenceIds = evidence
    .filter((item) => evaluation.failedCheckIds.includes(item.checkId))
    .map((item) => item.id);
  observation.evidenceIds = evidenceIds;
  observation.failedCheckIds = evaluation.failedCheckIds;
  observation.errorCheckIds = evaluation.errorCheckIds;
  return {
    kind: "REPAIR",
    decision: {
      kind: "REPAIR",
      repair: {
        repairRef: plan.id,
        cycle: repairCycle,
        reason: "Verification did not pass and the repair policy allows another attempt.",
        metadata: {
          failedPlanId: plan.id,
          sourceStepId: plan.sourceStepId,
        },
      },
    },
  };
}

async function planCount(dependencies: CompletionVerificationContext): Promise<number> {
  if (dependencies.planCount !== undefined) return dependencies.planCount(dependencies.run.id);
  const recovery = recoveryStore(dependencies);
  if (recovery?.countPlans !== undefined) return recovery.countPlans(dependencies.run.id);
  return 1;
}

/**
 * The terminal rejection of a candidate.
 *
 * `VERIFICATION_FAILED` is the sanitized error Phase 11D froze: a Run that could not establish a
 * trustworthy completion boundary fails with a code that names the subsystem and never quotes a
 * command, an output or a path.
 */
function rejectDecision(
  status: string,
  failedCheckIds: readonly VerificationCheckId[],
  errorCheckIds: readonly VerificationCheckId[],
): CompletionGateDecision {
  const error: AgentError = {
    code: "VERIFICATION_FAILED",
    message: "Verification did not establish a trustworthy completion boundary.",
    retryable: false,
    phase: "VERIFICATION",
  };
  void status;
  void failedCheckIds;
  void errorCheckIds;
  return { kind: "REJECT", error };
}

/* ---------------------------------------------------------------- errors */

/**
 * A completion the gate could not decide.
 *
 * Every one of these is `retryable`, and that is the point: none is a verdict about the candidate, so
 * the Run stays on its durable `AWAITING_VERIFICATION` boundary and a later explicit recovery may
 * evaluate it again. Returning `REJECT` would durably record a failed verification nobody performed.
 */
function errorOutcome(reason: string): CompletionVerificationOutcome {
  const error: AgentError = {
    code: "INTERNAL_ERROR",
    message: "Completion evaluation could not reach a decision.",
    retryable: false,
    phase: "VERIFICATION",
  };
  return {
    kind: "ERROR",
    decision: {
      kind: "ERROR",
      error: { ...error, code: reason as AgentError["code"] },
      retryable: true,
    },
  };
}

/* --------------------------------------------------------------- helpers */

async function settleInterruptedChecks(
  dependencies: CompletionVerificationContext,
  plan: VerificationPlan,
): Promise<void> {
  const recovery = recoveryStore(dependencies);
  if (recovery === undefined) return;
  const evidenceId = dependencies.evidenceIdFactory ?? createVerificationEvidenceId;
  for (const check of plan.checks.filter((item) => item.status === "RUNNING")) {
    const committed = await recovery.settleCheck({
      runId: dependencies.run.id,
      sessionId: dependencies.run.sessionId,
      check: {
        ...check,
        status: "ERROR" as const,
        finishedAt: dependencies.clock.now(),
      },
      evidence: [
        VerificationEvidenceSchema.parse({
          id: evidenceId(),
          planId: plan.id,
          checkId: check.id,
          kind: check.spec.kind === "PROJECT" ? "COMMAND" : check.spec.kind,
          summary: "Verification was interrupted before recovery and was not replayed.",
          details: { errorCode: "VERIFICATION_INTERRUPTED" },
          capturedAt: dependencies.clock.now(),
        }),
      ],
    });
    dependencies.notifyCommitted(committed.events as readonly DurableAgentEvent[]);
  }
}

async function loadPlan(
  dependencies: CompletionVerificationContext,
): Promise<VerificationPlan | null> {
  const planId = dependencies.continuation.verificationPlanId;
  const plan = await dependencies.persistence.loadVerificationPlan(dependencies.run.id, planId);
  if (plan === null || plan.id !== planId || plan.runId !== dependencies.run.id) return null;
  return plan;
}

function recoveryStore(
  dependencies: CompletionVerificationContext,
): VerificationExecutionRecoveryStorePort | undefined {
  if (dependencies.executionRecovery !== undefined) return dependencies.executionRecovery;
  const candidate = dependencies.executionStore;
  if (candidate !== undefined && "getPlanExecutionSnapshot" in candidate) {
    return candidate as VerificationExecutionRecoveryStorePort;
  }
  return undefined;
}

function taskErrorEvidence(
  dependencies: CompletionVerificationContext,
  planId: VerificationPlan["id"],
  checkId: VerificationCheck["id"],
  errorCode: string,
  reviewInputHash?: string,
): VerificationEvidence {
  return VerificationEvidenceSchema.parse({
    id: (dependencies.evidenceIdFactory ?? createVerificationEvidenceId)(),
    planId,
    checkId,
    kind: "TASK",
    summary: "Task acceptance review errored",
    details: { errorCode, ...(reviewInputHash === undefined ? {} : { reviewInputHash }) },
    capturedAt: dependencies.clock.now(),
  });
}

function objectDetails(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arrayValue(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return objectDetails(value);
}

export type { StepResult, TaskReviewBundle, CompletionBoundaryOpening };
