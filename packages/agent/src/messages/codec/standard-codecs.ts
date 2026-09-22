import { isJsonObject } from "@caelush/ai";
import type {
  AIFinishReason,
  AIProviderOpaqueState,
  JsonObject,
  JsonValue,
  ModelRef,
  ModelUsage,
} from "@caelush/ai";
import type { ObservationId, RunId, SessionId, StepId, TimestampMs } from "@caelush/protocol";

import type { AgentUserContentPart } from "../types/content.js";
import type { AgentAssistantContentPart } from "../types/content.js";
import type { AgentAssistantModelProvenance } from "../types/assistant-message.js";
import type {
  ToolFeedbackProjectionPolicy,
  ToolFeedbackProjectionReceipt,
} from "../types/tool-result-message.js";
import {
  LEGACY_UNKNOWN_TOOL_FEEDBACK_POLICY,
  TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION,
  toolFeedbackPolicySnapshot,
} from "../types/tool-result-message.js";
import { NO_TOOL_RESULT_OBSERVATION } from "../types/tool-result-observation.js";
import type { ToolResultObservationRef } from "../types/tool-result-observation.js";
import type { AgentUserMessage } from "../types/user-message.js";
import type { AgentAssistantMessage } from "../types/assistant-message.js";
import type { AgentToolResultMessage } from "../types/tool-result-message.js";
import type { AgentMessageAudience } from "../types/audience.js";
import type { AgentMessageSource } from "../types/source.js";
import { agentMessageId, conversationTurnId } from "../types/ids.js";
import { createAgentMessageBase } from "../types/message-base.js";
import { createAgentUserMessage } from "../types/user-message.js";
import { createAgentAssistantMessage } from "../types/assistant-message.js";
import { createAgentToolResultMessage } from "../types/tool-result-message.js";
import type { AgentMessageRecord, AgentMessageSchemaVersion } from "../persistence/record.js";
import type { AgentMessageCodec } from "./codec.js";
import { AgentMessageCodecError } from "./codec.js";

/**
 * The three standard codecs, one per canonical message type.
 *
 * ```text
 * USER v1          data = { content }
 * ASSISTANT v1     data = { content, model, providerState? }
 * TOOL_RESULT v1   data = { toolCallId, toolName, observation, isError, projectedContent, projection }
 * ```
 *
 * ## The envelope is never repeated in `data`
 *
 * `runId`, `sessionId`, `conversationTurnId`, `sourceStepId`, `createdAt`, `source` and
 * `audience` live on {@link AgentMessageRecord} and are read from there on decode. They
 * are deliberately absent from every payload above: one fact, one location, so an
 * envelope and a payload can never disagree about which Run or which turn a message
 * belongs to.
 *
 * ## Deterministic by construction
 *
 * No codec reads a clock, a random source, an environment variable or a locale. The key
 * order of every payload is fixed by the literal below, and `createdAt` is copied from
 * the message rather than re-read, so encoding the same message twice produces
 * byte-identical JSON. Phase 5A tests exactly that.
 *
 * ## Decoding an envelope is a validation, not a cast
 *
 * {@link decodeEnvelope} checks that the record really forms a well-formed message: the
 * identity is well-formed, the scope strings are non-empty, the sequence and versions
 * satisfy their invariants, and the source and audience have the right shape. A record
 * that fails is refused rather than half-read, because a message assembled from a
 * partially valid row would be indistinguishable from a real one afterwards.
 */

/* --------------------------------------------------------------------------------- USER */

/** The canonical `USER` codec. */
export const AGENT_USER_MESSAGE_CODEC_V1: AgentMessageCodec<AgentUserMessage> = {
  type: "USER",
  currentVersion: 1,
  canDecode(version: AgentMessageSchemaVersion): boolean {
    return version === 1;
  },
  encode(message: AgentUserMessage): JsonObject {
    return { content: message.content.map(encodeUserContentPart) };
  },
  decode(record: AgentMessageRecord): AgentUserMessage {
    const base = decodeEnvelope(record, "USER", 1);
    return createAgentUserMessage(base, decodeUserContent(record.data));
  },
};

