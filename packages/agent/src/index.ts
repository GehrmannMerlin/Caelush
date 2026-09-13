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
  isTerminalExecutionStatus,
  nextRunExecutionDirective,
} from "./run/run-execution-coordinator.js";
export type { RunExecutionCoordinator, RunExecutionFacts } from "./run/snapshot.js";
export type {
  AdvanceAgentDirective,
  EvaluateCompletionDirective,
  ExecuteToolBatchDirective,
  FinalizeDirective,
  ReturnTerminalDirective,
  RunExecutionBudgetBlock,
  RunExecutionContinuationKind,
  RunExecutionDirective,
  RunExecutionError,
  RunExecutionErrorCode,
  RunExecutionFinalization,
  RunExecutionMode,
  RunExecutionStatus,
  RunExecutionTerminalReason,
  RunExecutionWaitReason,
  SuspendDirective,
} from "./run/directive.js";
export { RUN_EXECUTION_DIRECTIVE_KINDS } from "./run/directive.js";
export { createRunTransitionPlanner, planRunTransition } from "./run/run-transition-planner.js";
export type {
  RunStepSettlement,
  RunTransitionDraft,
  RunTransitionPlanInput,
  RunTransitionPlanner,
} from "./run/run-transition-planner.js";
export type {
  AgentStepBeginInput,
  AgentStepHandle,
  AgentStepLifecyclePort,
  RunExecutionAgentTurnInput,
  RunExecutionDriver,
  RunExecutionDriverInput,
  RunExecutionToolBatchInput,
  RunExecutionToolBoundaryPort,
} from "./run/run-execution-driver.js";
export type {
  RunExecutionAgentEffect,
  RunExecutionCompletionEffect,
  RunExecutionEffectResult,
  RunExecutionFailureStage,
  RunExecutionNoneEffect,
  RunExecutionToolTurnResult,
  RunExecutionToolsEffect,
} from "./run/effect-result.js";

/* The transient agent stream. */
export { AGENT_TRANSIENT_STREAM_EVENT_TYPES } from "./loop/events/transient-stream-event.js";
export type {
  AgentTransientStreamEvent,
  AgentTransientTextDelta,
  AgentTransientThinkingDelta,
  AgentTransientToolCallDelta,
  ModelTurnStreamSink,
} from "./loop/events/transient-stream-event.js";
