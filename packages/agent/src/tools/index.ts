/**
 * `@caelush/agent/tools` — the general Agent Tool framework.
 *
 * Tool System V2 splits one Tool definition into three layers, and this module owns the first two:
 *
 * ```text
 * AIToolSpec            @caelush/ai        how a Tool is described to a model
 * AgentTool             @caelush/agent     how a general Tool is executed reliably
 * CodingToolDefinition  @caelush/coding-agent   what a Coding product adds around it
 * ```
 *
 * What lives here is what is true for *every* Tool: the execution identity and input, the result and
 * update contracts, the failure vocabulary, the canonical schema runtime and its policy, the
 * immutable ordered registry, and the call Preparer.
 *
 * What deliberately does not live here:
 *
 * ```text
 * risk levels, capabilities, runtime requirements     Coding overlay metadata
 * security facts, tool effects, presentation, prompts Coding overlay metadata
 * concrete Tools (read_file, exec_command, ...)       @caelush/coding-agent
 * Runtime, filesystem, process, Git, SQLite           @caelush/runtime / @caelush/storage
 * ```
 *
 * A host can therefore register an in-memory Tool, build a registry, project its model specs and
 * prepare a call with `@caelush/agent` alone.
 */

/* Execution vocabulary. */
export {
  DEFAULT_TOOL_EXECUTION_MODE,
  isToolExecutionMode,
  TOOL_EXECUTION_MODES,
} from "./types/execution-mode.js";
export type { ToolExecutionMode } from "./types/execution-mode.js";

export type { ToolExecutionIdentity } from "./types/execution-identity.js";
export type { ToolExecutionEnvironment } from "./types/execution-environment.js";
export { DISCARDING_TOOL_EXECUTION_UPDATE_SINK } from "./types/tool-update.js";
export type { ToolExecutionUpdate, ToolExecutionUpdateSink } from "./types/tool-update.js";
export type { AgentToolExecutionInput } from "./types/execution-input.js";

/* Results, failures and presentation. */
export type { AgentToolResult } from "./types/tool-result.js";
export type { ToolFailureDisposition, ToolFailureFeedback } from "./types/tool-feedback.js";
export type {
  ToolInvocationPresentation,
  ToolPresentationPort,
  ToolResultPresentation,
} from "./types/tool-presentation.js";

/* Errors. */
export {
  AgentToolRegistrationError,
  AgentToolRegistryStateError,
  AgentToolSchemaCompileError,
  ToolArgumentPreparationError,
  ToolExecutionInfrastructureError,
  ToolPreparationInfrastructureError,
} from "./types/errors.js";
export type {
  AgentToolRegistrationErrorMetadata,
  AgentToolRegistrationErrorReason,
  AgentToolSchemaKind,
  ToolExecutionInfrastructurePhase,
} from "./types/errors.js";

/* The executable Tool contract. */
export type { AgentTool } from "./types/agent-tool.js";

/* Canonical schema runtime, policy and JSON helpers. */
export { ToolSchemaRuntime, containsForbiddenSchemaFeature } from "./schema/schema-runtime.js";
export type {
  CompiledToolSchema,
  ToolSchemaIssue,
  ToolSchemaValidationResult,
} from "./schema/schema-runtime.js";
export {
  canonicalJsonString,
  canonicalizeJsonValue,
  cloneJsonValue,
  deepFreezeJson,
  isJsonObject,
  jsonUtf8ByteLength,
} from "./schema/json-canonical.js";
export {
  DEFAULT_TOOL_REGISTRY_OPTIONS,
  toolModelSpecByteLength,
  validateToolRegistryOptions,
  validateToolSchemaSemantics,
} from "./schema/schema-policy.js";
export type {
  ToolModelSpecInput,
  ToolRegistryOptions,
  ValidatedToolSchemas,
} from "./schema/schema-policy.js";

/* The canonical registry. */
export { ImmutableAgentToolRegistry } from "./registry/registry.js";
export type { AgentToolRegistry, ResolvedAgentTool } from "./registry/registry.js";
export { DefaultAgentToolRegistryBuilder } from "./registry/registry-builder.js";
export type { AgentToolRegistryBuilder } from "./registry/registry-builder.js";

