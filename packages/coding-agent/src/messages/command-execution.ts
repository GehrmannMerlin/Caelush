import type { JsonObject } from "@caelush/ai";
import {
  AgentMessageCodecError,
  createAgentMessageAIProjection,
  type AgentMessageBase,
  type AgentMessageCodec,
  type AgentMessageProjector,
  type AgentMessageTranscriptProjector,
} from "@caelush/agent";
import type { CustomTranscriptEntry } from "@caelush/protocol";

/** A Coding product message for a completed local command execution. */
export interface CodingCommandExecutionMessage extends AgentMessageBase {
  readonly type: "CODING_COMMAND_EXECUTION";
  readonly command: string;
  readonly output: string;
  readonly exitCode?: number;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  readonly fullOutputArtifactId?: string;
}

declare module "@caelush/agent" {
  interface CustomAgentMessages {
    CODING_COMMAND_EXECUTION: CodingCommandExecutionMessage;
  }
}

const MAX_AI_COMMAND_CHARS = 2_000;
const MAX_AI_OUTPUT_CHARS = 12_000;
const MAX_TRANSCRIPT_COMMAND_CHARS = 1_000;
const MAX_TRANSCRIPT_OUTPUT_CHARS = 8_000;

function sanitizeAndBound(value: string, maxChars: number): string {
  // The transcript/AI boundary replaces non-printing controls before any public projection.
  // eslint-disable-next-line no-control-regex
  const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
  return value.replace(controlCharacters, "�").slice(0, maxChars);
}

function commandExecutionText(message: CodingCommandExecutionMessage): string {
  const command = sanitizeAndBound(message.command, MAX_AI_COMMAND_CHARS);
  const output = sanitizeAndBound(message.output, MAX_AI_OUTPUT_CHARS);
  const status = message.cancelled
    ? "cancelled"
    : message.exitCode === undefined
      ? "completed"
      : `exit code ${String(message.exitCode)}`;
  return `Command execution (${status})\n$ ${command}\n${output}`;
}

export const CODING_COMMAND_EXECUTION_MESSAGE_CODEC_V1: AgentMessageCodec<CodingCommandExecutionMessage> =
  {
    type: "CODING_COMMAND_EXECUTION",
    currentVersion: 1,
    canDecode(version) {
      return version === 1;
    },
    encode(message): JsonObject {
      return {
        command: message.command,
        output: message.output,
        ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
        cancelled: message.cancelled,
        truncated: message.truncated,
        ...(message.fullOutputArtifactId === undefined
          ? {}
          : { fullOutputArtifactId: message.fullOutputArtifactId }),
      };
    },
    decode(record) {
      if (record.messageType !== "CODING_COMMAND_EXECUTION" || record.schemaVersion !== 1) {
        throw new AgentMessageCodecError(
          "IDENTITY_MISMATCH",
          "CODING_COMMAND_EXECUTION",
          record.schemaVersion,
        );
      }
      const command = requireString(record.data, "command");
      const output = requireString(record.data, "output");
      const exitCode = record.data.exitCode;
      if (exitCode !== undefined && (typeof exitCode !== "number" || !Number.isFinite(exitCode))) {
        throw new AgentMessageCodecError("INVALID_RECORD", "CODING_COMMAND_EXECUTION", 1);
      }
      const cancelled = requireBoolean(record.data, "cancelled");
      const truncated = requireBoolean(record.data, "truncated");
      const fullOutputArtifactId = record.data.fullOutputArtifactId;
      if (fullOutputArtifactId !== undefined && typeof fullOutputArtifactId !== "string") {
        throw new AgentMessageCodecError("INVALID_RECORD", "CODING_COMMAND_EXECUTION", 1);
      }
      const base: AgentMessageBase = {
        id: record.messageId,
        runId: record.runId,
        sessionId: record.sessionId,
        conversationTurnId: record.conversationTurnId,
        createdAt: record.createdAt,
        ...(record.sourceStepId === undefined ? {} : { sourceStepId: record.sourceStepId }),
        source: record.source,
        audience: record.audience,
      };
      return Object.freeze({
        ...base,
        type: "CODING_COMMAND_EXECUTION" as const,
        command,
        output,
        ...(exitCode === undefined ? {} : { exitCode }),
        cancelled,
        truncated,
        ...(fullOutputArtifactId === undefined ? {} : { fullOutputArtifactId }),
      });
    },
  };

export const CODING_COMMAND_EXECUTION_MESSAGE_PROJECTOR_V1: AgentMessageProjector<CodingCommandExecutionMessage> =
  {
    type: "CODING_COMMAND_EXECUTION",
    version: 1,
    project(message) {
      return createAgentMessageAIProjection([
        {
          role: "assistant",
          content: [{ type: "text", text: commandExecutionText(message) }],
        },
      ]);
    },
  };

export const CODING_COMMAND_EXECUTION_TRANSCRIPT_PROJECTOR: AgentMessageTranscriptProjector<CodingCommandExecutionMessage> =
  {
    type: "CODING_COMMAND_EXECUTION",
    project(input) {
      const message = input.message;
      const entry: CustomTranscriptEntry = {
        id: `${message.id}:transcript`,
        runId: message.runId,
        conversationTurnId: message.conversationTurnId,
        createdAt: message.createdAt,
        kind: "CUSTOM",
        presentationType: "COMMAND_EXECUTION",
        label: sanitizeAndBound(message.command, MAX_TRANSCRIPT_COMMAND_CHARS),
        text: sanitizeAndBound(message.output, MAX_TRANSCRIPT_OUTPUT_CHARS),
        metadata: {
          ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
          cancelled: message.cancelled,
          truncated: message.truncated,
        },
      };
      return [entry];
    },
  };

function requireString(data: JsonObject, field: string): string {
  const value = data[field];
  if (typeof value !== "string") {
    throw new AgentMessageCodecError("INVALID_RECORD", "CODING_COMMAND_EXECUTION", 1);
  }
  return value;
}

function requireBoolean(data: JsonObject, field: string): boolean {
  const value = data[field];
  if (typeof value !== "boolean") {
    throw new AgentMessageCodecError("INVALID_RECORD", "CODING_COMMAND_EXECUTION", 1);
  }
  return value;
}