/* ---------------------------------------------------------------------------- ASSISTANT */

/** The canonical `ASSISTANT` codec. */
export const AGENT_ASSISTANT_MESSAGE_CODEC_V1: AgentMessageCodec<AgentAssistantMessage> = {
  type: "ASSISTANT",
  currentVersion: 1,
  canDecode(version: AgentMessageSchemaVersion): boolean {
    return version === 1;
  },
  encode(message: AgentAssistantMessage): JsonObject {
    return {
      content: message.content.map(encodeAssistantContentPart),
      model: encodeModelProvenance(message.model),
      // Absent, never `null`: a provider state that does not exist must not become a
      // present-but-empty field that a later reader has to special-case.
      ...(message.providerState === undefined
        ? {}
        : { providerState: encodeProviderState(message.providerState) }),
    };
  },
  decode(record: AgentMessageRecord): AgentAssistantMessage {
    const base = decodeEnvelope(record, "ASSISTANT", 1);
    const content = decodeAssistantContent(record.data);
    const model = decodeModelProvenance(record.data["model"], record);
    const providerState = decodeProviderState(record.data["providerState"]);
    return createAgentAssistantMessage(base, content, model, providerState);
  },
};

/* -------------------------------------------------------------------------- TOOL_RESULT */

/** The canonical `TOOL_RESULT` codec. */
export const AGENT_TOOL_RESULT_MESSAGE_CODEC_V1: AgentMessageCodec<AgentToolResultMessage> = {
  type: "TOOL_RESULT",
  currentVersion: 1,
  canDecode(version: AgentMessageSchemaVersion): boolean {
    return version === 1;
  },
  encode(message: AgentToolResultMessage): JsonObject {
    return {
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      // The corrected provenance pair. `observation` says whether a real execution stands behind
      // this feedback; `projection.policy` says whether the policy it was projected under is known.
      observation:
        message.observation.kind === "OBSERVATION"
          ? { kind: "OBSERVATION", observationId: message.observation.observationId }
          : { kind: "NO_OBSERVATION" },
      isError: message.isError,
      projectedContent: message.projectedContent,
      projection: {
        policy:
          message.projection.policy.kind === "SNAPSHOT"
            ? {
                kind: "SNAPSHOT",
                snapshot: {
                  maxSingleObservationTokens:
                    message.projection.policy.snapshot.maxSingleObservationTokens,
                  maxObservationBatchTokens:
                    message.projection.policy.snapshot.maxObservationBatchTokens,
                },
              }
            : { kind: "LEGACY_UNKNOWN" },
        fingerprint: message.projection.fingerprint,
        version: message.projection.version,
      },
    };
  },
  decode(record: AgentMessageRecord): AgentToolResultMessage {
    const base = decodeEnvelope(record, "TOOL_RESULT", 1);
    return createAgentToolResultMessage(base, {
      toolCallId: requireString(record.data, "toolCallId", "TOOL_RESULT"),
      toolName: requireString(record.data, "toolName", "TOOL_RESULT"),
      observation: decodeObservationRef(record.data["observation"]),
      isError: requireBoolean(record.data, "isError", "TOOL_RESULT"),
      // Copied verbatim. The decoder never re-reads an observation and never re-truncates:
      // this text is what the model was shown, and recomputing it would replace history.
      projectedContent: requireString(record.data, "projectedContent", "TOOL_RESULT"),
      projection: decodeProjectionReceipt(record.data["projection"]),
    });
  },
};

/** The three standard codecs, in canonical order. */
export const STANDARD_AGENT_MESSAGE_CODECS = [
  AGENT_USER_MESSAGE_CODEC_V1,
  AGENT_ASSISTANT_MESSAGE_CODEC_V1,
  AGENT_TOOL_RESULT_MESSAGE_CODEC_V1,
] as const;

