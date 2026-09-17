import type {
  AgentRun,
  AgentState,
  VerificationCheckId,
  VerificationPlanId,
} from "@caelush/protocol";
import type {
  VerificationCommandExecutionPort,
  VerificationCommandSecurityPort,
  VerificationEvidenceSanitizer,
  VerificationExecutionRecoveryStorePort,
  VerificationExecutionStorePort,
  VerificationGitPort,
  VerificationProjectProfile,
  VerificationRepairPolicy,
  WorkspaceVerificationPort,
  TaskAcceptanceReview,
  TaskReviewBundle,
} from "@caelush/verification";
import type { VerificationEvidence } from "@caelush/protocol";

import type { RunContinuationCheckpoint } from "./agent-continuation.js";
import type { RunCompletionPersistencePort } from "./run-completion-store.js";
import type { RunExecutionConfig } from "./run-controller-ports.js";

/**
 * What the coding completion gate is assembled from.
 *
 * ```text
 * frozen CompletionGateInput   identity, source Step, candidate, mode, signal — and nothing else
 * +                            these captured host facts
 * ↓
 * a gate that can actually evaluate a candidate
 * ```
 *
 * The frozen contract deliberately knows no workspace, no Git state, no verification plan, no
 * changed-file list, no repair policy and no verification store. Every one of those is a fact about
 * *this host and this Run*, so they are captured here — at the boundary that already holds them —
 * exactly as the Phase 3D Tool adapter captures its own.
 *
 * It lives in its own module because both halves of the gate need it: the gate itself validates the
 * frozen request against these facts, and the verification body runs the checks with them. A shared
 * module is what keeps that one capture rather than two.
 */

/** The reviewer one completion evaluation may ask for a task acceptance verdict. */
export interface CompletionTaskReviewerPort {
  review(input: {
    readonly run: AgentRun;
    readonly candidateText: string;
    readonly bundle: TaskReviewBundle;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly status: "PASSED" | "FAILED" | "ERROR";
    readonly review?: TaskAcceptanceReview;
    readonly reviewInputHash: string;
    readonly errorCode?: string;
  }>;
}

/** The verification planner, reduced to the one call a candidate boundary makes. */
export interface CompletionVerificationPlannerPort {
  plan(
    input: import("@caelush/protocol").VerificationPlanningInput,
  ): import("@caelush/protocol").VerificationPlanDraft;
}

/** Where a plan is loaded from and where a verified completion is validated against. */
export type CompletionPersistencePort = RunCompletionPersistencePort;

/** Everything the coding completion gate is assembled from. */
export interface RunCompletionGateDependencies {
  /** The Run this gate evaluates completion for. */
  readonly run: AgentRun;
  readonly state: AgentState;
  readonly continuation: Extract<
    RunContinuationCheckpoint,
    { readonly type: "AWAITING_VERIFICATION" }
  >;
  /** How this evaluation was entered. It never changes what a verified completion means. */
  readonly mode: "EXECUTE" | "RECOVER";
  /** The Run's own cancellation signal, forwarded unchanged into every verification action. */
  readonly signal: AbortSignal;
  readonly clock: { now(): import("@caelush/protocol").TimestampMs };

  /** Where a plan is loaded from, and where the verified final result is validated against. */
  readonly persistence: CompletionPersistencePort;

  readonly planner?: CompletionVerificationPlannerPort | undefined;
  readonly planIdFactory?: (() => VerificationPlanId) | undefined;
  readonly checkIdFactory?: (() => VerificationCheckId) | undefined;
  readonly evidenceIdFactory?: (() => VerificationEvidence["id"]) | undefined;

  /** The project-check runner. Its shape is the Core-owned port, not the implementation. */
  readonly runner?:
    | {
        run(
          input: import("@caelush/verification").VerificationRunnerInput,
        ): Promise<import("@caelush/verification").VerificationRunnerResult>;
      }
    | undefined;
  readonly profileProvider?:
    | {
        getFreshProfile(
          run: AgentRun,
          config: RunExecutionConfig,
        ): Promise<VerificationProjectProfile>;
      }
    | undefined;
  readonly configResolver: { resolve(run: AgentRun): Promise<RunExecutionConfig> };
  readonly execution?: VerificationCommandExecutionPort | undefined;
  readonly executionStore?: VerificationExecutionStorePort | undefined;
  readonly executionRecovery?: VerificationExecutionRecoveryStorePort | undefined;
  readonly workspace?: WorkspaceVerificationPort | undefined;
  readonly git?: VerificationGitPort | undefined;
  readonly security?: VerificationCommandSecurityPort | undefined;
  readonly evidenceSanitizer?: VerificationEvidenceSanitizer | undefined;
  readonly resolverRegistry?:
    import("@caelush/verification").ProjectCheckResolverRegistry | undefined;
  readonly reviewer?: CompletionTaskReviewerPort | undefined;
  readonly repairPolicy?: VerificationRepairPolicy | undefined;
  readonly planCount?: ((runId: AgentRun["id"]) => Promise<number>) | undefined;
  /**
   * Publish one durable verification event.
   *
   * The gate owns verification's *evidence*, and the events that describe it are durable before they
   * are published. It is handed the Run Layer's own notifier rather than a bus, so the rule — persist,
   * then notify — is the one the ledger already uses everywhere else.
   */
  readonly notifyCommitted: (
    events: readonly import("./run-execution-store.js").DurableAgentEvent[],
  ) => void;
}

/**
 * What one candidate boundary needs from the gate.
 *
 * A description, not a write: the plan the boundary must persist. Nothing here can change a Run status,
 * and the controller re-reads the durable Run before it commits.
 */
export interface CompletionBoundaryOpening {
  readonly plan: import("@caelush/protocol").VerificationPlan;
}
