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
export {
  defaultObservationPolicy,
  toAgentToolResults,
  toContextObservationProjection,
  toLLMToolResultMessages,
} from "./agent-tool-batch.js";
export type { AgentToolObservationPolicy } from "./agent-tool-batch.js";
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
/**
 * The legacy Core `AgentLoop` facade.
 *
 * ```text
 * LEGACY / TEST COMPATIBILITY SURFACE
 * NOT the production Agent execution authority
 * ```
 *
 * Phase 3C checkpoint 6 moved Step ownership, the durable boundary and the Reason entry point into
 * the Run Layer: production Agent execution composes the frozen `@caelush/agent` `AgentLoop` through
 * `createRunAgentLoop(...)` and drives it with `createRunExecutionDriver(...)`. This class remains
 * for its own unit and migration-parity tests only, and no production consumer may import it.
 */
export { AgentLoop } from "./agent-loop.js";
/**
 * The transitional throwing facade over the frozen `ModelTurnExecutor`.
 *
 * Phase 3F confirmed its production construction and execution consumer count is zero: Phase 3E moved
 * the last host-driven model turn — the verification review — onto an explicit-identity client, so
 * nothing in `apps/` and nothing on the production Agent path builds one. It remains a declared public
 * export with its own tests, and is deleted with the legacy Core `AgentLoop` facade.
 */
export { createLegacyModelTurnExecutor } from "./legacy-model-turn-executor.js";
export type {
  LegacyModelTurnExecutor,
  LegacyModelTurnExecutorDependencies,
} from "./legacy-model-turn-executor.js";
/**
 * The transitional legacy Context Engine behind the frozen context boundary.
 *
 * Exported because a host composition root must build the frozen `ContextEnginePort` over the
 * current Context System. It is deleted when Context Engineering V2 owns real context assembly.
 */
export { createLegacyContextRuntimeAdapter } from "./legacy-context-runtime-adapter.js";
export type { LegacyContextRuntimeAdapterDependencies } from "./legacy-context-runtime-adapter.js";
/**
 * The durable Run execution projection.
 *
 * The decision itself — the `RunExecutionCoordinator`, its frozen directive union, the
 * `RunExecutionDriver` and the transition planner — belongs to `@caelush/agent`. This is the Core
 * boundary that projects a durable snapshot onto the canonical execution snapshot, converting the
 * legacy durable message encoding and the Run Layer continuation domain on the way.
 */
export { toAgentExecutionSnapshot, toExecutionStatus } from "./run-execution-facts.js";
/**
 * The one reviewed AI / legacy message projection pair.
 *
 * The durable ledger still speaks the legacy encoding, so a host that holds a synthetic
 * `LLMMessage` conversation — the daemon's session prefix — projects it through here rather than
 * reimplementing the field-by-field mapping. The Run Layer itself only ever sees `AIMessage`.
 */
export { toAIMessage, toLegacyMessage } from "./ai-invocation-projection.js";
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
/**
 * The Run Layer's Tool turn boundary.
 *
 * ```text
 * frozen ToolTurnRequest  →  the run-scoped adapter  →  the existing durable Tool System
 * ```
 *
 * A host supplies the legacy batch coordinator and the resource ledger; the adapter captures the
 * Run-scoped facts the frozen general contract deliberately does not carry. It is exported because
 * a test host that drives a Tool batch through the Run Layer composes the same boundary the
 * production daemon does.
 */
export { createRunToolTurnDriverFactory } from "./run-tool-turn-coordinator.js";
export type {
  ResolvedRunToolTurn,
  RunToolTurnContext,
  RunToolTurnDriver,
  RunToolTurnDriverDependencies,
} from "./run-tool-turn-coordinator.js";
/** The Core-private record of what one Tool turn did, which the frozen result cannot carry. */
export type {
  RunToolRawObservation,
  RunToolResourceDecision,
  RunToolTurnObservation,
  RunToolUnderlyingOutcome,
} from "./run-tool-turn-observation.js";
/** The typed Tool effect settlement router: one executed Tool turn, exactly one authority. */
export { classifyToolEffectSettlement } from "./run-tool-effect-settlement.js";
export type {
  ToolEffectSettlementInput,
  ToolEffectSettlementRoute,
} from "./run-tool-effect-settlement.js";
/** The one projection of a Run's durable security policy onto the Tool Layer. */
export { createToolSecurityContext } from "./tool-security-context.js";
/**
 * Where a Tool result's raw output pointer is resolved from.
 *
 * The Tool execution ledger is the provenance authority for an unbounded Tool output; the legacy
 * Context adapter resolves each Tool result through this port when a forced recovery needs the raw
 * text again. It is exported because the composition root is what owns the ledger.
 */