/* ------------------------------------------------------------------------------ envelope */

/**
 * Rebuild the message base from a record, refusing anything that is not a real message.
 *
 * The `messageType` and schema-version checks are the codec's *identity* obligation: a
 * codec that decoded a record belonging to another codec would produce a message whose
 * type disagrees with the row it came from.
 */
function decodeEnvelope(record: AgentMessageRecord, type: string, version: number) {
  if (record.messageType !== type) {
    throw new AgentMessageCodecError("IDENTITY_MISMATCH", type, record.schemaVersion);
  }
  if (record.schemaVersion !== version) {
    throw new AgentMessageCodecError("UNSUPPORTED_SCHEMA_VERSION", type, record.schemaVersion);
  }
  try {
    return createAgentMessageBase({
      id: agentMessageId(requireNonEmpty(record.messageId, "messageId", type)),
      runId: requireNonEmpty(record.runId, "runId", type) as RunId,
      sessionId: requireNonEmpty(record.sessionId, "sessionId", type) as SessionId,
      conversationTurnId: conversationTurnId(
        requireNonEmpty(record.conversationTurnId, "conversationTurnId", type),
      ),
      createdAt: requireTimestamp(record.createdAt, type),
      ...(record.sourceStepId === undefined
        ? {}
        : { sourceStepId: requireNonEmpty(record.sourceStepId, "sourceStepId", type) as StepId }),
      source: decodeSource(record.source, type),
      audience: decodeAudience(record.audience, type),
    });
  } catch (error) {
    if (error instanceof AgentMessageCodecError) throw error;
    throw new AgentMessageCodecError("INVALID_RECORD", type, record.schemaVersion);
  }
}

function decodeAudience(value: unknown, type: string): AgentMessageAudience {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentMessageCodecError("INVALID_RECORD", type);
  }
  const candidate = value as Record<string, unknown>;
  for (const field of ["model", "transcript", "debug"] as const) {
    if (typeof candidate[field] !== "boolean") {
      throw new AgentMessageCodecError("INVALID_RECORD", type);
    }
  }
  return {
    model: candidate["model"] as boolean,
    transcript: candidate["transcript"] as boolean,
    debug: candidate["debug"] as boolean,
  };
}

function decodeSource(value: unknown, type: string): AgentMessageSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentMessageCodecError("INVALID_RECORD", type);
  }
  const candidate = value as Record<string, unknown>;
  switch (candidate["kind"]) {
    case "USER": {
      const origin = candidate["origin"];
      if (origin !== "GOAL" && origin !== "FOLLOW_UP" && origin !== "STEERING") {
        throw new AgentMessageCodecError("INVALID_RECORD", type);
      }
      return { kind: "USER", origin };
    }
    case "MODEL":
      return { kind: "MODEL", callId: requireNonEmpty(candidate["callId"], "source.callId", type) };
    case "TOOL":
      // The corrected TOOL arm carries no field. Whether this feedback has a real execution behind
      // it lives on the message body as `observation`, so the envelope states provenance only.
      return { kind: "TOOL" };
    case "AGENT":
      return {
        kind: "AGENT",
        producer: requireNonEmpty(candidate["producer"], "source.producer", type),
      };
    case "LEGACY": {
      const legacyRole = candidate["legacyRole"];
      if (legacyRole !== "user" && legacyRole !== "assistant" && legacyRole !== "tool") {
        throw new AgentMessageCodecError("INVALID_RECORD", type);
      }
      return { kind: "LEGACY", legacyRole };
    }
    default:
      throw new AgentMessageCodecError("INVALID_RECORD", type);
  }
}

/* ----------------------------------------------------------------------------- user data */

function encodeUserContentPart(part: AgentUserContentPart): JsonValue {
  if (part.type === "TEXT") return { type: "TEXT", text: part.text };
  return {
    type: "ATTACHMENT_REF",
    artifactId: part.artifactId,
    ...(part.label === undefined ? {} : { label: part.label }),
    ...(part.mediaType === undefined ? {} : { mediaType: part.mediaType }),
  };
}

