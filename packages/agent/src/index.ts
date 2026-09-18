/**
 * `@caelush/agent` — Architecture V2 general agent kernel.
 *
 * Responsibility (Architecture V2, frozen):
 *   - General Agent, Agent Loop, Run Lifecycle contracts
 *   - Context Engine, Message Domain, Tool Framework
 *   - Generic Security, Generic Completion Gate, Memory contracts
 *   - Session Conversation Domain, Agent Events
 *   - Recovery, Retry, Budget, Resource Governance
 *
 * This package must never know about a Coding Agent, concrete Runtime operations,
 * SQLite, the Daemon, a Client, Git, `read_file`, `exec_command`, `apply_patch`,
 * Node/Java project scanning, or the local filesystem. Those boundaries are enforced by
 * `pnpm check:architecture`.
 *
 * The only workspace packages this kernel may depend on are `@caelush/ai` and
 * `@caelush/protocol`; it has no legacy edge in either direction. The public surface is
 * root-only: no cross-package re-export and no wildcard, so a consumer imports from
 * `@caelush/agent` and never from a deep path.
 *
 * Phase 3A freezes the V2 kernel contracts: execution identity, turn reference, turn
 * input, decision, `AgentLoop.advance()`, the model request builder, the model admission
 * and durable model turn boundary ports, the transient agent stream, and the frozen
 * `ModelTurnExecutor` union result. Later phases implement them. Phase 3A contract
 * remediation restored those shapes after 3B/3C drift: `modelSettings` (never `settings`),
 * no `streamSink` on the loop input, the four-discriminant advance result, the typed
 * context receipt, and the stage-free, cause-free model turn failure.
 */

/* The agent loop. Phase 3B implements the frozen `advance()`. */
export { createAgentLoop } from "./loop/agent-loop.js";
export type { AgentLoop, AgentLoopDependencies } from "./loop/agent-loop.js";

/* The context boundary. */
export { toAIModelSettings } from "./loop/context/context-engine-port.js";
export type {
  ContextEnginePort,
  ContextPrepareInput,
  ContextPrepareMode,
  ContextProvider,
  ContextProviderInput,
} from "./loop/context/context-engine-port.js";

/* General conversation and turn-input integrity. */
export {
  AGENT_TURN_INPUT_ERROR_REASONS,
  AgentTurnInputError,
  agentTurnInputErrorMessage,
  assertAgentTurnInput,
  assertConversationProtocolIntegrity,
  assertPendingAssistantHistory,
  semanticEqual,
} from "./loop/history/conversation-history.js";
export type { AgentTurnInputErrorReason } from "./loop/history/conversation-history.js";

/* Kernel types: identity, turn reference, turn input, prepared context, decisions. */
export {
  AGENT_LOOP_ADVANCE_RESULT_KINDS,
  assertAgentTurnRef,
  createAgentTurnRef,
} from "./loop/types.js";
export type {
  AgentContinuationReason,
  AgentDecision,
  AgentExecutionIdentity,
  AgentFinalCandidateDecision,
  AgentLoopAdvanceInput,
  AgentLoopAdvanceResult,
  AgentLoopCancelledResult,
  AgentLoopContextReceipt,
  AgentLoopFailedResult,
  AgentLoopFinalCandidateResult,
  AgentLoopSuccessBase,
  AgentLoopToolRequestsResult,
  AgentModelTurn,
  AgentRetryMetadata,
  AgentToolCallsDecision,
  AgentToolRequest,
  AgentTurnInput,
  AgentTurnRef,
  ContextBuildContribution,
  ContextBuildReport,
  ContextCheckpointRef,
  ContextItem,
  ContextItemPriorityClass,
  ContextPressure,
  PreparedModelContext,
  ToolObservationPolicySnapshot,
} from "./loop/types.js";