export { createToolExecutionLedgerRawObservationResolver } from "./run-tool-observation-recovery.js";
export type { ToolRawObservationRefResolver } from "./run-tool-observation-recovery.js";
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
  ToolTurnPipeline,
} from "./run-controller-ports.js";
/**
 * The Run Layer's direct Agent execution dependencies.
 *
 * The composition root supplies the frozen collaborator ports — a `ModelCatalog`, the host's
 * `ModelTurnExecutor`, a Step identity factory and a Context Engine factory — and the
 * `RunController` composes `createAgentLoop(...)` and `createRunExecutionDriver(...)` itself.
 */
export {
  allocateRunAgentStep,
  createRunAgentExecutionContext,
  createRunAgentLoop,
  monotonicStepStart,
} from "./run-agent-execution.js";
export type {
  RunAgentContextEngineInput,
  RunAgentExecutionContext,
  RunAgentExecutionContextFactory,
  RunAgentExecutionContextFactoryDependencies,
  RunAgentExecutionConfiguration,
  RunAgentExecutionDependencies,
  RunAgentTurnPorts,
} from "./run-agent-execution.js";
/** The canonical durable history projection the production Agent turn reasons from. */
export { projectRunAgentHistory } from "./run-agent-history.js";
export type { RunAgentHistoryInput, RunAgentHistoryProjection } from "./run-agent-history.js";
export { classifyAgentEffectSettlement } from "./run-agent-effect-settlement.js";
export type {
  AgentEffectSettlementInput,
  AgentEffectSettlementRoute,
} from "./run-agent-effect-settlement.js";
export {
  createAgentModelTurnBoundary,
  createAgentTurnObservation,
  createObservingModelTurnExecutor,
  requiresBoundaryRepair,
} from "./run-model-turn-boundary.js";
export type { AgentTurnObservation, PendingAgentTurn } from "./run-model-turn-boundary.js";
export { buildRunExecutionHistory } from "./run-controller-history.js";
export { TaskAcceptanceReviewer } from "./task-acceptance-reviewer.js";
export type {
  TaskAcceptanceReviewerDependencies,
  VerificationModelClient,
} from "./task-acceptance-reviewer.js";
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
export { createRunCommitEventMaterializer } from "./run-commit-event-materializer.js";
export type {
  RunCommitEventMaterializer,
  RunCommitEventMaterializerDependencies,
  RunCommitEventMaterializerInput,
  RunOwnershipContext,
} from "./run-commit-event-materializer.js";
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
  RunExecutionCommitView,
  RunExecutionContinuationWrite,
  RunExecutionMessageAppend,
  RunExecutionSnapshot,
  RunExecutionSnapshotView,
  RunExecutionStepWrite,
  RunExecutionStore,
  RunExecutionStorePort,
} from "./run-execution-store.js";
export type {
  RunCandidateBoundaryCommit,
  RunCompletionPersistencePort,
  RunVerifiedCompletionCommit,
} from "./run-completion-store.js";
export {
  createRunCandidateBoundaryPlanner,
  createRunCompletionGate,
} from "./run-completion-gate.js";
export {
  CompletionGateIdentityError,
  CompletionGateInfrastructureError,
} from "./run-completion-gate.js";
export type {
  CandidateBoundaryPlanningDependencies,
  RunCandidateBoundaryPlanner,
  RunCompletionGate,
} from "./run-completion-gate.js";
export type {
  CompletionTaskReviewerPort,
  CompletionVerificationPlannerPort,
  RunCompletionGateDependencies,
} from "./run-completion-context.js";
export { createCodingCompletionAssembly } from "./run-completion-assembly.js";
export type {
  CodingCompletionAssemblyDependencies,
  CodingCompletionGateHostFacts,
  RunCandidateBoundaryInput,
  RunCompletionAssembly,
  RunCompletionEvaluation,
  RunCompletionEvaluationInput,
  RunRepairContextInput,
} from "./run-completion-assembly.js";
export {
  hasLegacyCompletionGroup,
  legacyCompletionDependencies,
  resolveRunCompletionAssembly,
} from "./run-completion-compatibility.js";
export { createCompletionGateObservation } from "./run-completion-observation.js";
export type {
  CompletionGateObservation,
  CompletionVerificationStatus,
  CompletionWorkspaceFreshness,
} from "./run-completion-observation.js";
export { classifyCompletionEffectSettlement } from "./run-completion-effect-settlement.js";
export type {
  CompletionEffectSettlementInput,
  CompletionEffectSettlementRoute,
} from "./run-completion-effect-settlement.js";
export type { CompletionEventEvidence } from "./run-commit-event-materializer.js";
export {
  toAgentAIMessage,
  toAgentAssistantMessage,
  toAgentToolResultMessage,
  toAgentUserMessage,
  toLegacyAssistantMessage,
  toLegacyDurableMessage,
  toLegacyToolResultMessage,
  toLegacyUserMessage,
} from "./run-message-compatibility.js";
export {
  parseDurableContinuation,
  toAgentContinuation,
  toDurableContinuation,
} from "./run-continuation-compatibility.js";
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
