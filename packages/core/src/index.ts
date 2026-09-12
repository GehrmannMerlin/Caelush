export {
  assertRunStatusTransition,
  canTransitionRunStatus,
  InvalidRunStatusTransitionError,
  isTerminalRunStatus,
} from "./run-state-machine.js";
export {
  AgentKernelStateError,
  AgentBudgetAdmissionError,
  AgentLoopInputError,
  AgentModelOutputError,
  AgentToolResultBatchError,
  ToolBatchResultConversionError,
} from "./agent-errors.js";
export type {
  AgentModelOutputErrorReason,
  AgentToolResultBatchErrorReason,
  AgentModelOutputMetadata,
  AgentToolResultBatchErrorMetadata,
  AgentBudgetBlock,
} from "./agent-errors.js";
export type {
  AgentDecision,
  AgentFinalCandidateDecision,
  AgentLoopOutcome,
  AgentMaxStepsReachedOutcome,
  AgentModelTurn,
  AgentToolCallsDecision,
  AgentToolRequest,
} from "./agent-decision.js";
export type {
  AwaitingVerificationContinuation,
  WaitingVerificationRepairContinuation,
  WaitingResourceContinuation,
  RunContinuationCheckpoint,
  RetryErrorCode,
  WaitingRetryContinuation,
  WaitingToolResultsContinuation,
} from "./agent-continuation.js";
export {
  AgentDecisionSchema,
  AgentFinalCandidateDecisionSchema,
  AgentModelTurnSchema,
  AgentToolCallsDecisionSchema,
  AgentToolRequestSchema,
  AwaitingVerificationContinuationSchema,
  RunContinuationCheckpointSchema,
  WaitingRetryContinuationSchema,
  WaitingToolResultsContinuationSchema,
  WaitingVerificationRepairContinuationSchema,
  WaitingResourceContinuationSchema,
} from "./agent-continuation-schema.js";
export { classifyAgentDecision } from "./agent-decision-mapper.js";
export { summarizeAgentDecision, summarizeAgentLoopOutcome } from "./agent-summary.js";
export { normalizeToolResultBatch } from "./agent-tool-results.js";
export { toLLMToolResultMessages } from "./agent-tool-batch.js";
export {
  beginAgentStepState,
  cancelAgentStepState,
  createInitialAgentState,
  markAgentStateMaxStepsReached,
  markAgentStateTimedOut,
  markAgentStateBudgetExceeded,
  markAgentStateWaitingApproval,
  markAgentStateWaitingResource,
  markAgentStateVerifying,
  markAgentStateCompleted,
  resumeAgentStateFromVerificationRepair,
  settleAgentStepState,
  resumeAgentStateFromApproval,
  resumeAgentStateFromResource,
  startAgentState,
  markAgentStateCancelled,
} from "./agent-state.js";
export type { CancelAgentStepStateInput, SettleAgentStepInput } from "./agent-state.js";
export {
  cancelAgentStep,
  completeAgentStep,
  createRunningAgentStep,
  failAgentStep,
  nextAgentStepSequence,
} from "./agent-step.js";
export type { CompleteAgentStepInput, CreateRunningAgentStepInput } from "./agent-step.js";
export { evaluateAgentStepGate } from "./agent-step-gate.js";
export type { AgentStepGate } from "./agent-step-gate.js";
export type {
  AgentLoopCommonInput,
  AgentLoopExecutionResult,
  AgentLoopFailureResult,
  AgentRetryMetadata,
  AgentLoopCancelledResult,
  AgentLoopModelSettings,
  AgentLoopOutcomeResult,
  AgentLoopResumeInput,
  AgentLoopStartInput,
} from "./agent-loop-input.js";
export type {
  AgentContextBuilderPort,
  AgentLoopDependencies,
  AgentProjectInspectorPort,
  AgentRelevantFilePlannerPort,
  AgentClock,
  AgentStepIdFactory,
  AgentBeforeProviderTurn,
  AgentBeforeProviderAdmission,
  AgentLoopLifecycleHooks,
  AgentProviderTurnState,
} from "./agent-loop-ports.js";
export { AgentLoop } from "./agent-loop.js";
export {
  fingerprintToolBatch,
  fingerprintToolRequest,
  fingerprintToolResult,
  fingerprintToolResultBatch,
} from "./resource-fingerprint.js";
export { ProgressLedger } from "./progress-ledger.js";
export { ResourceLoopDetector } from "./resource-loop-detector.js";
export { ResourceGovernor } from "./resource-governor.js";
export type {
  ProgressLedgerRecordInput,
  ProgressLedgerSnapshot,
  ProgressObservation,
  ProgressSignal,
} from "./progress-ledger.js";
export type {
  ResourceLoopDetectorPolicy,
  ResourceLoopEvaluationInput,
  ResourceLoopLevel,
} from "./resource-loop-detector.js";
export type { ResourceDecision, ResourceToolBatchEvaluationInput } from "./resource-governor.js";
export type {
  ResourceGovernancePort,
  ResourceGovernanceState,
} from "./resource-governance-port.js";
export type { RunControllerResult, RunControllerToolResults } from "./run-controller-input.js";
export {
  RunController,
  RunControllerBusyError,
  RunControllerConflictError,
  RunControllerInfrastructureError,
  RunControllerInvariantError,
  RunControllerInputError,
} from "./run-controller.js";
export type {
  EventIdFactory,
  RunControllerDependencies,
  RunEventNotifier,
  RunExecutionConfig,
  RunExecutionConfigResolver,
  ApprovalResolutionPort,
  RunOwnedResourceControllerPort,
  VerificationPlannerPort,
  VerificationPlanIdFactory,
  VerificationCheckIdFactory,
  VerificationRunnerPort,
  ProjectProfileProviderPort,
} from "./run-controller-ports.js";
export { buildRunExecutionHistory } from "./run-controller-history.js";
export { TaskAcceptanceReviewer } from "./task-acceptance-reviewer.js";
export type { TaskAcceptanceReviewerDependencies } from "./task-acceptance-reviewer.js";
export {
  createProjectProfileProvider,
  toVerificationProjectProfile,
} from "./verification-profile-provider.js";
export { RunExecutionConflictError, RunExecutionInvariantError } from "./run-execution-store.js";
export {
  deriveRunDeadline,
  isRunDeadlineExceeded,
  remainingRunTimeMs,
  RunDeadlineInvariantError,
} from "./run-deadline.js";
export type { RunDeadline } from "./run-deadline.js";
export {
  DEFAULT_MAX_TIMER_DELAY_MS,
  RunDeadlineRegistry,
  SystemRunDeadlineTimer,
} from "./run-deadline-registry.js";
export type {
  RunDeadlineRegistryOptions,
  RunDeadlineTimerHandle,
  RunDeadlineTimerPort,
} from "./run-deadline-registry.js";
export { resolveRunTerminationAuthority } from "./run-termination-authority.js";
export type {
  ResolveRunTerminationAuthorityInput,
  RunExecutionAbortCause,
  RunTerminationAuthority,
} from "./run-termination-authority.js";
export {
  RunExecutionScope,
  RunExecutionScopeBusyError,
  RunExecutionScopeRegistry,
} from "./run-execution-scope.js";
export {
  assertRunExecutionInvariant,
  isExecutionBoundaryStatus,
  markAgentRunFailed,
  markAgentRunTimedOut,
  markAgentRunBudgetExceeded,
  markAgentRunCancelled,
  markAgentRunCompleted,
  markAgentRunWaitingApproval,
  markAgentRunWaitingResource,
  resumeAgentRunFromApproval,
  resumeAgentRunFromResource,
  resumeAgentRunFromVerificationRepair,
  markAgentStateFailed,
} from "./run-execution-state.js";
export type {
  RunBudgetPort,
  RunBudgetSettlement,
  RunLLMBudgetAdmission,
  RunLLMBudgetAdmissionInput,
} from "./budget-ports.js";
export {
  evaluateCompletionAuthority,
  createVerifiedRunFinalResult,
} from "./completion-authority.js";
export type {
  CompletionAuthorityInput,
  CompletionAuthorityDecision,
  CompletionFreshness,
  CompletionGitFreshness,
} from "./completion-authority.js";
export type {
  DurableAgentEvent,
  DurableEventDraft,
  RunConversationEntry,
  RunExecutionCommit,
  RunExecutionCommitResult,
  RunExecutionContinuationWrite,
  RunExecutionMessageAppend,
  RunExecutionSnapshot,
  RunExecutionStepWrite,
  RunVerifiedCompletionCommit,
  RunExecutionStorePort,
} from "./run-execution-store.js";
export {
  DEFAULT_MAX_RETRY_TIMER_DELAY_MS,
  RunRetryRegistry,
  SystemRunRetryTimer,
} from "./run-retry-registry.js";
export type {
  RunRetryRegistryOptions,
  RunRetryTimerHandle,
  RunRetryTimerPort,
} from "./run-retry-registry.js";
export {
  DEFAULT_RETRY_POLICY,
  MAX_RETRY_ATTEMPTS,
  RetryController,
  validateRetryPolicy,
} from "./retry-controller.js";
export type {
  RetryDecision,
  RetryDecisionInput,
  RetryJitterSource,
  RetryPolicy,
  RetryStopReason,
} from "./retry-controller.js";
export {
  BudgetManager,
  type LLMBudgetAdmission,
  type LLMBudgetAdmissionInput,
  type ModelPricingSnapshot,
  type RunBudgetSnapshot,
  type ToolBudgetAdmission,
  type ToolBudgetAdmissionInput,
} from "./budget-manager.js";
export { addCostMicros, costMicrosForTokens, usdToCostMicros } from "./cost-micros.js";
export type { CostMicros } from "./cost-micros.js";
export { normalizeLLMUsageForBudget } from "./llm-usage-normalizer.js";
export type { NormalizedLLMUsage } from "./llm-usage-normalizer.js";
export { RequestTokenEstimator, createDefaultLLMTokenEstimator } from "./llm-token-estimator.js";
export type { LLMTokenEstimator } from "./llm-token-estimator.js";
export { StaticPricingResolver } from "./pricing.js";
export type { PricingResolver } from "./pricing.js";

/**
 * Re-exported frozen AI model-invocation types.
 *
 * A legacy consumer that may not depend on `@caelush/ai` directly — `@caelush/storage``n * is the current example — names them through Core instead. Core depends on the AI
 * core in the sanctioned legacy-to-target direction, and these are re-exports, not
 * declarations: the AI package remains their single owner.
 */
export type { AIModelRequest, AIModelTurnResult, ModelUsage } from "@caelush/ai";
