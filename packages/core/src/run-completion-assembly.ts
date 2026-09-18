import type { AgentFinalCandidateDecision, CompletionGate, RunExecutionMode } from "@caelush/agent";
import type { AgentRun, AgentState } from "@caelush/protocol";
import { compileVerificationRepairContext } from "@caelush/verification";

import type { RunContinuationCheckpoint } from "./agent-continuation.js";
import type { RunBudgetPort } from "./budget-ports.js";

import type { DurableAgentEvent, RunExecutionSnapshot } from "./run-execution-store.js";
import type {
  CompletionBoundaryOpening,
  CompletionPersistencePort,
  CompletionTaskReviewerPort,
  RunCompletionGateDependencies,
} from "./run-completion-context.js";
import {
  CODING_COMPLETION_GATE_ID,
  createRunCandidateBoundaryPlanner,
  createRunCompletionGate,
} from "./run-completion-gate.js";
import type { CompletionGateObservation } from "./run-completion-observation.js";
import { RunControllerInfrastructureError } from "./run-controller-errors.js";
import type { LLMTokenEstimator } from "./llm-token-estimator.js";
import {
  TaskAcceptanceReviewer,
  type VerificationModelClient,
} from "./task-acceptance-reviewer.js";

/**
 * The completion assembly boundary.
 *
 * ```text
 * RunController      load · lock · termination · coordinator · driver · commit · notify
 *        ↓  one port
 * RunCompletionAssembly
 *        ├── openEvaluation()          the run-scoped gate for one EVALUATE_COMPLETION
 *        ├── planCandidateBoundary()   the plan a FINAL_CANDIDATE boundary binds
 *        └── compileRepairContext()    the context the repair Reason reasons from
 * ```
 *
 * Phase 3E moved the coding verification *workflow* behind the frozen `CompletionGate`. The Run Layer
 * still assembled that gate itself: it read eighteen verification-specific dependency fields off its
 * own dependency object, constructed the `TaskAcceptanceReviewer`, picked the project resolver, wired
 * the workspace/Git/execution ports and reached into the verification execution store to compile a
 * repair context. Composing a completion is not a lifecycle responsibility, and a Run Layer that has
 * to know which concrete checker sits behind which field is still the subsystem's integrator.
 *
 * This port is the seam. The Run Layer names *one* collaborator and asks it three questions; the
 * answers are assembled — reviewer included — on the other side, by a module whose whole job is that
 * assembly. Nothing here commits a Run status, opens a boundary or publishes an event on its own: the
 * notifier and the persistence port arrive from the Run Layer per evaluation, because the Run Layer is
 * the only object allowed to write one.
 *
 * `RunCompletionGateDependencies` remains the frozen shape the gate itself consumes. It is not widened
 * and not replaced: the assembly's host-fact group is defined as that type minus everything that
 * belongs to one evaluation, so the two can never drift apart.
 */

/**
 * The host facts a coding completion assembly is built from.
 *
 * Defined as a projection of the gate's own dependency type rather than as a parallel declaration, so
 * a field added to the gate cannot be forgotten here — it either arrives per evaluation (and is named
 * in the omission list) or it is a host fact this group must carry.
 */
export type CodingCompletionGateHostFacts = Omit<
  RunCompletionGateDependencies,
  "run" | "state" | "continuation" | "mode" | "signal" | "persistence" | "notifyCommitted"
>;

/**
 * Everything one coding completion assembly is composed from.
 *
 * `modelTurns`, `budget` and `tokenEstimator` are here rather than in the gate's own group because
 * they are what the *reviewer* is built from: a host that composes one model-turn authority gets the
 * whole review, and never composes a second reviewer of its own.
 */
export interface CodingCompletionAssemblyDependencies extends CodingCompletionGateHostFacts {
  readonly modelTurns?: VerificationModelClient | undefined;
  readonly budget?: RunBudgetPort | undefined;
  readonly tokenEstimator?: LLMTokenEstimator | undefined;
}

/** Everything one completion *evaluation* supplies, which is a strict subset of a Run's facts. */
export interface RunCompletionEvaluationInput {
  /** The durable Run the coordinator decided this evaluation from. */
  readonly snapshot: RunExecutionSnapshot;
  /** How this evaluation was entered. It never changes what a verified completion means. */
  readonly mode: RunExecutionMode;
  /** The Run's own cancellation signal, forwarded unchanged into every verification action. */
  readonly signal: AbortSignal;
  /** Core-private completion persistence. The gate reads plans through it and writes none. */
  readonly persistence: CompletionPersistencePort;
  /** The Run Layer's own notifier: durable first, published second. */
  readonly notifyCommitted: (events: readonly DurableAgentEvent[]) => void;
}

