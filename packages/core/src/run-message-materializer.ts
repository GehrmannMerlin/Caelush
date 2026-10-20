import type {
  AgentAssistantContentPart,
  AgentModelTurn,
  AgentMessage,
  AgentMessageCodecRegistry,
  AgentMessageFactory,
  AgentMessageProjectorRegistry,
  AgentMessageRecordDraft,
  AgentConversationRepository,
  PrivateReplayIdentity,
  ConversationTurnIdFactory,
  ToolFeedbackProjectionReceipt,
  ToolPreparationFailureFact,
  ToolResultObservationRef,
} from "@caelush/agent";
import {
  NO_TOOL_RESULT_OBSERVATION,
  agentAssistantTextPart,
  agentAssistantToolCallPart,
  agentAttachmentRefPart,
  agentTextPart,
  modelMessageSource,
  toolMessageSource,
  fingerprintProjection,
  toolFeedbackPolicySnapshot,
  userMessageSource,
  createPrivateReplayReference,
} from "@caelush/agent";
import type { AIMessagePhase, AIToolResultMessage } from "@caelush/ai";
import type { ToolObservationPolicySnapshot } from "@caelush/agent";
import {
  AttachmentIdSchema,
  type AgentRun,
  type AssistantMessagePhase,
  type StepId,
} from "@caelush/protocol";
import type { AttachmentModelContentReference } from "@caelush/protocol";

import type { RunAgentMessageProjection } from "./run-agent-history.js";
import type { RunExecutionMessageAppend } from "./run-execution-store.js";
import { toTextOnlyAIToolResultContent } from "./ai-message-content.js";

/** One canonical message authority composed by the daemon and injected into Core. */
export interface RunMessageAuthority extends RunAgentMessageProjection {
  readonly factory: AgentMessageFactory;
  readonly turns: ConversationTurnIdFactory;
  readonly codecs: AgentMessageCodecRegistry;
  readonly projectors: AgentMessageProjectorRegistry;
  /** The semantic V2 conversation loader used by Context and replay. */
  readonly conversation: AgentConversationRepository;
  userOrigin(run: AgentRun): Promise<"GOAL" | "FOLLOW_UP">;
}

/** Core-private Tool feedback facts needed to create a durable TOOL_RESULT. */
export interface RunToolFeedbackProjection {
  readonly message: AIToolResultMessage;
  readonly receipt: ToolFeedbackProjectionReceipt;
  readonly observation: ToolResultObservationRef;
  readonly attachmentReferences?: readonly AttachmentModelContentReference[] | undefined;
  /**
   * The bounded fact that this call was refused before execution by its declared schema.
   *
   * It travels with the projection so the durable message can carry it; it is never part of the
   * model-visible text, which stays exactly what the model was shown.
   */
  readonly preparationFailure?: ToolPreparationFailureFact | undefined;
}

export function createUserMessageAppend(
  authority: RunMessageAuthority,
  run: AgentRun,
  origin: "GOAL" | "FOLLOW_UP",
): RunExecutionMessageAppend {
  const message = authority.factory.createUser({
    runId: run.id,
    sessionId: run.sessionId,
    conversationTurnId: authority.turns.forRun(run.id),
    source: userMessageSource(origin),
    content: [
      agentTextPart(run.userText ?? run.goal),
      ...(run.attachmentIds ?? []).map((artifactId) => agentAttachmentRefPart({ artifactId })),
    ],
  });
  return appendFromMessage(authority, message);
}

/**
 * Materialize one accepted Run input as the canonical USER message it becomes.
 *
 * ```text
 * text            the input's own durable text, never `run.goal` or `run.userText`
 * origin          STEERING — this is the user correcting the Run already in progress
 * turn            the Run's existing conversation turn, because it is the same task
 * ```
 *
 * The message identity is minted here and returned to the caller, which writes it into the input
 * ledger in the *same* transaction. That is what keeps one input and one message provably paired.
 */
