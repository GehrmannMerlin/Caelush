import type { JsonObject, JsonValue } from "@caelush/ai";

import { canonicalJsonText } from "../../messages/canonical-json.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type {
  AgentAssistantContentPart,
  AgentUserContentPart,
} from "../../messages/types/content.js";
import type { StructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";
import type { ContextMessageRange } from "./context-compaction-contracts.js";
import type { ContextCompactionCut } from "./context-compaction-cut.js";

export interface CompactionSemanticSource {
  readonly previousCheckpoint?: StructuredCheckpoint;
  readonly sourceMessages: readonly StoredAgentMessage[];
  readonly sourceRange: ContextMessageRange;
  readonly cut: ContextCompactionCut;
}

export interface SummarySourcePolicy {
  readonly includeAssistantText: true;
  readonly includeToolCalls: true;
  readonly includeToolResultProjectedContent: true;
  readonly includeRawToolOutput: false;
  readonly includeHiddenChainOfThought: false;
}

export const SUMMARY_SOURCE_POLICY: SummarySourcePolicy = Object.freeze({
  includeAssistantText: true,
  includeToolCalls: true,
  includeToolResultProjectedContent: true,
  includeRawToolOutput: false,
  includeHiddenChainOfThought: false,
});

export interface ContextSummarySourceSerializer {
  readonly policy: SummarySourcePolicy;
  serialize(input: CompactionSemanticSource): string;
}

export function createContextSummarySourceSerializer(): ContextSummarySourceSerializer {
  return Object.freeze({
    policy: SUMMARY_SOURCE_POLICY,
    serialize(input: CompactionSemanticSource): string {
      const value: JsonObject = {
        framing: {
          sourceMessages: "UNTRUSTED_DATA",
          toolResultContent: "UNTRUSTED_DATA",
          previousCheckpoint: "RECOVERY_MEMORY",
          previousCheckpointAuthority: "NOT_CURRENT_AUTHORITY",
        },
        policy: SUMMARY_SOURCE_POLICY as unknown as JsonObject,
        sourceRange: serializeRange(input.sourceRange),
        cut: serializeCut(input.cut),
        previousCheckpoint:
          input.previousCheckpoint === undefined
            ? null
            : {
                framing: "RECOVERY_MEMORY",
                authority: "NOT_CURRENT_AUTHORITY",
                checkpoint: serializeCheckpoint(input.previousCheckpoint),
              },
        sourceMessages: input.sourceMessages.map(serializeStoredMessage),
      };
      return canonicalJsonText(value);
    },
  });
}

function serializeStoredMessage(stored: StoredAgentMessage): JsonObject {
  const message = stored.message;
  const base: JsonObject = {
    messageId: message.id,
    runId: message.runId,
    conversationTurnId: message.conversationTurnId,
    sequence: stored.sequence,
    schemaVersion: stored.schemaVersion,
    modelProjectionVersion: stored.modelProjectionVersion ?? null,
    type: message.type,
  };
  if (message.type === "USER") {
    return {
      ...base,
      content: message.content.map(serializeUserPart),
    };
  }
  if (message.type === "ASSISTANT") {
    return {
      ...base,
      content: message.content.map(serializeAssistantPart),
    };
  }
  if (message.type === "TOOL_RESULT") {
    return {
      ...base,
      toolCallId: message.toolCallId,
      toolName: redactText(message.toolName),
      isError: message.isError,
      observationKind: message.observation.kind,
      projectedContent: redactText(message.projectedContent),
    };
  }
  return base;
}

function serializeUserPart(part: AgentUserContentPart): JsonObject {
  if (part.type === "TEXT") return { type: part.type, text: redactText(part.text) };
  return {
    type: part.type,
    artifactId: redactText(part.artifactId),
    ...(part.label === undefined ? {} : { label: redactText(part.label) }),
    ...(part.mediaType === undefined ? {} : { mediaType: redactText(part.mediaType) }),
  };
}

function serializeAssistantPart(part: AgentAssistantContentPart): JsonObject {
  if (part.type === "TEXT") return { type: part.type, text: redactText(part.text) };
  return {
    type: part.type,
    toolCallId: part.toolCallId,
    toolName: redactText(part.toolName),
    input: redactJsonValue(part.input),
  };
}

function serializeRange(range: ContextMessageRange): JsonObject {
  return {
    runId: range.runId,
    conversationTurnId: range.conversationTurnId,
    firstMessageId: range.firstMessageId,
    lastMessageId: range.lastMessageId,
    firstSequence: range.firstSequence,
    lastSequence: range.lastSequence,
  };
}

function serializeCut(cut: ContextCompactionCut): JsonObject {
  return Object.fromEntries(
    Object.entries(cut).map(([key, value]) => [
      key,
      typeof value === "string" ? redactText(value) : value,
    ]),
  ) as JsonObject;
}

function serializeCheckpoint(checkpoint: StructuredCheckpoint): JsonObject {
  return {
    version: checkpoint.version,
    goal: redactText(checkpoint.goal),
    constraints: checkpoint.constraints.map(redactText),
    completedWork: checkpoint.completedWork.map(redactText),
    inProgress: checkpoint.inProgress.map(redactText),
    blocked: checkpoint.blocked.map(redactText),
    importantDiscoveries: checkpoint.importantDiscoveries.map(redactText),
    keyDecisions: checkpoint.keyDecisions.map(redactText),
    changedFiles: checkpoint.changedFiles.map(redactText),
    readFiles: checkpoint.readFiles.map(redactText),
    recentErrors: checkpoint.recentErrors.map(redactText),
    verificationState: redactText(checkpoint.verificationState),
    activeProcesses: checkpoint.activeProcesses.map(redactText),
    pendingApprovals: checkpoint.pendingApprovals.map(redactText),
    resourceGovernance: redactText(checkpoint.resourceGovernance),
    criticalReferences: checkpoint.criticalReferences.map(redactText),
    nextIntent: redactText(checkpoint.nextIntent),
    sourceRange: {
      from: checkpoint.sourceRange.from,
      to: checkpoint.sourceRange.to,
    },
  };
}

function redactJsonValue(value: JsonValue, key?: string): JsonValue {
  if (typeof value === "string") {
    return isCredentialKey(key) ? "[REDACTED]" : redactText(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item));
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, JsonValue> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = redactJsonValue(childValue, childKey);
  }
  return result;
}

function isCredentialKey(value: string | undefined): boolean {
  return (
    value !== undefined && /^(?:api[_-]?key|authorization|password|secret|token)$/i.test(value)
  );
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}