/* Call preparation. */
export {
  DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES,
  DEFAULT_MAX_INVOCATION_ARGS_BYTES,
} from "./call/tool-call-preparer-impl.js";
export {
  createToolCallPreparer,
  normalizeInstancePath,
  TOOL_CALL_REJECTION_CODES,
} from "./call/tool-call-preparer-impl.js";
export type {
  ToolArgumentNormalization,
  ToolCallPreparerOptions,
} from "./call/tool-call-preparer-impl.js";
export type {
  PreparedToolCall,
  ToolCallPreparationOutcome,
  ToolCallPreparer,
  ToolCallRequest,
} from "./call/tool-call-preparer.js";

/* Invocation execution and the canonical uncertainty vocabulary. */
export { createToolInvocationExecutor } from "./execution/invocation-executor.js";
export type {
  ToolInvocationExecutor,
  ToolInvocationExecutorOptions,
} from "./execution/invocation-executor.js";
export {
  isToolExecutionUncertainError,
  ToolExecutionUncertainError,
  UNCERTAIN_SIDE_EFFECT,
  uncertainExecutionDetails,
} from "./execution/execution-disposition.js";
export type {
  UncertainExecutionDisposition,
  UncertainSideEffect,
} from "./execution/execution-disposition.js";
export { DISCARDING_TRANSIENT_TOOL_UPDATE_CONSUMER } from "./execution/update-sanitizer-port.js";
export type {
  TransientToolUpdateConsumer,
  TransientToolUpdateDiagnostics,
  ToolExecutionUpdateSanitizerPort,
} from "./execution/update-sanitizer-port.js";

/* Result processing. */
export {
  boundToolResultContent,
  CODING_TOOL_EFFECTS_EXTENSION_KIND,
  DEFAULT_TOOL_RESULT_LIMITS,
  TOOL_RESULT_TRUNCATION_MARKER,
  ToolResultLimitError,
  validateToolResultLimits,
} from "./result/result-policy.js";
export type {
  ToolResultLimits,
  ToolSettlementExtension,
  ToolSettlementExtensionProjector,
} from "./result/result-policy.js";
export {
  IDENTITY_TOOL_RESULT_SANITIZER,
  ToolResultValidationError,
} from "./result/result-sanitizer-port.js";
export type {
  ToolResultSanitizerPort,
  ToolResultValidationErrorKind,
  ValidatedToolResult,
} from "./result/result-sanitizer-port.js";
export {
  isAgentToolResult,
  readResultShape,
  readSanitizedResultShape,
  validateToolResult,
} from "./result/result-validator.js";
export { createToolResultPipeline } from "./result/result-pipeline.js";
export type {
  PreparedToolSettlement,
  ToolResultPipeline,
  ToolResultPipelineOptions,
} from "./result/result-pipeline.js";

/* Admission: the Tool security context, durable metadata, policy, approval and budget boundaries. */
export {
  assertToolSecurityContext,
  isToolSecurityContext,
  ToolSecurityContextError,
} from "./admission/security-context.js";
export type {
  ToolSecurityContext,
  ToolSecurityContextErrorReason,
} from "./admission/security-context.js";
export {
  requireToolDurableMetadata,
  ToolDurableMetadataUnavailableError,
} from "./admission/durable-metadata-port.js";
export type {
  ToolDurableMetadata,
  ToolDurableMetadataInput,
  ToolDurableMetadataPort,
} from "./admission/durable-metadata-port.js";
export { denyToolPolicyDecision } from "./admission/admission-decision.js";
export type {
  ToolAdmissionRequest,
  ToolApprovalRequirement,
  ToolPolicyDecision,
} from "./admission/admission-decision.js";
export type { ToolAdmissionPort, ToolAdmissionPreCheck } from "./admission/admission-port.js";
export {
  createToolAdmissionCoordinator,
  DEFAULT_TOOL_APPROVAL_SCOPE,
} from "./admission/admission-coordinator.js";
export type {
  ToolAdmissionCoordinator,
  ToolAdmissionCoordinatorOptions,
  ToolAdmissionInput,
  ToolAdmissionOutcome,
  ToolBudgetAdmissionLike,
} from "./admission/admission-coordinator.js";
export type {
  ToolApprovalLookupPort,
  ToolApprovalRequestFactory,
} from "./admission/approval-port.js";
export { UNBOUNDED_TOOL_BUDGET_ADMISSION } from "./admission/budget-port.js";
export type { ToolBudgetAdmissionPort } from "./admission/budget-port.js";