/* Decision classification. */
export {
  classifyAgentDecision,
  createAgentDecisionClassifier,
} from "./loop/decision/decision-classifier.js";
export type { AgentDecisionClassifier } from "./loop/decision/decision-classifier.js";
export { AGENT_DECISION_TYPES } from "./loop/decision/decision.js";
export { AgentModelOutputError } from "./loop/decision/decision-error.js";
export type {
  AgentModelOutputErrorReason,
  AgentModelOutputMetadata,
} from "./loop/decision/decision-error.js";

/* Model request building. */
export { createModelRequestBuilder } from "./loop/turn/model-request-builder.js";
export type {
  ModelRequestBuilder,
  ModelRequestBuilderInput,
} from "./loop/turn/model-request-builder.js";

/* The frozen model turn executor. */
export { createModelTurnExecutor } from "./loop/turn/model-turn-executor.js";
export type {
  ModelTurnExecutionCancelled,
  ModelTurnExecutionCompleted,
  ModelTurnExecutionFailed,
  ModelTurnExecutionInput,
  ModelTurnExecutionResult,
  ModelTurnExecutor,
  ModelTurnExecutorDependencies,
} from "./loop/turn/model-turn-executor.js";

/* The turn failure contract and its single deterministic durable projection. */
export {
  toModelTurnExecutionError,
  toModelTurnExecutionErrorCode,
} from "./loop/turn/model-turn-executor.js";
export {
  isRetryableModelTurnErrorCode,
  MODEL_TURN_EXECUTION_ERROR_CODES,
  RETRYABLE_MODEL_TURN_ERROR_CODES,
} from "./loop/turn/model-turn-error.js";
export type {
  ModelTurnExecutionError,
  ModelTurnExecutionErrorCode,
} from "./loop/turn/model-turn-error.js";
export {
  toAgentError,
  toAgentErrorCode,
  toAgentTurnInputError,
  toBudgetAgentError,
} from "./loop/turn/agent-error-projection.js";

/* The ports the Run Layer and the host implement. */
export { allowedModelAdmission } from "./loop/ports/model-request-admission.js";
export type {
  AgentBudgetBlock,
  ModelRequestAdmissionDecision,
  ModelRequestAdmissionInput,
  ModelRequestAdmissionPort,
} from "./loop/ports/model-request-admission.js";
export type {
  ModelTurnBoundaryInput,
  ModelTurnBoundaryPort,
} from "./loop/ports/model-turn-boundary.js";

/* The durable Run execution contract: directive, coordinator, driver, planner. */
export {
  createRunExecutionCoordinator,
  nextRunExecutionDirective,
} from "./run/run-execution-coordinator.js";
export type { RunExecutionCoordinator } from "./run/run-execution-coordinator.js";
export {
  RUN_EXECUTION_ADVANCE_REASONS,
  RUN_EXECUTION_DIRECTIVE_KINDS,
  RUN_EXECUTION_FINALIZE_REASONS,
  RUN_EXECUTION_STATUSES,
  RUN_EXECUTION_SUSPEND_BOUNDARIES,
  isTerminalExecutionStatus,
} from "./run/directive.js";
export type {
  AdvanceAgentDirective,
  EvaluateCompletionDirective,
  ExecuteToolBatchDirective,
  FinalizeDirective,
  ReturnTerminalDirective,
  RunExecutionAdvanceReason,
  RunExecutionDirective,
  RunExecutionFinalizeReason,
  RunExecutionMode,
  RunExecutionStatus,
  RunExecutionSuspendBoundary,
  SuspendDirective,
} from "./run/directive.js";
export type { RunTransitionPlanInput, RunTransitionPlanner } from "./run/run-transition-planner.js";
export {
  createRunTransitionPlanner,
  DefaultRunTransitionPlanner,
  planRunTransition,
} from "./run/default-run-transition-planner.js";
export { createRunExecutionDriver } from "./run/run-execution-driver.js";
export type {
  RunExecutionDriver,
  RunExecutionDriverDependencies,
  RunExecutionEffectContext,
} from "./run/run-execution-driver.js";
export { RUN_EXECUTION_EFFECT_KINDS } from "./run/effect-result.js";
export type { RunExecutionEffectResult } from "./run/effect-result.js";

