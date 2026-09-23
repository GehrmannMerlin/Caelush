import type {
  AssistantTranscriptEntry,
  CustomTranscriptEntry,
  ToolTranscriptEntry,
  TranscriptEntry,
  UserTranscriptEntry,
} from "@caelush/protocol";

import type { StoredAgentMessage } from "../persistence/record.js";
import type { AgentMessage } from "../types/agent-message.js";
import type { AgentAssistantMessage } from "../types/assistant-message.js";
import type { AgentToolResultMessage } from "../types/tool-result-message.js";
import type { AgentUserMessage } from "../types/user-message.js";

/** A product/domain projector from one durable Agent message to user transcript entries. */
export interface AgentMessageTranscriptProjector<TMessage extends AgentMessage = AgentMessage> {
  readonly type: string;
  project(stored: StoredAgentMessage<TMessage>): readonly TranscriptEntry[];
}

function transcriptId(messageId: string): string {
  return `${messageId}:transcript`;
}

function transcriptEnvelope(message: AgentMessage) {
  return {
    id: transcriptId(message.id),
    runId: message.runId,
    conversationTurnId: message.conversationTurnId,
    createdAt: message.createdAt,
  } as const;
}

function projectUser(stored: StoredAgentMessage<AgentUserMessage>): readonly UserTranscriptEntry[] {
  const message = stored.message;
  const text = message.content
    .filter((part): part is Extract<typeof part, { type: "TEXT" }> => part.type === "TEXT")
    .map((part) => part.text)
    .join("\n");
  const attachments = message.content
    .filter((part) => part.type === "ATTACHMENT_REF")
    .map((part) => ({
      artifactId: part.artifactId,
      ...(part.label === undefined ? {} : { label: part.label }),
      ...(part.mediaType === undefined ? {} : { mediaType: part.mediaType }),
    }));
  return [
    {
      ...transcriptEnvelope(message),
      kind: "USER",
      text,
      ...(attachments.length === 0 ? {} : { attachments }),
    },
  ];
}

function projectAssistant(
  stored: StoredAgentMessage<AgentAssistantMessage>,
): readonly AssistantTranscriptEntry[] {
  const message = stored.message;
  const text = message.content
    .filter((part): part is Extract<typeof part, { type: "TEXT" }> => part.type === "TEXT")
    .map((part) => part.text)
    .join("\n");
  return text.length === 0
    ? []
    : [
        {
          ...transcriptEnvelope(message),
          kind: "ASSISTANT",
          text,
        },
      ];
}

function projectToolResult(
  stored: StoredAgentMessage<AgentToolResultMessage>,
): readonly ToolTranscriptEntry[] {
  const message = stored.message;
  return [
    {
      ...transcriptEnvelope(message),
      kind: "TOOL_RESULT",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      text: message.projectedContent,
      isError: message.isError,
    },
  ];
}

export const AGENT_USER_MESSAGE_TRANSCRIPT_PROJECTOR: AgentMessageTranscriptProjector<AgentUserMessage> =
  {
    type: "USER",
    project: projectUser,
  };

export const AGENT_ASSISTANT_MESSAGE_TRANSCRIPT_PROJECTOR: AgentMessageTranscriptProjector<AgentAssistantMessage> =
  {
    type: "ASSISTANT",
    project: projectAssistant,
  };

export const AGENT_TOOL_RESULT_MESSAGE_TRANSCRIPT_PROJECTOR: AgentMessageTranscriptProjector<AgentToolResultMessage> =
  {
    type: "TOOL_RESULT",
    project: projectToolResult,
  };

export const STANDARD_AGENT_MESSAGE_TRANSCRIPT_PROJECTORS = [
  AGENT_USER_MESSAGE_TRANSCRIPT_PROJECTOR,
  AGENT_ASSISTANT_MESSAGE_TRANSCRIPT_PROJECTOR,
  AGENT_TOOL_RESULT_MESSAGE_TRANSCRIPT_PROJECTOR,
] as const;

export function unsupportedHistoricalTranscriptEntry(
  input: Pick<AgentMessage, "id" | "runId" | "conversationTurnId" | "createdAt">,
): CustomTranscriptEntry {
  return {
    id: transcriptId(input.id),
    runId: input.runId,
    conversationTurnId: input.conversationTurnId,
    createdAt: input.createdAt,
    kind: "CUSTOM",
    presentationType: "UNSUPPORTED_HISTORICAL_MESSAGE",
    label: "Unsupported historical message",
    text: "Unsupported historical message",
  };
}