/* The durable lifecycle: invocation, observation, store, events, settlement and the coordinator. */
export {
  allowedToolInvocationTransitions,
  assertToolInvocationInvariant,
  assertToolInvocationTransition,
  completeToolInvocation,
  createRequestedToolInvocation,
  failToolInvocation,
  isTerminalToolInvocation,
  markToolInvocationWaitingApproval,
  startToolInvocation,
} from "./durable/invocation-lifecycle.js";
export type { CreateRequestedToolInvocationInput } from "./durable/invocation-lifecycle.js";
export { assertToolObservationInvariant, createToolObservation } from "./durable/observation.js";
export type { CreateToolObservationInput } from "./durable/observation.js";
export {
  ToolExecutionConflictError,
  ToolExecutionInvariantError,
} from "./durable/durable-errors.js";
export type {
  DurableToolEvent,
  DurableToolEventDraft,
  ToolExecutionCommit,
  ToolExecutionCommitResult,
  ToolExecutionSnapshot,
  ToolExecutionStorePort,
} from "./durable/execution-store-port.js";
export {
  createApprovalRequestedEvent,
  createApprovalResolvedEvent,
  createToolCompletedEvent,
  createToolFailedEvent,
  createToolOutputEvent,
  createToolRequestedEvent,
  createToolStartedEvent,
  MAX_TOOL_EVENT_PRESENTATION_BYTES,
} from "./durable/durable-events.js";
export {
  createToolFailureSettlement,
  DURABLE_FAILURE_CODES,
  feedbackToDurableFailure,
} from "./durable/failure-settlement.js";
export type {
  DurableToolFailureSettlement,
  ToolFailureSettlementOptions,
} from "./durable/failure-settlement.js";
export { createToolSettlementCoordinator } from "./durable/settlement-coordinator.js";
export type {
  ToolSettlementCoordinator,
  ToolSettlementCoordinatorOptions,
} from "./durable/settlement-coordinator.js";
export {
  createDurableToolExecutionCoordinator,
  ToolCallBusyError,
  ToolExecutionAbortedError,
} from "./durable/durable-execution-coordinator.js";
export type {
  DurableInvocationExecutorFactory,
  DurablePreparedCallFactory,
  DurableRawOutputStore,
  DurableResultPipelineFactory,
  DurableToolBudgetPort,
  DurableToolExecutionCoordinator,
  DurableToolExecutionCoordinatorOptions,
  DurableToolExecutionOutcome,
  DurableToolExecutionRequest,
} from "./durable/durable-execution-coordinator.js";

/* The canonical Tool batch: request, item outcome, batch outcome, errors and the scheduler. */
export {
  AgentToolResultBatchError,
  ToolBatchInfrastructureError,
  ToolBatchInputError,
} from "./batch/batch-errors.js";
export type {
  AgentToolResultBatchErrorMetadata,
  AgentToolResultBatchErrorReason,
} from "./batch/batch-errors.js";
export { TOOL_BATCH_ITEM_OUTCOME_KINDS, TOOL_BATCH_OUTCOME_KINDS } from "./batch/batch-types.js";
export type {
  ToolBatchCoordinator,
  ToolBatchItemOutcome,
  ToolBatchOutcome,
  ToolBatchRequest,
} from "./batch/batch-types.js";
export {
  createToolBatchCoordinator,
  SKIPPED_AFTER_UNCERTAIN_CONTENT,
  SKIPPED_AFTER_UNCERTAIN_EXECUTION,
} from "./batch/batch-coordinator.js";
export type { ToolBatchCoordinatorOptions } from "./batch/batch-coordinator.js";

/*
 * The canonical model-facing Tool result exit: the batch normalizer and the feedback projector.
 *
 * `ToolResultBatchNormalizer` is the integrity defense and `ModelToolFeedbackProjector` is the safe
 * view; neither reads a raw execution result, and the projector's token-projection algorithm is
 * injected rather than reimplemented here.
 */
export { createToolResultBatchNormalizer } from "./observation/result-batch-normalizer.js";
export type { ToolResultBatchNormalizer } from "./observation/result-batch-normalizer.js";
export {
  createModelToolFeedbackProjector,
  MODEL_FEEDBACK_TRUNCATION_MARKER,
} from "./observation/model-feedback-projector.js";
export type {
  ModelObservationBatchProjector,
  ModelObservationCandidate,
  ModelToolFeedbackProjector,
  ModelToolFeedbackProjectorOptions,
} from "./observation/model-feedback-projector.js";
