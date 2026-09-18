import type { AgentLoopModelSettings } from "./agent-loop-input.js";
import type { ContextRuntimeCoordinatorPort } from "@caelush/context";
import type { LLMMessage } from "@caelush/llm/messages";
import type { ContextBuildLimits } from "@caelush/context";
import type {
  AgentRun,
  ApprovalRequest,
  ApprovalRequestId,
  ApprovalResolution,
  EventId,
  VerificationCheckId,
  VerificationPlan,
  VerificationPlanDraft,
  VerificationProjectFacts,
} from "@caelush/protocol";
import type { ToolBatchCoordinatorPort } from "@caelush/tools";
import type { DurableAgentEvent, RunExecutionStore } from "./run-execution-store.js";
import type { RunCompletionPersistencePort } from "./run-completion-store.js";
import type { RunExecutionScopeRegistry } from "./run-execution-scope.js";
import type { RunDeadlineRegistry } from "./run-deadline-registry.js";
import type { RunRetryRegistry } from "./run-retry-registry.js";
import type { RetryJitterSource, RetryPolicy } from "./retry-controller.js";
import type { RunBudgetPort } from "./budget-ports.js";
import type { ResourceGovernancePort } from "./resource-governance-port.js";
import type { ModelUsage } from "@caelush/ai";
import type {
  VerificationCommandExecutionPort,
  VerificationCommandSecurityPort,
  VerificationEvidenceSanitizer,
  VerificationProjectProfile,
  VerificationRunnerInput,
  VerificationRunnerResult,
  ProjectCheckResolverRegistry,
  VerificationExecutionStorePort,
  VerificationExecutionRecoveryStorePort,
  VerificationGitPort,
  WorkspaceVerificationPort,
  VerificationRepairPolicy,
  TaskAcceptanceReview,
  TaskReviewBundle,
} from "@caelush/verification";

export interface RunExecutionConfig {
  readonly baseSystemPrompt: string;
  readonly contextLimits: ContextBuildLimits;
  readonly historyPrefix?: readonly LLMMessage[];
  readonly modelSettings?: AgentLoopModelSettings;
  readonly cwd?: string;
  readonly explicitPaths?: readonly string[];
  readonly projectFacts?: VerificationProjectFacts;
}

export interface RunExecutionConfigResolver {
  resolve(run: AgentRun): Promise<RunExecutionConfig>;
}

export interface RunEventNotifier {
  notifyCommitted(events: readonly DurableAgentEvent[]): void;
}

export interface EventIdFactory {
  create(): EventId;
}

export interface VerificationPlannerPort {
  plan(input: import("@caelush/protocol").VerificationPlanningInput): VerificationPlanDraft;
}

export interface VerificationPlanIdFactory {
  create(): VerificationPlan["id"];
}

export interface VerificationCheckIdFactory {
  create(): VerificationCheckId;
}

export interface VerificationRunnerPort {
  run(input: VerificationRunnerInput): Promise<VerificationRunnerResult>;
}

export interface ProjectProfileProviderPort {
  getFreshProfile(run: AgentRun, config: RunExecutionConfig): Promise<VerificationProjectProfile>;
}

/**
 * The verification reviewer executes through the same model turn authority as a
 * normal agent turn: one AI subsystem, one gateway, no second provider registry
 * generation.
 *
 * Phase 3A aligned the agent executor with the frozen union result, so this seam names
 * the transitional throwing facade over it rather than the frozen port itself. The
 * reviewer's review is a host action rather than an AgentStep, so it has no durable turn
 * of its own.
 */
export type VerificationLLMClient = import("./task-acceptance-reviewer.js").VerificationModelClient;

