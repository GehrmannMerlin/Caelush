/**
 * `@caelush/agent` — the Message Domain.
 *
 * ```text
 * types/         AgentMessage, its identity, audience, source, content and factory
 * persistence/   the durable record contracts — no storage, no SQL, no schema
 * codec/         versioned durable encoding
 * projection/    the model view, versioned and provider-neutral
 * conversation/  turns, snapshots, validation, execution units, selection
 * ```
 *
 * The Message Domain is deliberately pure: it imports `@caelush/ai` for the model-facing
 * message language and `@caelush/protocol` for identity and time, and nothing else. It has
 * no SQLite, no daemon, no filesystem, no provider, no Runtime and no Context dependency, so
 * it can be exercised — created, encoded, decoded, projected, validated and selected — with
 * no host at all. The Phase 5A independent-use test does exactly that.
 */

/* --------------------------------------------------------------------------------- types */

export {
  createAgentMessageIdFactory,
  createConversationTurnIdFactory,
  createDeterministicConversationTurnIdFactory,
  deriveLegacyAgentMessageId,
  createScriptedAgentMessageIdFactory,
  createSeededConversationTurnIdFactory,
  agentMessageId,
  conversationTurnId,
  isAgentMessageId,
  isConversationTurnId,
  AGENT_MESSAGE_ID_PREFIX,
  CONVERSATION_TURN_ID_PREFIX,
} from "./types/ids.js";
export type {
  AgentMessageId,
  AgentMessageIdFactory,
  ConversationTurnId,
  ConversationTurnIdFactory,
} from "./types/ids.js";

export {
  assertAgentMessageAudience,
  AGENT_ASSISTANT_MESSAGE_AUDIENCE,
  AGENT_MESSAGE_AUDIENCE_FIELDS,
  AGENT_TOOL_RESULT_MESSAGE_AUDIENCE,
  AGENT_USER_MESSAGE_AUDIENCE,
} from "./types/audience.js";
export type { AgentMessageAudience } from "./types/audience.js";

export {
  assertAgentMessageSource,
  legacyMessageSource,
  modelMessageSource,
  toolMessageSource,
  userMessageSource,
  AGENT_LEGACY_ROLES,
  AGENT_MESSAGE_SOURCE_KINDS,
  AGENT_USER_MESSAGE_ORIGINS,
  TOOL_MESSAGE_SOURCE,
} from "./types/source.js";
export type { AgentMessageSource } from "./types/source.js";

export {
  agentAssistantTextPart,
  agentAssistantToolCallPart,
  agentAttachmentRefPart,
  agentTextPart,
  assistantToolCalls,
  assertAgentAssistantContent,
  assertAgentUserContent,
  isMeaningfulAttachmentRefPart,
  isMeaningfulTextPart,
  AGENT_CONTENT_PART_TYPES,
} from "./types/content.js";
export type {
  AgentAssistantContentPart,
  AgentAssistantTextPart,
  AgentAssistantToolCallPart,
  AgentAttachmentRefPart,
  AgentTextPart,
  AgentUserContentPart,
} from "./types/content.js";

export { createAgentMessageBase } from "./types/message-base.js";
export type { AgentMessageBase } from "./types/message-base.js";

export { createAgentUserMessage } from "./types/user-message.js";
export type { AgentUserMessage } from "./types/user-message.js";

export { createAgentAssistantMessage } from "./types/assistant-message.js";
export type {
  AgentAssistantMessage,
  AgentAssistantModelProvenance,
} from "./types/assistant-message.js";

export {
  assertToolFeedbackProjectionPolicy,
  createAgentToolResultMessage,
  toolFeedbackPolicySnapshot,
  toolResultObservationId,
  LEGACY_UNKNOWN_TOOL_FEEDBACK_POLICY,
  TOOL_FEEDBACK_PROJECTION_POLICY_KINDS,
  TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION,
} from "./types/tool-result-message.js";
export type {
  AgentToolResultMessage,
  ToolFeedbackProjectionPolicy,
  ToolFeedbackProjectionReceipt,
} from "./types/tool-result-message.js";

export {
  assertToolResultObservationRef,
  hasToolResultObservation,
  toolResultObservation,
  NO_TOOL_RESULT_OBSERVATION,
  TOOL_RESULT_OBSERVATION_REF_KINDS,
} from "./types/tool-result-observation.js";
export type { ToolResultObservationRef } from "./types/tool-result-observation.js";

export type { CustomAgentMessages } from "./types/custom-agent-messages.js";

export { agentMessageType, AGENT_MESSAGE_TYPES } from "./types/agent-message.js";
export type { AgentMessage, AgentMessageType } from "./types/agent-message.js";

export { createAgentMessageFactory } from "./types/message-factory.js";
export type {
  AgentMessageFactory,
  AgentMessageFactoryDependencies,
  AgentMessageScope,
  CreateAgentAssistantMessageInput,
  CreateAgentToolResultMessageInput,
  CreateAgentUserMessageInput,
} from "./types/message-factory.js";

export {
  canonicalJsonText,
  canonicalize,
  digestJsonObject,
  digestJsonValue,
} from "./canonical-json.js";

/* --------------------------------------------------------------------------- persistence */