function decodeUserContent(data: JsonObject): readonly AgentUserContentPart[] {
  const content = data["content"];
  if (!Array.isArray(content) || content.length === 0) {
    throw new AgentMessageCodecError("INVALID_RECORD", "USER");
  }
  return content.map((part) => {
    if (!isJsonObject(part)) throw new AgentMessageCodecError("INVALID_RECORD", "USER");
    if (part["type"] === "TEXT") {
      const text = part["text"];
      if (typeof text !== "string") throw new AgentMessageCodecError("INVALID_RECORD", "USER");
      return { type: "TEXT" as const, text };
    }
    if (part["type"] === "ATTACHMENT_REF") {
      const artifactId = part["artifactId"];
      if (typeof artifactId !== "string" || artifactId.length === 0) {
        throw new AgentMessageCodecError("INVALID_RECORD", "USER");
      }
      const label = part["label"];
      const mediaType = part["mediaType"];
      if (label !== undefined && typeof label !== "string") {
        throw new AgentMessageCodecError("INVALID_RECORD", "USER");
      }
      if (mediaType !== undefined && typeof mediaType !== "string") {
        throw new AgentMessageCodecError("INVALID_RECORD", "USER");
      }
      return {
        type: "ATTACHMENT_REF" as const,
        artifactId,
        ...(label === undefined ? {} : { label }),
        ...(mediaType === undefined ? {} : { mediaType }),
      };
    }
    throw new AgentMessageCodecError("INVALID_RECORD", "USER");
  });
}

/* ------------------------------------------------------------------------ assistant data */

function encodeAssistantContentPart(part: AgentAssistantContentPart): JsonValue {
  if (part.type === "TEXT") return { type: "TEXT", text: part.text };
  return {
    type: "TOOL_CALL",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
  };
}

function decodeAssistantContent(data: JsonObject): readonly AgentAssistantContentPart[] {
  const content = data["content"];
  if (!Array.isArray(content) || content.length === 0) {
    throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
  }
  return content.map((part) => {
    if (!isJsonObject(part)) throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
    if (part["type"] === "TEXT") {
      const text = part["text"];
      if (typeof text !== "string") {
        throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
      }
      return { type: "TEXT" as const, text };
    }
    if (part["type"] === "TOOL_CALL") {
      const toolCallId = part["toolCallId"];
      const toolName = part["toolName"];
      const input = part["input"];
      if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
      }
      if (typeof toolName !== "string" || toolName.length === 0) {
        throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
      }
      if (!isJsonObject(input)) throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
      return { type: "TOOL_CALL" as const, toolCallId, toolName, input };
    }
    throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
  });
}

function encodeModelProvenance(model: AgentAssistantModelProvenance): JsonValue {
  if (model.kind === "LEGACY_MODEL_TURN") {
    return {
      kind: "LEGACY_MODEL_TURN",
      ...(model.sourceStepId === undefined ? {} : { sourceStepId: model.sourceStepId }),
    };
  }
  return {
    kind: "MODEL_TURN",
    callId: model.callId,
    model: {
      provider: model.model.provider,
      model: model.model.model,
      ...(model.model.baseUrl === undefined ? {} : { baseUrl: model.model.baseUrl }),
    },
    finishReason: model.finishReason,
    ...(model.usage === undefined ? {} : { usage: encodeUsage(model.usage) }),
  };
}