export interface VerificationTaskReviewerPort {
  review(input: {
    readonly run: AgentRun;
    readonly candidateText: string;
    readonly bundle: TaskReviewBundle;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly status: "PASSED" | "FAILED" | "ERROR";
    readonly review?: TaskAcceptanceReview;
    readonly reviewInputHash: string;
    readonly usage?: ModelUsage;
    readonly budget?: import("./agent-errors.js").AgentBudgetBlock;
    readonly errorCode?: string;
  }>;
}

export interface ApprovalResolutionPort {
  getById(id: ApprovalRequestId): Promise<ApprovalRequest | null>;
  resolve(id: ApprovalRequestId, resolution: ApprovalResolution): Promise<ApprovalRequest>;
  cancelPendingByRun?(
    runId: import("@caelush/protocol").RunId,
  ): Promise<readonly ApprovalRequest[]>;
}

export interface RunOwnedResourceControllerPort {
  cancelOwnedResources(runId: import("@caelush/protocol").RunId): Promise<{
    readonly stoppedResourceIds: readonly string[];
    readonly confirmed: boolean;
  }>;
}

export interface RunControllerDependencies {
  /**
   * The Run Layer's direct Agent execution dependencies.
   *
   * Phase 3C checkpoint 6 retired the legacy Core `AgentLoop` from the production composition. The
   * RunController composes the frozen `AgentLoop` itself — `createAgentLoop(...)` over a
   * `ContextEnginePort`, the host's `ModelTurnExecutor`, the decision classifier and the two
   * Run-Layer-owned turn ports — and drives it through `createRunExecutionDriver(...)`. A host that
   * supplied a facade here could decide a Step sequence or a Reason entry point that the Run Layer
   * is the authority for.
   */
  readonly agentExecution: import("./run-agent-execution.js").RunAgentExecutionContextFactory;
  /**
   * The canonical Run execution store.
   *
   * It is the agent-owned port plus this layer's compatibility view over the coding-verification
   * plan; the General Run surface it exposes is exactly the agent contract.
   */
  readonly executionStore: RunExecutionStore;
  /**
   * The Core-private completion persistence boundary.
   *
   * Kept separate from the general store so a general Run store never has to answer a verification
   * question. Phase 3E made this the *only* way a verification plan or a verified final result is
   * persisted: the plan commits in the same transaction as the boundary that names it, and the final
   * result commits in the same transaction as the `COMPLETED` transition.
   *
   * Optional, because a general host that has no coding completion path never needs one. When it is
   * absent the Run Layer asks the general store, and a store that implements both answers.
   */
  readonly completionStore?: RunCompletionPersistencePort;
  readonly events: RunEventNotifier;
  readonly configResolver: RunExecutionConfigResolver;
  readonly toolCoordinator?: ToolBatchCoordinatorPort;
  readonly contextRuntime?: Pick<ContextRuntimeCoordinatorPort, "getContextPolicy">;
  readonly clock: { now(): import("@caelush/protocol").TimestampMs };
  readonly eventIdFactory: EventIdFactory;
  readonly approvals?: ApprovalResolutionPort;
  readonly scopes?: RunExecutionScopeRegistry;
  readonly deadlineRegistry?: RunDeadlineRegistry;
  readonly retryRegistry?: RunRetryRegistry;
  readonly retryPolicy?: RetryPolicy;
  readonly retryJitter?: RetryJitterSource;
  readonly resources?: RunOwnedResourceControllerPort;
  readonly budget?: RunBudgetPort;
  /** Core-side request estimator. The durable budget port receives plain numbers. */
  readonly tokenEstimator?: import("./llm-token-estimator.js").LLMTokenEstimator;
  readonly resourceGovernance?: ResourceGovernancePort;
  /**
   * The Run Layer's completion collaborator.
   *
   * ```text
   * one port   openEvaluation · planCandidateBoundary · compileRepairContext
   * ```
   *
   * Phase 3F converged the completion surface onto this one dependency. It replaces the eighteen
   * verification-specific fields below, which the Run Layer used to read and assemble itself: which
   * concrete planner, resolver registry, runner, reviewer, workspace, Git and security ports make up a
   * completion evaluation is composition, and composition belongs to the module that owns it rather
   * than to the object that commits lifecycle transitions.
   *
   * The Run Layer still commits every lifecycle transition the assembly's answers imply. It hands the
   * assembly its own notifier and its completion persistence port per evaluation, so the assembly can
   * neither publish an event nor write a Run status of its own.
   *
   * Optional, because a general host that composes no completion path keeps the behaviour it always
   * had: an Agent effect that cannot evaluate completion waits on its durable boundary.
   */
  readonly completion?: import("./run-completion-assembly.js").RunCompletionAssembly;
  /**
   * ```text
   * COMPATIBILITY — the Phase 3E flat verification dependency group
   * ```
   *
   * These fields are the surface the Run Layer read directly before Phase 3F. They remain a stable,
   * declared part of this public interface under `MIGRATION_EXECUTION_CONTRACT.md` Rule 5, and they are
   * converted by exactly one module — `run-completion-compatibility.ts` — into the single canonical
   * completion assembly. There is no second assembly implementation behind them.
   *
   * The Run Layer itself must not read any of them; `run-controller.ts` names the converged
   * `completion` port instead. New hosts compose `completion`.
   *
   * Exit condition: the respective subsystem's deletion stage, when this group and the compatibility
   * module are removed together.
   */
  readonly verificationPlanner?: VerificationPlannerPort;
  readonly verificationPlanIdFactory?: VerificationPlanIdFactory;
  readonly verificationCheckIdFactory?: VerificationCheckIdFactory;
  readonly verificationRunner?: VerificationRunnerPort;
  readonly projectProfileProvider?: ProjectProfileProviderPort;
  readonly verificationExecution?: VerificationCommandExecutionPort;
  readonly verificationExecutionStore?: VerificationExecutionStorePort;
  readonly verificationExecutionRecovery?: VerificationExecutionRecoveryStorePort;
  readonly verificationWorkspace?: WorkspaceVerificationPort;
  readonly verificationGit?: VerificationGitPort;
  readonly verificationSecurity?: VerificationCommandSecurityPort;
  readonly verificationEvidenceSanitizer?: VerificationEvidenceSanitizer;
  readonly verificationEvidenceIdFactory?: () => import("@caelush/protocol").VerificationEvidenceId;
  readonly verificationResolverRegistry?: ProjectCheckResolverRegistry;
  readonly verificationReviewer?: VerificationTaskReviewerPort;
  readonly verificationModelTurns?: VerificationLLMClient;
  /**
   * Deliberately absent: a global verification turn identity.
   *
   * A review is a host action about a Run, and Phase 3E made the identity it executes as an explicit
   * argument the reviewer projects from that Run. There is no mutable "active turn" for a host to
   * publish or for a review to read, which is what stops one Run's review from being attributed to
   * another Run's execution — or from failing because no Agent turn happened to run first.
   */
  /**
   * The durable Run execution coordinator.
   *
   * Phase 3C made "what does durable execution do next" a pure, injectable decision, so a host can
   * supply its own policy — and so the default one is testable as a table rather than through a
   * live Run. The RunController remains the only object that commits a lifecycle transition.
   */
  readonly coordinator?: import("@caelush/agent").RunExecutionCoordinator;
  /**
   * The frozen effect-to-commit planner.
   *
   * Phase 3C checkpoint 5 made it the settlement authority for every Agent effect the frozen
   * contract can express. Injectable for the same reason the coordinator is — so a host can supply
   * its own policy — and defaulted, because a Run that could not plan a transition could not settle
   * one either.
   */
  readonly transitionPlanner?: import("@caelush/agent").RunTransitionPlanner;
  /**
   * The transitional event boundary for a planned commit.
   *
   * The planner owns no `EventId` factory and plans `events: []`; this fills them in between
   * planning and committing, and may change nothing else.
   */
  readonly eventMaterializer?: import("./run-commit-event-materializer.js").RunCommitEventMaterializer;
  readonly verificationRepairPolicy?: VerificationRepairPolicy;
  readonly verificationPlanCount?: (runId: import("@caelush/protocol").RunId) => Promise<number>;
  readonly onVerifiedCompletion?: (input: {
    readonly run: AgentRun;
    readonly finalResult: unknown;
  }) => Promise<void> | void;
}
