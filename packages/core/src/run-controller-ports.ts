import type { AgentLoopModelSettings } from "./agent-loop-input.js";
import type { AgentLoop } from "./agent-loop.js";
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
import type { DurableAgentEvent, RunExecutionStorePort } from "./run-execution-store.js";
import type { RunExecutionScopeRegistry } from "./run-execution-scope.js";
import type { RunDeadlineRegistry } from "./run-deadline-registry.js";
import type { RunRetryRegistry } from "./run-retry-registry.js";
import type { RetryJitterSource, RetryPolicy } from "./retry-controller.js";
import type { RunBudgetPort } from "./budget-ports.js";
import type { LLMTurnResult } from "@caelush/llm/turn";
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

export interface VerificationLLMClient {
  complete(
    request: import("@caelush/llm/request").LLMRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<LLMTurnResult>;
}

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
    readonly usage?: import("@caelush/llm/turn").LLMUsage;
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
  readonly agentLoop: AgentLoop;
  readonly execution: RunExecutionStorePort;
  readonly events: RunEventNotifier;
  readonly configResolver: RunExecutionConfigResolver;
  readonly toolCoordinator?: ToolBatchCoordinatorPort;
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
  readonly verificationLLMClient?: VerificationLLMClient;
  readonly verificationRepairPolicy?: VerificationRepairPolicy;
  readonly verificationPlanCount?: (runId: import("@caelush/protocol").RunId) => Promise<number>;
}