export function createSteeringMessageAppend(
  authority: RunMessageAuthority,
  run: AgentRun,
  text: string,
): { readonly append: RunExecutionMessageAppend; readonly messageId: string } {
  const message = authority.factory.createUser({
    runId: run.id,
    sessionId: run.sessionId,
    conversationTurnId: authority.turns.forRun(run.id),
    source: userMessageSource("STEERING"),
    content: [agentTextPart(text)],
  });
  return { append: appendFromMessage(authority, message), messageId: message.id };
}

export function createAssistantMessageAppend(
  authority: RunMessageAuthority,
  run: AgentRun,
  sourceStepId: StepId,
  modelTurn: AgentModelTurn,
  phase: AssistantMessagePhase,
): RunExecutionMessageAppend {
  return appendFromMessage(
    authority,
    createAssistantMessage(authority, run, sourceStepId, modelTurn, phase),
  );
}

/**
 * Materialize an answer that would have been final, but is being deferred for a correction.
 *
 * ```text
 * envelope phase             COMMENTARY
 * every explicit part phase  COMMENTARY
 * ```
 *
 * Both are required. The assistant projector prefers an explicit content-segment phase over the
 * envelope, so rewriting only `data.phase` would leave the deferred text presented as the Run's
 * final answer — a lie the completion transaction did not commit. The model's text, identity,
 * usage and private replay provenance are untouched.
 */
export function createDeferredAssistantMessageAppend(
  authority: RunMessageAuthority,
  run: AgentRun,
  sourceStepId: StepId,
  modelTurn: AgentModelTurn,
): RunExecutionMessageAppend {
  return appendFromMessage(
    authority,
    createAssistantMessage(authority, run, sourceStepId, modelTurn, "COMMENTARY", true),
  );
}

/** Create the same Assistant record with an opaque private replay reference bound to its real ID. */
export function createAssistantMessageAppendWithPrivateReplay(
  authority: RunMessageAuthority,
  run: AgentRun,
  sourceStepId: StepId,
  modelTurn: AgentModelTurn,
  phase: AssistantMessagePhase,
  replay: Pick<PrivateReplayIdentity, "providerId" | "model" | "api">,
  options: { readonly forceCommentarySegments?: boolean } = {},
): { readonly append: RunExecutionMessageAppend; readonly identity: PrivateReplayIdentity } {
  const message = createAssistantMessage(
    authority,
    run,
    sourceStepId,
    modelTurn,
    phase,
    options.forceCommentarySegments === true,
  );
  const identity: PrivateReplayIdentity = Object.freeze({
    sessionId: String(run.sessionId),
    runId: String(run.id),
    messageId: String(message.id),
    callId: modelTurn.callId,
    providerId: replay.providerId,
    model: replay.model,
    api: replay.api,
    replayVersion: 1,
  });
  const withReference = Object.freeze({
    ...message,
    providerState: createPrivateReplayReference(identity),
  });
  return Object.freeze({ append: appendFromMessage(authority, withReference), identity });
}

function createAssistantMessage(
  authority: RunMessageAuthority,
  run: AgentRun,
  sourceStepId: StepId,
  modelTurn: AgentModelTurn,
  phase: AssistantMessagePhase,
  forceCommentarySegments = false,
) {
  return authority.factory.createAssistant({
    runId: run.id,
    sessionId: run.sessionId,
    conversationTurnId: authority.turns.forRun(run.id),
    sourceStepId,
    source: modelMessageSource(modelTurn.callId),
    phase,
    content: assistantContent(modelTurn, forceCommentarySegments),
    model: {
      kind: "MODEL_TURN",
      callId: modelTurn.callId,
      model: modelTurn.model,
      finishReason: modelTurn.finishReason,
      ...(modelTurn.usage === undefined ? {} : { usage: modelTurn.usage }),
    },
    ...(modelTurn.assistantMessage.providerState === undefined
      ? {}
      : { providerState: modelTurn.assistantMessage.providerState }),
  });
}