/**
 * One completion evaluation.
 *
 * The gate and the observation are produced together and belong together: the settlement that acts on
 * the decision reads the observation to find the plan, the seal and the verified result the decision
 * alone cannot carry. A gate whose observation came from a different evaluation would let a commit
 * bind a seal to the wrong candidate, so the two are only ever handed out as this pair.
 */
export interface RunCompletionEvaluation {
  readonly gate: CompletionGate;
  readonly observation: CompletionGateObservation;
  readonly dependencies: RunCompletionGateDependencies;
}

/** The durable facts one candidate boundary is planned from. */
export interface RunCandidateBoundaryInput {
  readonly run: AgentRun;
  readonly state: AgentState;
  readonly continuation: Extract<
    RunContinuationCheckpoint,
    { readonly type: "AWAITING_VERIFICATION" }
  >;
  readonly candidate: AgentFinalCandidateDecision;
}

/** The repair context a Run parked on `WAITING_VERIFICATION_REPAIR` hands its next Reason. */
export interface RunRepairContextInput {
  readonly snapshot: RunExecutionSnapshot;
}

/**
 * One host's completion subsystem, behind three questions.
 *
 * A host that composes none of it gets `undefined` from the resolver and the Run Layer behaves exactly
 * as it did: an Agent effect that cannot evaluate completion waits on its durable boundary, and a
 * candidate that cannot be planned fails loudly rather than completing unverified.
 */
export interface RunCompletionAssembly {
  /** The gate identity every decision from this assembly is attributed to. */
  readonly gateId: string;
  openEvaluation(input: RunCompletionEvaluationInput): RunCompletionEvaluation | undefined;
  planCandidateBoundary(input: RunCandidateBoundaryInput): CompletionBoundaryOpening;
  compileRepairContext(
    input: RunRepairContextInput,
  ): Promise<{ readonly text: string } | undefined>;
}

/**
 * Create the coding completion assembly.
 *
 * ```text
 * planner · id factories · runner · profile provider · workspace · git · security
 * sanitizer · resolver registry · execution store · reviewer · repair policy
 *        ↓
 * one gate, one boundary planner, one repair-context compiler
 * ```
 *
 * The concrete coding verification composition lives here and nowhere else. It is host-scoped: every
 * fact above is a property of the deployment rather than of one evaluation, so the reviewer is built
 * once and still executes each review against the Run it is handed.
 */
