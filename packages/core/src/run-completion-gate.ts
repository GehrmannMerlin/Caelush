import type {
  CompletionGate,
  CompletionGateInput,
  AgentFinalCandidateDecision,
} from "@caelush/agent";
import {
  createVerificationCheckId,
  createVerificationPlanId,
  type AgentRun,
  type AgentState,
  type VerificationCheckId,
  type VerificationPlan,
  type VerificationPlanId,
} from "@caelush/protocol";

import {
  createCompletionGateObservation,
  type CompletionGateObservation,
} from "./run-completion-observation.js";
import type { RunContinuationCheckpoint } from "./agent-continuation.js";
import { computeVerificationCandidateTextHash } from "@caelush/verification";
import type {
  CompletionBoundaryOpening,
  RunCompletionGateDependencies,
  CompletionVerificationPlannerPort,
} from "./run-completion-context.js";
import {
  runCompletionVerification,
  type CompletionVerificationOutcome,
} from "./run-completion-verification.js";

/**
 * The production coding `CompletionGate`.
 *
 * ```text
 * CompletionGate = may this final candidate become the Run's result?
 * ```
 *
 * Everything the answer depends on is behind this gate, and nothing that commits it is:
 *
 * ```text
 * it evaluates an existing candidate    it never generates one and never calls an Agent turn
 * it produces evidence                  verification checks, evidence rows, check events
 * it returns a typed decision           ACCEPT / REPAIR / REJECT / ERROR
 * it commits NO Run lifecycle           no Run status, no AgentState status, no finalResult
 * ```
 *
 * Phase 3E moved the whole coding verification workflow out of the RunController and in here. What
 * used to be eleven controller methods — driving project checks, driving the change checks, settling
 * interrupted checks, re-checking freshness, building the seal, failing the Run, starting a repair —
 * is now one gate that reports a decision, and one settlement router that acts on it. The Run Layer
 * keeps the only authority it ever had: committing a lifecycle transition.
 *
 * Like the Phase 3D Tool adapter, the gate is **run-scoped**: the frozen `CompletionGateInput`
 * deliberately knows no workspace, no Git state, no verification plan and no repair policy, so those
 * are captured from the durable Run the coordinator decided on.
 */

/** One completion evaluation: the gate plus the Core-private record of what it did. */
export interface RunCompletionGate {
  readonly gate: CompletionGate;
  readonly observation: CompletionGateObservation;
}

/**
 * The candidate boundary planner.
 *
 * A `FINAL_CANDIDATE` needs a verification plan before any completion evaluation exists, and that plan
 * needs an identity only the host can mint. This is that half of the gate, kept separate because the
 * boundary is opened *before* there is a durable plan to evaluate against: asking the full gate for a
 * plan would mean asking it to evaluate a candidate against a plan that does not exist yet.
 */
export interface RunCandidateBoundaryPlanner {
  planCandidateBoundary(candidate: AgentFinalCandidateDecision): CompletionBoundaryOpening;
}

/** The dependencies a candidate boundary needs, which is a strict subset of a gate's. */
export interface CandidateBoundaryPlanningDependencies {
  readonly run: AgentRun;
  readonly state: AgentState;
  readonly continuation: Extract<
    RunContinuationCheckpoint,
    { readonly type: "AWAITING_VERIFICATION" }
  >;
  readonly clock: { now(): import("@caelush/protocol").TimestampMs };
  readonly planner?: CompletionVerificationPlannerPort | undefined;
  readonly planIdFactory?: (() => VerificationPlanId) | undefined;
  readonly checkIdFactory?: (() => VerificationCheckId) | undefined;
}

export const CODING_COMPLETION_GATE_ID = "caelush.coding-verification-completion-gate.v1";

/**
 * Create the run-scoped completion gate.
 *
 * The caller hands it the durable facts of one completion evaluation and receives a gate that speaks
 * the frozen completion contract over the coding verification subsystem.
 */
export function createRunCompletionGate(
  dependencies: RunCompletionGateDependencies,
): RunCompletionGate {
  const observation = createCompletionGateObservation({
    effectiveMode: dependencies.mode,
    gateId: CODING_COMPLETION_GATE_ID,
  });
  return {
    observation,
    gate: {
      id: CODING_COMPLETION_GATE_ID,
      evaluate: async (input) => {
        const outcome = await evaluateCompletion(dependencies, observation, input);
        return outcome.kind === "ACCEPT"
          ? { kind: "ACCEPT", finalResult: outcome.finalResult }
          : outcome.decision;
      },
    },
  };
}