function decodeModelProvenance(
  value: unknown,
  record: AgentMessageRecord,
): AgentAssistantModelProvenance {
  if (!isJsonObject(value)) throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
  if (value["kind"] === "LEGACY_MODEL_TURN") {
    const sourceStepId = value["sourceStepId"];
    if (sourceStepId !== undefined && typeof sourceStepId !== "string") {
      throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
    }
    return {
      kind: "LEGACY_MODEL_TURN",
      ...(sourceStepId === undefined ? {} : { sourceStepId: sourceStepId as StepId }),
    };
  }
  if (value["kind"] !== "MODEL_TURN") {
    throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
  }
  const callId = value["callId"];
  if (typeof callId !== "string" || callId.length === 0) {
    throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT", record.schemaVersion);
  }
  const model = value["model"];
  if (!isJsonObject(model)) {
    throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT", record.schemaVersion);
  }
  const provider = model["provider"];
  const modelName = model["model"];
  const baseUrl = model["baseUrl"];
  if (typeof provider !== "string" || provider.length === 0) {
    throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT", record.schemaVersion);
  }
  if (typeof modelName !== "string" || modelName.length === 0) {
    throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT", record.schemaVersion);
  }
  if (baseUrl !== undefined && typeof baseUrl !== "string") {
    throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT", record.schemaVersion);
  }
  const finishReason = value["finishReason"];
  if (!isFinishReason(finishReason)) {
    throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT", record.schemaVersion);
  }
  const usage = decodeUsage(value["usage"]);
  const modelRef: ModelRef = {
    provider,
    model: modelName,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
  return {
    kind: "MODEL_TURN",
    callId,
    model: modelRef,
    finishReason,
    ...(usage === undefined ? {} : { usage }),
  };
}

const FINISH_REASONS: readonly AIFinishReason[] = [
  "STOP",
  "LENGTH",
  "TOOL_CALLS",
  "CONTENT_FILTER",
  "OTHER",
];

function isFinishReason(value: unknown): value is AIFinishReason {
  return typeof value === "string" && (FINISH_REASONS as readonly string[]).includes(value);
}

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "reasoningTokens",
] as const satisfies readonly (keyof ModelUsage)[];

function encodeUsage(usage: ModelUsage): JsonValue {
  const encoded: Record<string, JsonValue> = {};
  for (const field of USAGE_FIELDS) {
    const count = usage[field];
    if (count !== undefined) encoded[field] = count;
  }
  return encoded;
}

function decodeUsage(value: unknown): ModelUsage | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
  const usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  } = {};
  for (const field of USAGE_FIELDS) {
    const count = value[field];
    if (count === undefined) continue;
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
    }
    usage[field] = count as number;
  }
  return usage;
}

/* --------------------------------------------------------------------- provider state data */

function encodeProviderState(state: AIProviderOpaqueState): JsonValue {
  // The payload is copied structurally, never inspected: the Message Domain has no idea
  // what is inside it and must not acquire one.
  return {
    providerId: state.providerId,
    api: state.api,
    version: state.version,
    payload: state.payload,
  };
}

function decodeProviderState(value: unknown): AIProviderOpaqueState | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
  const providerId = value["providerId"];
  const api = value["api"];
  const version = value["version"];
  const payload = value["payload"];
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
  }
  if (typeof api !== "string" || api.length === 0) {
    throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
  }
  if (version !== 1) throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
  if (!isJsonObject(payload)) throw new AgentMessageCodecError("INVALID_RECORD", "ASSISTANT");
  return { providerId, api, version: 1, payload };
}

/* ------------------------------------------------------------------- tool result specifics */

/**
 * Decode the observation provenance arm.
 *
 * Strictly a union on the wire as well as in the type: a reader must be able to tell "a real execution
 * stands behind this" from "no execution does", and an unrecognised or malformed arm is refused rather
 * than silently treated as either. In particular `NO_OBSERVATION` is never inferred from a missing
 * field, because a missing field is exactly the ambiguity the union exists to remove.
 */
function decodeObservationRef(value: unknown): ToolResultObservationRef {
  if (!isJsonObject(value)) throw new AgentMessageCodecError("INVALID_RECORD", "TOOL_RESULT");
  if (value["kind"] === "NO_OBSERVATION") return NO_TOOL_RESULT_OBSERVATION;
  if (value["kind"] === "OBSERVATION") {
    const observationId = value["observationId"];
    if (typeof observationId !== "string" || observationId.length === 0) {
      throw new AgentMessageCodecError("INVALID_RECORD", "TOOL_RESULT");
    }
    return { kind: "OBSERVATION", observationId: observationId as ObservationId };
  }
  throw new AgentMessageCodecError("INVALID_RECORD", "TOOL_RESULT");
}