export {
  assertAgentMessageProjectionVersion,
  assertAgentMessageSchemaVersion,
  assertAgentMessageSequence,
  OPAQUE_AGENT_MESSAGE_REASONS,
} from "./persistence/record.js";
export type {
  AgentMessageDraft,
  AgentMessageProjectionVersion,
  AgentMessageRecord,
  AgentMessageRecordDraft,
  AgentMessageSchemaVersion,
  OpaqueAgentMessageReason,
  OpaqueAgentMessageRecord,
  StoredAgentMessage,
} from "./persistence/record.js";

export type {
  AgentMessageRecordStorePort,
  SessionReadableAgentMessageRecordStore,
} from "./persistence/record-store-port.js";

export { createAgentConversationRepository } from "./persistence/conversation-repository.js";
export type {
  AgentConversationRepository,
  AgentConversationRepositoryDependencies,
  ConversationRunMetadataReader,
} from "./persistence/conversation-repository.js";

/* --------------------------------------------------------------------------------- codec */

export {
  AgentMessageCodecError,
  agentMessageCodecErrorMessage,
  AGENT_MESSAGE_CODEC_ERROR_REASONS,
} from "./codec/codec.js";
export type { AgentMessageCodec, AgentMessageCodecErrorReason } from "./codec/codec.js";

export {
  AGENT_ASSISTANT_MESSAGE_CODEC_V1,
  AGENT_TOOL_RESULT_MESSAGE_CODEC_V1,
  AGENT_USER_MESSAGE_CODEC_V1,
  assertJsonSafePayload,
  STANDARD_AGENT_MESSAGE_CODECS,
} from "./codec/standard-codecs.js";

export {
  createAgentMessageCodecRegistry,
  AgentMessageCodecRegistryError,
  agentMessageCodecRegistryErrorMessage,
  projectionVersionTable,
} from "./codec/registry.js";
export type {
  AgentMessageCodecRegistry,
  AgentMessageCodecRegistryBuilder,
  AgentMessageCodecRegistryErrorReason,
  AgentMessageProjectionVersionResolver,
} from "./codec/registry.js";

export {
  createAgentMessageCodecRegistryBuilder,
  createStandardAgentMessageCodecRegistry,
  DefaultAgentMessageCodecRegistryBuilder,
} from "./codec/registry-builder.js";

/* ---------------------------------------------------------------------------- projection */

export {
  createAgentMessageAIProjection,
  fingerprintProjection,
  EMPTY_AGENT_MESSAGE_AI_PROJECTION,
} from "./projection/projector.js";
export type { AgentMessageAIProjection, AgentMessageProjector } from "./projection/projector.js";

export {
  AgentMessageProjectionError,
  agentMessageProjectionErrorMessage,
  AGENT_MESSAGE_PROJECTION_ERROR_CODES,
} from "./projection/errors.js";
export type { AgentMessageProjectionErrorCode } from "./projection/errors.js";

export {
  attachmentMarker,
  isValidProjectedConversation,
  AGENT_ASSISTANT_MESSAGE_PROJECTOR_V1,
  AGENT_ATTACHMENT_MARKER_VERSION,
  AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_V1,
  AGENT_USER_MESSAGE_PROJECTOR_V1,
  STANDARD_AGENT_MESSAGE_PROJECTION_VERSIONS,
  STANDARD_AGENT_MESSAGE_PROJECTORS,
} from "./projection/standard-projectors.js";

export {
  assertProjectionFingerprint,
  createAgentMessageProjectorRegistry,
  createStandardAgentMessageProjectorRegistry,
  projectStoredMessages,
} from "./projection/registry.js";
export type {
  AgentMessageProjectionVersionAuthority,
  AgentMessageProjectorRegistry,
  AgentMessageProjectorRegistryWithVersions,
} from "./projection/registry.js";

/* -------------------------------------------------------------------------- conversation */

export {
  conversationTurnStatus,
  createConversationTurn,
  CONVERSATION_TURN_STATUSES,
} from "./conversation/conversation-turn.js";
export type { ConversationTurn, ConversationTurnStatus } from "./conversation/conversation-turn.js";

export {
  createAgentConversationSnapshot,
  createSingleTurnConversationSnapshot,
} from "./conversation/conversation-snapshot.js";
export type { AgentConversationSnapshot } from "./conversation/conversation-snapshot.js";

export {
  AgentConversationError,
  AgentConversationLoadError,
  agentConversationErrorMessage,
  agentConversationLoadFailureMessage,
  createAgentConversationValidator,
  AGENT_CONVERSATION_VIOLATION_REASONS,
} from "./conversation/validator.js";
export type {
  AgentConversationLoadFailureReason,
  AgentConversationValidator,
  AgentConversationViolationReason,
} from "./conversation/validator.js";

export {
  buildConversationExecutionUnits,
  buildExecutionUnits,
  executionUnitId,
  isCompactionCandidate,
} from "./conversation/execution-unit.js";
export type { ExecutionUnit } from "./conversation/execution-unit.js";

export { STRUCTURAL_TOKEN_ESTIMATOR } from "./conversation/token-estimator.js";
export type { TokenEstimator } from "./conversation/token-estimator.js";

export { createConversationSelector } from "./conversation/selector.js";
export type {
  ConversationSelector,
  ConversationSelectorOptions,
  SelectedAgentConversation,
} from "./conversation/selector.js";