/**
 * Create the candidate boundary planner.
 *
 * It mints identities and decides which checks the Run needs — nothing more. The plan it returns is
 * committed by the Run Layer, in the same transaction as the boundary that names it.
 */
export function createRunCandidateBoundaryPlanner(
  dependencies: CandidateBoundaryPlanningDependencies,
): RunCandidateBoundaryPlanner {
  return {
    planCandidateBoundary: (candidate) => planCandidateBoundary(dependencies, candidate),
  };
}

/* ------------------------------------------------- candidate boundary */

/**
 * Create the durable verification plan one candidate boundary binds.
 *
 * ```text
 * VerificationPlanner   a pure decision: which checks does this Run need?
 * +                     the plan and check identities this host mints
 * ↓
 * VerificationPlan      PENDING checks, a plan hash, and the candidate's own hash
 * ```
 *
 * The planner stays pure and mints nothing: identity is a host fact, and a pure planner that produced
 * a `VerificationPlanId` would be a second identity authority over durable state.
 *
 * `candidateHash` binds the plan to the exact text it will verify. Without it no completion can be
 * established at all, which is why the completion authority refuses a plan that carries none.
 *
 * A host that composed no planner has no verification plan, and that is a configuration failure
 * rather than a candidate that failed: a Run must never reach `VERIFYING` without a plan to verify
 * against.
 */
function planCandidateBoundary(
  dependencies: CandidateBoundaryPlanningDependencies,
  candidate: AgentFinalCandidateDecision,
): CompletionBoundaryOpening {
  const planner: CompletionVerificationPlannerPort | undefined = dependencies.planner;
  if (planner === undefined) {
    throw new CompletionGateInfrastructureError(
      "The verification planner is not configured, so no completion boundary can be opened.",
    );
  }
  const now = dependencies.clock.now();
  const draft = planner.plan({
    runId: dependencies.run.id,
    sourceStepId: dependencies.continuation.sourceStepId,
    goal: dependencies.run.goal,
    workspace: dependencies.run.workspace,
    changedFiles: dependencies.state.changedFiles,
  });
  const planId = dependencies.planIdFactory?.() ?? createVerificationPlanId();
  const checkIdFactory: () => VerificationCheckId =
    dependencies.checkIdFactory ?? createVerificationCheckId;
  const plan: VerificationPlan = {
    id: planId,
    runId: dependencies.run.id,
    sourceStepId: dependencies.continuation.sourceStepId,
    plannerVersion: draft.plannerVersion,
    planHash: draft.planHash,
    candidateHash: computeVerificationCandidateTextHash(candidate.candidateText),
    checks: draft.checks.map((check) => ({
      ...check,
      id: checkIdFactory(),
      planId,
      status: "PENDING" as const,
      createdAt: now,
    })),
    createdAt: now,
  };
  return { plan };
}

/* ------------------------------------------------------------ evaluation */

async function evaluateCompletion(
  dependencies: RunCompletionGateDependencies,
  observation: CompletionGateObservation,
  input: CompletionGateInput,
): Promise<CompletionVerificationOutcome> {
  // ```text
  // a cancelled or expired evaluation belongs to the termination authority
  // ```
  //
  // The Run Layer resolves termination before *and* after this call, and it wins. A gate that
  // returned REJECT here would turn a cancellation or a deadline into a failed Run, which the frozen
  // lifecycle forbids.
  if (input.signal.aborted) return suspended("COMPLETION_INTERRUPTED");

  assertInputMatchesRun(dependencies, input);

  const plan = await loadPlan(dependencies);
  if (plan === null) {
    // The Run is bound to a plan that does not exist. That is a corrupt ledger rather than a candidate
    // that failed verification, and it must never be read as an acceptable completion.
    return suspended("VERIFICATION_PLAN_MISSING");
  }
  const candidateHash = computeVerificationCandidateTextHash(input.candidate.candidateText);
  if (plan.candidateHash !== candidateHash) {
    return suspended("VERIFICATION_CANDIDATE_MISMATCH");
  }
  observation.plan = plan;
  return runCompletionVerification(dependencies, observation, plan, candidateHash);
}