export function createCodingCompletionAssembly(
  dependencies: CodingCompletionAssemblyDependencies,
): RunCompletionAssembly {
  const reviewer = resolveReviewer(dependencies);
  const recovery = resolveRecoveryStore(dependencies);

  return {
    gateId: CODING_COMPLETION_GATE_ID,

    openEvaluation(input) {
      const state = input.snapshot.state;
      const continuation = input.snapshot.continuation;
      if (state === undefined || continuation?.type !== "AWAITING_VERIFICATION") return undefined;
      const gateDependencies: RunCompletionGateDependencies = {
        run: input.snapshot.run,
        state,
        continuation,
        mode: input.mode,
        signal: input.signal,
        clock: dependencies.clock,
        persistence: input.persistence,
        configResolver: dependencies.configResolver,
        notifyCommitted: input.notifyCommitted,
        ...(dependencies.planner === undefined ? {} : { planner: dependencies.planner }),
        ...(dependencies.planIdFactory === undefined
          ? {}
          : { planIdFactory: dependencies.planIdFactory }),
        ...(dependencies.checkIdFactory === undefined
          ? {}
          : { checkIdFactory: dependencies.checkIdFactory }),
        ...(dependencies.evidenceIdFactory === undefined
          ? {}
          : { evidenceIdFactory: dependencies.evidenceIdFactory }),
        ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
        ...(dependencies.profileProvider === undefined
          ? {}
          : { profileProvider: dependencies.profileProvider }),
        ...(dependencies.execution === undefined ? {} : { execution: dependencies.execution }),
        ...(dependencies.executionStore === undefined
          ? {}
          : { executionStore: dependencies.executionStore }),
        ...(dependencies.executionRecovery === undefined
          ? {}
          : { executionRecovery: dependencies.executionRecovery }),
        ...(dependencies.workspace === undefined ? {} : { workspace: dependencies.workspace }),
        ...(dependencies.git === undefined ? {} : { git: dependencies.git }),
        ...(dependencies.security === undefined ? {} : { security: dependencies.security }),
        ...(dependencies.evidenceSanitizer === undefined
          ? {}
          : { evidenceSanitizer: dependencies.evidenceSanitizer }),
        ...(dependencies.resolverRegistry === undefined
          ? {}
          : { resolverRegistry: dependencies.resolverRegistry }),
        ...(reviewer === undefined ? {} : { reviewer }),
        ...(dependencies.repairPolicy === undefined
          ? {}
          : { repairPolicy: dependencies.repairPolicy }),
        ...(dependencies.planCount === undefined ? {} : { planCount: dependencies.planCount }),
      };
      const completion = createRunCompletionGate(gateDependencies);
      return {
        gate: completion.gate,
        observation: completion.observation,
        dependencies: gateDependencies,
      };
    },

    planCandidateBoundary(input) {
      return createRunCandidateBoundaryPlanner({
        run: input.run,
        state: input.state,
        continuation: input.continuation,
        clock: dependencies.clock,
        ...(dependencies.planner === undefined ? {} : { planner: dependencies.planner }),
        ...(dependencies.planIdFactory === undefined
          ? {}
          : { planIdFactory: dependencies.planIdFactory }),
        ...(dependencies.checkIdFactory === undefined
          ? {}
          : { checkIdFactory: dependencies.checkIdFactory }),
      }).planCandidateBoundary(input.candidate);
    },

    async compileRepairContext(input) {
      const continuation =
        input.snapshot.continuation?.type === "WAITING_VERIFICATION_REPAIR"
          ? input.snapshot.continuation
          : undefined;
      if (continuation === undefined) return undefined;
      // A Run parked on a repair *must* be able to compile the context its next Reason reads. Failing
      // closed here rather than reasoning from an empty context is the same refusal the Run Layer made
      // before this assembly existed, and it is deliberately not softened into an absent context.
      if (recovery === undefined) {
        throw new RunControllerInfrastructureError(
          "Verification repair recovery is not configured.",
        );
      }
      const failed = await recovery.getPlanExecutionSnapshot(continuation.failedPlanId);
      if (failed === null) {
        throw new RunControllerInfrastructureError("Verification repair plan is unavailable.");
      }
      const failedCheckIds = new Set(continuation.failedCheckIds);
      const repairContext = compileVerificationRepairContext({
        originalGoal: input.snapshot.run.goal,
        failedPlan: failed.plan,
        failedChecks: failed.plan.checks.filter((check) => failedCheckIds.has(check.id)),
        evidence: failed.evidence.filter((item) => continuation.evidenceIds.includes(item.id)),
        changedFiles: input.snapshot.state?.changedFiles ?? [],
        repairCycle: continuation.repairCycle,
      });
      return { text: repairContext.text };
    },
  };
}

/**
 * The reviewer one evaluation may ask for a task acceptance verdict.
 *
 * A host that composed a reviewer keeps it. Otherwise the reviewer is built from the model-turn
 * authority and the budget ledger the host already supplied for ordinary Runs — which is what keeps
 * "one AI subsystem" true: the review runs through the same gateway, and there is deliberately no
 * second reviewer for a host to compose.
 */
function resolveReviewer(
  dependencies: CodingCompletionAssemblyDependencies,
): CompletionTaskReviewerPort | undefined {
  if (dependencies.reviewer !== undefined) return dependencies.reviewer;
  if (dependencies.modelTurns === undefined || dependencies.budget === undefined) return undefined;
  return new TaskAcceptanceReviewer({
    modelTurns: dependencies.modelTurns,
    budget: dependencies.budget,
    clock: dependencies.clock,
    ...(dependencies.tokenEstimator === undefined
      ? {}
      : { tokenEstimator: dependencies.tokenEstimator }),
  });
}

/**
 * The verification execution recovery store a repair context is read from.
 *
 * A host may name it explicitly, and otherwise the execution store answers when it implements the
 * recovery read. That is the compatibility bridge from an older composition that supplied one store
 * for both roles; it is resolved once, here, rather than re-derived at every repair.
 */
function resolveRecoveryStore(
  dependencies: CodingCompletionAssemblyDependencies,
): RunCompletionGateDependencies["executionRecovery"] {
  if (dependencies.executionRecovery !== undefined) return dependencies.executionRecovery;
  const candidate: RunCompletionGateDependencies["executionStore"] = dependencies.executionStore;
  if (candidate !== undefined && "getPlanExecutionSnapshot" in candidate) {
    return candidate as NonNullable<RunCompletionGateDependencies["executionRecovery"]>;
  }
  return undefined;
}