export function createToolResultMessageAppend(
  authority: RunMessageAuthority,
  run: AgentRun,
  sourceStepId: StepId,
  projected: RunToolFeedbackProjection,
): RunExecutionMessageAppend {
  const message = authority.factory.createToolResult({
    runId: run.id,
    sessionId: run.sessionId,
    conversationTurnId: authority.turns.forRun(run.id),
    sourceStepId,
    source: toolMessageSource(),
    toolCallId: projected.message.toolCallId,
    toolName: projected.message.toolName,
    observation: projected.observation,
    isError: projected.message.isError,
    projectedContent: toTextOnlyAIToolResultContent(projected.message.content),
    ...(projected.attachmentReferences === undefined
      ? {}
      : { attachmentReferences: projected.attachmentReferences }),
    ...(projected.preparationFailure === undefined
      ? {}
      : { preparationFailure: projected.preparationFailure }),
    projection: projected.receipt,
  });
  return appendFromMessage(authority, message);
}

/** Materialize an externally supplied Tool Result before the resumed provider turn. */
export function createExternalToolResultMessageAppend(
  authority: RunMessageAuthority,
  run: AgentRun,
  sourceStepId: StepId,
  message: AIToolResultMessage,
  policy: ToolObservationPolicySnapshot,
): RunExecutionMessageAppend {
  return createToolResultMessageAppend(authority, run, sourceStepId, {
    message,
    receipt: Object.freeze({
      policy: toolFeedbackPolicySnapshot(policy),
      fingerprint: fingerprintProjection([message]),
      version: 1,
    }),
    observation: NO_TOOL_RESULT_OBSERVATION,
  });
}

function appendFromMessage(
  authority: RunMessageAuthority,
  message: AgentMessage,
): RunExecutionMessageAppend {
  const encoded = authority.codecs.encode(message);
  const draft: AgentMessageRecordDraft = {
    messageId: message.id,
    sessionId: message.sessionId,
    conversationTurnId: message.conversationTurnId,
    messageType: message.type,
    schemaVersion: encoded.schemaVersion,
    ...(encoded.modelProjectionVersion === undefined
      ? {}
      : { modelProjectionVersion: encoded.modelProjectionVersion }),
    ...(message.sourceStepId === undefined ? {} : { sourceStepId: message.sourceStepId }),
    createdAt: message.createdAt,
    source: message.source,
    audience: message.audience,
    data: encoded.data,
  };
  const attachmentIds =
    message.type === "USER"
      ? message.content.flatMap((part) =>
          part.type === "ATTACHMENT_REF" ? [AttachmentIdSchema.parse(part.artifactId)] : [],
        )
      : [];
  return Object.freeze({
    draft: Object.freeze(draft),
    ...(attachmentIds.length === 0 ? {} : { attachmentIds: Object.freeze(attachmentIds) }),
  });
}

function assistantContent(
  modelTurn: AgentModelTurn,
  forceCommentarySegments = false,
): readonly AgentAssistantContentPart[] {
  const content: AgentAssistantContentPart[] = [];
  if (modelTurn.assistantItems !== undefined) {
    for (const item of modelTurn.assistantItems) {
      const metadata = {
        assistantItemId: item.assistantItemId,
        phase: forceCommentarySegments
          ? ("COMMENTARY" as const)
          : toProtocolAssistantPhase(item.phase),
      };
      for (const part of item.content) {
        if (part.type === "text") {
          content.push(agentAssistantTextPart(part.text, metadata));
        } else {
          content.push(
            agentAssistantToolCallPart({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              ...metadata,
            }),
          );
        }
      }
    }
  } else {
    for (const part of modelTurn.assistantMessage.content) {
      if (part.type === "text") {
        content.push(agentAssistantTextPart(part.text));
      } else {
        content.push(
          agentAssistantToolCallPart({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          }),
        );
      }
    }
  }
  return Object.freeze(content);
}

function toProtocolAssistantPhase(phase: AIMessagePhase): AssistantMessagePhase {
  switch (phase) {
    case "COMMENTARY":
      return "COMMENTARY";
    case "FINAL_ANSWER":
      return "FINAL_ANSWER";
    case "UNKNOWN":
      return "UNKNOWN";
  }
}