/**
 * Decode the projection receipt, including the policy provenance arm.
 *
 * `LEGACY_UNKNOWN` is a legal stored value — it is what a migrated row carries — and it decodes to the
 * shared frozen arm. It is never produced by a normal factory, which is a *creation* rule, not a
 * decoding rule: a reader must be able to read every record that was legitimately written.
 */
function decodeProjectionReceipt(value: unknown): ToolFeedbackProjectionReceipt {
  if (!isJsonObject(value)) throw new AgentMessageCodecError("INVALID_RECORD", "TOOL_RESULT");
  const policy = decodeProjectionPolicy(value["policy"]);
  const fingerprint = value["fingerprint"];
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    throw new AgentMessageCodecError("INVALID_RECORD", "TOOL_RESULT");
  }
  if (value["version"] !== TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION) {
    throw new AgentMessageCodecError("INVALID_RECORD", "TOOL_RESULT");
  }
  return {
    policy,
    fingerprint,
    version: TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION,
  };
}

function decodeProjectionPolicy(value: unknown): ToolFeedbackProjectionPolicy {
  if (!isJsonObject(value)) throw new AgentMessageCodecError("INVALID_RECORD", "TOOL_RESULT");
  if (value["kind"] === "LEGACY_UNKNOWN") return LEGACY_UNKNOWN_TOOL_FEEDBACK_POLICY;
  if (value["kind"] !== "SNAPSHOT") {
    throw new AgentMessageCodecError("INVALID_RECORD", "TOOL_RESULT");
  }
  const snapshot = value["snapshot"];
  if (!isJsonObject(snapshot)) throw new AgentMessageCodecError("INVALID_RECORD", "TOOL_RESULT");
  const single = snapshot["maxSingleObservationTokens"];
  const batch = snapshot["maxObservationBatchTokens"];
  if (!Number.isSafeInteger(single) || (single as number) < 1) {
    throw new AgentMessageCodecError("INVALID_RECORD", "TOOL_RESULT");
  }
  if (!Number.isSafeInteger(batch) || (batch as number) < 1) {
    throw new AgentMessageCodecError("INVALID_RECORD", "TOOL_RESULT");
  }
  return toolFeedbackPolicySnapshot({
    maxSingleObservationTokens: single as number,
    maxObservationBatchTokens: batch as number,
  });
}

/* -------------------------------------------------------------------------------- helpers */

function requireNonEmpty(value: unknown, field: string, type: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentMessageCodecError("INVALID_RECORD", type);
  }
  return value;
}

function requireString(data: JsonObject, field: string, type: string): string {
  const value = data[field];
  if (typeof value !== "string") throw new AgentMessageCodecError("INVALID_RECORD", type);
  return value;
}

function requireBoolean(data: JsonObject, field: string, type: string): boolean {
  const value = data[field];
  if (typeof value !== "boolean") throw new AgentMessageCodecError("INVALID_RECORD", type);
  return value;
}

function requireTimestamp(value: unknown, type: string): TimestampMs {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentMessageCodecError("INVALID_RECORD", type);
  }
  return value as TimestampMs;
}

/**
 * A structural check that a codec payload is JSON-safe before it is stored.
 *
 * Exported because the registry applies it to every encode result: a codec that returned
 * a function, a `Date` or a `NaN` would produce a payload that `JSON.stringify` silently
 * mangles, and the corruption would only appear on the next read.
 */
export function assertJsonSafePayload(value: unknown, type: string): asserts value is JsonObject {
  if (!isJsonObject(value)) {
    throw new AgentMessageCodecError("INVALID_RECORD", type);
  }
}