/** Load the exact plan the continuation names, and refuse a plan that is not this Run's. */
async function loadPlan(
  dependencies: RunCompletionGateDependencies,
): Promise<VerificationPlan | null> {
  const planId = dependencies.continuation.verificationPlanId;
  const plan = await dependencies.persistence.loadVerificationPlan(dependencies.run.id, planId);
  if (plan === null) return null;
  if (plan.id !== planId || plan.runId !== dependencies.run.id) return null;
  if (plan.sourceStepId !== dependencies.continuation.sourceStepId) return null;
  return plan;
}

/* ----------------------------------------------- frozen input validation */

/**
 * Verify the frozen request against the Run's durable state.
 *
 * The frozen `CompletionGateInput` arrives with an identity, a source Step and a candidate, and all
 * three must be the durable Run's own. A gate that evaluated a candidate belonging to another Step,
 * another Session or another Run would produce evidence nobody could attribute — and would verify
 * text the Run never produced.
 *
 * A mismatch is refused loudly rather than answered with a decision. The candidate did not fail
 * verification; the request was not this Run's to evaluate, and reporting it as a refused candidate
 * would durably record a verdict nobody reached.
 */
function assertInputMatchesRun(
  dependencies: RunCompletionGateDependencies,
  input: CompletionGateInput,
): void {
  if (
    input.identity.runId !== dependencies.run.id ||
    input.identity.sessionId !== dependencies.run.sessionId ||
    input.identity.goal !== dependencies.run.goal
  ) {
    throw new CompletionGateIdentityError(
      "A completion evaluation arrived for a Run or Session this gate does not belong to.",
    );
  }
  if (input.sourceStepId !== dependencies.continuation.sourceStepId) {
    throw new CompletionGateIdentityError(
      "A completion evaluation named a source Step the Run's continuation does not.",
    );
  }
  // The candidate must be the one the continuation recorded. Its model-turn call is the identity that
  // distinguishes one candidate from another within a Run, and its text is what will be verified: a
  // gate that accepted a candidate the Run never produced would verify a string nobody asked about and
  // seal it as this Run's own answer.
  if (
    input.candidate.candidateText !== dependencies.continuation.finalDecision.candidateText ||
    input.candidate.modelTurn.callId !== dependencies.continuation.finalDecision.modelTurn.callId
  ) {
    throw new CompletionGateIdentityError(
      "A completion evaluation carried a candidate the Run's continuation does not.",
    );
  }
}

/* ------------------------------------------------------------- failures */

/** The gate's own identity refusal: a lifecycle violation, not a verification verdict. */
export class CompletionGateIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionGateIdentityError";
  }
}

/** The gate could not run at all: a configuration or ledger failure, not a verdict. */
export class CompletionGateInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionGateInfrastructureError";
  }
}

/**
 * A completion the gate could not decide.
 *
 * ```text
 * ERROR + retryable: true
 * ```
 *
 * Every one of these leaves the Run exactly where it is: `VERIFYING`, holding its durable
 * `AWAITING_VERIFICATION` boundary with its plan and its evidence intact. A later explicit recovery
 * evaluates the same candidate against the same plan, reusing whatever verification work is already
 * durable.
 *
 * `REJECT` would be the wrong answer and a dangerous one: it fails the Run with
 * `VERIFICATION_FAILED`, which is a claim that the candidate was *refused*. None of these outcomes is
 * a verdict about the candidate at all — the gate could not reach one — and recording a refusal that
 * never happened is exactly the fabrication the frozen contract's `ERROR` arm exists to prevent.
 *
 * The `retryable` flag is what stops a drive loop from spinning: the Run Layer ends its call on a
 * retryable completion ERROR rather than asking the gate again.
 */
function suspended(reason: string): CompletionVerificationOutcome {
  return {
    kind: "ERROR",
    decision: {
      kind: "ERROR",
      error: {
        code: completionErrorCode(reason),
        message: "Completion evaluation could not reach a decision.",
        retryable: false,
        phase: "VERIFICATION",
      },
      retryable: true,
    },
  };
}

/**
 * The sanitized error code a suspended completion carries.
 *
 * The frozen `AgentError.code` is a closed vocabulary, so an internal reason is projected onto
 * `INTERNAL_ERROR` rather than invented. The reason itself never crosses: a durable error is public
 * data, and a ledger or configuration failure may quote a path.
 */
function completionErrorCode(reason: string): "INTERNAL_ERROR" | "VERIFICATION_FAILED" {
  void reason;
  return "INTERNAL_ERROR";
}

export { suspended };