/* The canonical Run execution store port. */
export {
  RunExecutionConflictError,
  RunExecutionInvariantError,
} from "./run/ports/run-execution-store.js";
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
  RunExecutionStorePort,
} from "./run/ports/run-execution-store.js";

/* The general durable Run execution invariant. */
export {
  assertRunExecutionInvariant,
  isTerminalRunStatus,
} from "./run/state/run-execution-invariant.js";

/* The canonical Run state machine. Core re-exports it; nothing redeclares it. */
export {
  assertRunStatusTransition,
  assertRunStatusTransitionsAreTotal,
  canTransitionRunStatus,
  InvalidRunStatusTransitionError,
  RUN_STATUSES,
  RUN_STATUS_TRANSITIONS,
} from "./run/state/run-state-machine.js";

/* The general Run and AgentState transitions. Coding-verification helpers stay in Core. */
export {
  assertMonotonicAgentStateTimestamp,
  cancelAgentRun,
  completeAgentRunWithFinalResult,
  completeAgentState,
  failAgentRun,
  markAgentRunBudgetExceeded,
  markAgentRunMaxStepsReached,
  markAgentRunWaitingApproval,
  markAgentRunWaitingResource,
  markAgentStateBudgetExceeded,
  markAgentStateCancelled,
  markAgentStateFailed,
  markAgentStateMaxStepsReached,
  markAgentStateTimedOut,
  markAgentStateVerifying,
  markAgentStateWaitingApproval,
  markAgentStateWaitingResource,
  resumeAgentRunFromApproval,
  resumeAgentRunFromCompletionRepair,
  resumeAgentRunFromResource,
  resumeAgentStateFromApproval,
  resumeAgentStateFromResource,
  timeOutAgentRun,
} from "./run/state/run-transition-state.js";

export {
  RUN_CONTINUATION_TYPES,
  RUNNING_CONTINUATION_TYPES,
  isRunningContinuation,
} from "./run/continuation/continuation.js";
export type {
  AwaitingVerificationContinuation,
  RetryErrorCode,
  RunContinuationCheckpoint,
  WaitingResourceContinuation,
  WaitingRetryContinuation,
  WaitingToolResultsContinuation,
  WaitingVerificationRepairContinuation,
} from "./run/continuation/continuation.js";

/* The Tool turn and completion gate contracts. Contract only: 3D and 3E implement them. */
export { TOOL_TURN_RESULT_KINDS } from "./run/ports/tool-turn.js";
export type {
  AgentToolResult,
  ToolTurnCoordinator,
  ToolTurnRequest,
  ToolTurnResult,
  WaitingApprovalBoundary,
} from "./run/ports/tool-turn.js";
export { COMPLETION_GATE_KINDS } from "./run/ports/completion-gate.js";
export type {
  AgentCompletionResult,
  CompletionGate,
  CompletionGateDecision,
  CompletionGateInput,
  CompletionRepairRequest,
} from "./run/ports/completion-gate.js";
/*
 * The general gate implementation. The coding gate lives in Core, behind the same frozen contract;
 * this one is what a host with no verification subsystem composes, and it depends on nothing at all.
 */
export {
  createDirectAcceptCompletionGate,
  DIRECT_ACCEPT_COMPLETION_GATE_ID,
} from "./run/gates/direct-accept-completion-gate.js";
export type { DirectAcceptCompletionGateOptions } from "./run/gates/direct-accept-completion-gate.js";

/* The canonical durable Step lifecycle and its AgentState projection. */
export { AgentStepStateError } from "./run/turn/step-lifecycle.js";
export {
  cancelAgentStep,
  completeAgentStep,
  createRunningAgentStep,
  failAgentStep,
  nextAgentStepSequence,
} from "./run/turn/step-lifecycle.js";
export type {
  CompleteAgentStepInput,
  CreateRunningAgentStepInput,
} from "./run/turn/step-lifecycle.js";
export {
  beginAgentStepState,
  cancelAgentStepState,
  settleAgentStepState,
} from "./run/turn/step-state.js";
export type { CancelAgentStepStateInput, SettleAgentStepInput } from "./run/turn/step-state.js";

