import type {
  AgentAssistantContentPart,
  AgentModelTurn,
  AgentMessage,
  AgentMessageCodecRegistry,
  AgentMessageFactory,
  AgentMessageProjectorRegistry,
  AgentMessageRecordDraft,
  AgentConversationRepository,
  ConversationTurnIdFactory,
  ToolFeedbackProjectionReceipt,
  ToolResultObservationRef,
} from "@caelush/agent";
import {
  NO_TOOL_RESULT_OBSERVATION,
  agentAssistantTextPart,
  agentAssistantToolCallPart,
  agentTextPart,
  modelMessageSource,
  toolMessageSource,
  fingerprintProjection,
  toolFeedbackPolicySnapshot,
  userMessageSource,
} from "@caelush/agent";
import type { AIToolResultMessage } from "@caelush/ai";
import type { ToolObservationPolicySnapshot } from "@caelush/agent";
import type { AgentRun, StepId } from "@caelush/protocol";

import type { RunAgentMessageProjection } from "./run-agent-history.js";
import type { RunExecutionMessageAppend } from "./run-execution-store.js";

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
    content: [agentTextPart(run.goal)],
  });
  return appendFromMessage(authority, message);
}

export function createAssistantMessageAppend(
  authority: RunMessageAuthority,
  run: AgentRun,
  sourceStepId: StepId,
  modelTurn: AgentModelTurn,
): RunExecutionMessageAppend {
  const message = authority.factory.createAssistant({
    runId: run.id,
    sessionId: run.sessionId,
    conversationTurnId: authority.turns.forRun(run.id),
    sourceStepId,
    source: modelMessageSource(modelTurn.callId),
    content: assistantContent(modelTurn),
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
  return appendFromMessage(authority, message);
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
    projectedContent: projected.message.content,
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
  return Object.freeze({ draft: Object.freeze(draft) });
}

function assistantContent(modelTurn: AgentModelTurn): readonly AgentAssistantContentPart[] {
  const content: AgentAssistantContentPart[] = [];
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
  return Object.freeze(content);
}