/* The transient agent stream. */
export { AGENT_TRANSIENT_STREAM_EVENT_TYPES } from "./loop/events/transient-stream-event.js";
export type {
  AgentTransientStreamEvent,
  AgentTransientTextDelta,
  AgentTransientThinkingDelta,
  AgentTransientToolCallDelta,
  ModelTurnStreamSink,
} from "./loop/events/transient-stream-event.js";

/*
 * The general Agent Tool framework. Phase 4A moved the executable Tool contract, the schema runtime
 * and policy, the immutable registry and call preparation here; the Coding overlay consumes them.
 *
 * `AgentToolResult` is deliberately a *shim* name, because the frozen Phase 3 Tool turn contract
 * already owns that export. The two types are different things and both names are frozen:
 *
 *   run/ports/tool-turn.ts   AgentToolResult          the model-visible result of a Tool turn
 *                                                     (externalCallId, toolName, content, isError)
 *   tools/types/tool-result  AgentToolResult<TDetails> the raw result of one Tool execution
 *                                                     (content, details, isError)
 *
 * The Phase 3 declaration keeps its name and its fields. The Tool System's own declaration stays
 * inside `./tools/`, is what `AgentTool.execute()` returns, and is published here under an explicit
 * alias. That alias is an export mapping, not a third DTO: one structure, one declaration.
 */
export {
  AgentToolRegistrationError,
  AgentToolRegistryStateError,
  AgentToolSchemaCompileError,
  canonicalJsonString,
  canonicalizeJsonValue,
  cloneJsonValue,
  containsForbiddenSchemaFeature,
  createToolCallPreparer,
  DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES,
  DEFAULT_MAX_INVOCATION_ARGS_BYTES,
  DEFAULT_TOOL_EXECUTION_MODE,
  DEFAULT_TOOL_REGISTRY_OPTIONS,
  deepFreezeJson,
  DefaultAgentToolRegistryBuilder,
  DISCARDING_TOOL_EXECUTION_UPDATE_SINK,
  ImmutableAgentToolRegistry,
  isJsonObject,
  isToolExecutionMode,
  jsonUtf8ByteLength,
  normalizeInstancePath,
  TOOL_CALL_REJECTION_CODES,
  TOOL_EXECUTION_MODES,
  ToolArgumentPreparationError,
  ToolExecutionInfrastructureError,
  ToolPreparationInfrastructureError,
  ToolSchemaRuntime,
  toolModelSpecByteLength,
  validateToolRegistryOptions,
  validateToolSchemaSemantics,
} from "./tools/index.js";
export type {
  AgentTool,
  AgentToolExecutionInput,
  AgentToolRegistrationErrorMetadata,
  AgentToolRegistrationErrorReason,
  AgentToolRegistry,
  AgentToolRegistryBuilder,
  AgentToolSchemaKind,
  CompiledToolSchema,
  PreparedToolCall,
  ResolvedAgentTool,
  ToolArgumentNormalization,
  ToolCallPreparationOutcome,
  ToolCallPreparer,
  ToolCallPreparerOptions,
  ToolCallRequest,
  ToolExecutionEnvironment,
  ToolExecutionIdentity,
  ToolExecutionInfrastructurePhase,
  ToolExecutionMode,
  ToolExecutionUpdate,
  ToolExecutionUpdateSink,
  ToolFailureDisposition,
  ToolFailureFeedback,
  ToolInvocationPresentation,
  ToolModelSpecInput,
  ToolPresentationPort,
  ToolRegistryOptions,
  ToolResultPresentation,
  ToolSchemaIssue,
  ToolSchemaValidationResult,
  ValidatedToolSchemas,
} from "./tools/index.js";
export type { AgentToolResult as AgentToolExecutionResult } from "./tools/types/tool-result.js";
