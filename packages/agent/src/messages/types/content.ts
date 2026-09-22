import type { JsonObject } from "@caelush/ai";

/**
 * Agent message content parts.
 *
 * ```text
 * AgentTextPart                plain text
 * AgentAttachmentRefPart       a structured reference to an external artifact
 * AgentAssistantToolCallPart   a model's request to run a Tool
 * ```
 *
 * ## Text-first, deliberately
 *
 * Phase 5A keeps user content and Tool result content textual. The Message System V2
 * freeze says so explicitly, and the reason is that multimodal input is a *provider*
 * capability with a provider-specific wire shape: opening `AgentMessage` to image
 * blocks before the projection layer knows how to translate them would put a payload
 * into durable storage that no provider adapter could render.
 *
 * ## `AgentAttachmentRefPart` is a reference, not a payload
 *
 * It carries an artifact id and optional presentation hints. It does **not** carry
 * bytes, a host path, a signed URL or a base64 blob, and Phase 5A implements no upload,
 * no parser, no hydration and no provider image message. Its existence is what lets a
 * later round add attachment handling without changing the shape of a durable message,
 * because the durable message already says "this turn referenced an artifact" rather
 * than "this turn contained one".
 */

/** A text part. */
export interface AgentTextPart {
  readonly type: "TEXT";

  readonly text: string;
}

/**
 * A structured reference to an external artifact.
 *
 * ```text
 * artifactId   stable identity of the artifact, opaque to the Message Domain
 * label        optional human-facing name
 * mediaType    optional IANA media type
 * ```
 *
 * The Message Domain stores the reference and interprets none of it. It never resolves
 * an artifact, never reads one and never renders one; the projection layer decides how
 * a reference is described to a model, and it does so with a fixed, tested marker
 * rather than by embedding whatever the reference happens to contain.
 */
export interface AgentAttachmentRefPart {
  readonly type: "ATTACHMENT_REF";

  readonly artifactId: string;

  readonly label?: string;

  readonly mediaType?: string;
}

/** A text part of an assistant message. */
export interface AgentAssistantTextPart {
  readonly type: "TEXT";

  readonly text: string;
}

/**
 * A tool-call part of an assistant message.
 *
 * `input` is the canonical JSON-safe object shape the rest of the architecture already
 * uses — AI's `JsonObject`, which is the same JSON-safe value model Protocol restates.
 * There is deliberately no third business-JSON vocabulary in the Message Domain.
 */
export interface AgentAssistantToolCallPart {
  readonly type: "TOOL_CALL";

  readonly toolCallId: string;

  readonly toolName: string;

  readonly input: JsonObject;
}

/** What a user message may contain. */
export type AgentUserContentPart = AgentTextPart | AgentAttachmentRefPart;

/** What an assistant message may contain. */
export type AgentAssistantContentPart = AgentAssistantTextPart | AgentAssistantToolCallPart;

/** Every part type the Message Domain knows. */
export const AGENT_CONTENT_PART_TYPES = ["TEXT", "ATTACHMENT_REF", "TOOL_CALL"] as const;

/* -------------------------------------------------------------------------- builders */

/**
 * Build a text part.
 *
 * Frozen, so a caller that kept a reference to the input object cannot mutate a
 * message's content after the factory validated it.
 */
export function agentTextPart(text: string): AgentTextPart {
  return Object.freeze({ type: "TEXT", text });
}

/** Build an attachment reference part, omitting absent optional fields entirely. */
export function agentAttachmentRefPart(input: {
  readonly artifactId: string;
  readonly label?: string | undefined;
  readonly mediaType?: string | undefined;
}): AgentAttachmentRefPart {
  return Object.freeze({
    type: "ATTACHMENT_REF" as const,
    artifactId: input.artifactId,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
  });
}

/** Build an assistant text part. */
export function agentAssistantTextPart(text: string): AgentAssistantTextPart {
  return Object.freeze({ type: "TEXT", text });
}

/** Build an assistant tool-call part. */
export function agentAssistantToolCallPart(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: JsonObject;
}): AgentAssistantToolCallPart {
  return Object.freeze({
    type: "TOOL_CALL" as const,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    input: input.input,
  });
}

/* ----------------------------------------------------------------------------- guards */

/** True when a part is a non-empty text part. */
export function isMeaningfulTextPart(part: AgentUserContentPart): part is AgentTextPart {
  return part.type === "TEXT" && part.text.length > 0;
}

/** True when a part is a structurally usable attachment reference. */
export function isMeaningfulAttachmentRefPart(
  part: AgentUserContentPart,
): part is AgentAttachmentRefPart {
  return part.type === "ATTACHMENT_REF" && part.artifactId.length > 0;
}

/**
 * Assert that one user content list can describe a turn.
 *
 * Two rules, both structural:
 *
 * ```text
 * content.length >= 1
 * at least one part carries something: a non-empty TEXT or a valid ATTACHMENT_REF
 * ```
 *
 * The second rule is what stops an empty user turn from looking like a valid one. A
 * user message whose only content is `{ type: "TEXT", text: "" }` says nothing, and a
 * model shown it would answer a prompt the user never wrote.
 */
export function assertAgentUserContent(
  value: unknown,
): asserts value is readonly AgentUserContentPart[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Agent user message content must be a non-empty array.");
  }
  let meaningful = false;
  for (const part of value) {
    if (typeof part !== "object" || part === null || Array.isArray(part)) {
      throw new TypeError("Agent user message content part must be an object.");
    }
    const candidate = part as { readonly type?: unknown };
    if (candidate.type === "TEXT") {
      const text = (candidate as { readonly text?: unknown }).text;
      if (typeof text !== "string") {
        throw new TypeError("Agent user message text part text must be a string.");
      }
      if (text.length > 0) meaningful = true;
      continue;
    }
    if (candidate.type === "ATTACHMENT_REF") {
      const artifactId = (candidate as { readonly artifactId?: unknown }).artifactId;
      if (typeof artifactId !== "string" || artifactId.length === 0) {
        throw new TypeError("Agent user message attachment reference must name an artifact.");
      }
      assertOptionalString(candidate, "label", "Agent user message attachment reference");
      assertOptionalString(candidate, "mediaType", "Agent user message attachment reference");
      meaningful = true;
      continue;
    }
    throw new TypeError("Agent user message content part type is unknown.");
  }
  if (!meaningful) {
    throw new TypeError(
      "Agent user message content must carry non-empty text or an attachment reference.",
    );
  }
}

/**
 * Assert that one assistant content list can describe a model turn.
 *
 * ```text
 * content.length >= 1
 * every TOOL_CALL has a non-empty toolCallId and toolName and a JSON object input
 * toolCallId is unique within the message
 * ```
 *
 * The uniqueness rule is the one with teeth. Two Tool calls sharing an id in one
 * assistant message cannot be told apart by the Tool results that answer them, so the
 * batch would be ambiguous exactly where the model protocol requires an exact pairing.
 */
export function assertAgentAssistantContent(
  value: unknown,
): asserts value is readonly AgentAssistantContentPart[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Agent assistant message content must be a non-empty array.");
  }
  const toolCallIds = new Set<string>();
  for (const part of value) {
    if (typeof part !== "object" || part === null || Array.isArray(part)) {
      throw new TypeError("Agent assistant message content part must be an object.");
    }
    const candidate = part as { readonly type?: unknown };
    if (candidate.type === "TEXT") {
      const text = (candidate as { readonly text?: unknown }).text;
      if (typeof text !== "string") {
        throw new TypeError("Agent assistant message text part text must be a string.");
      }
      continue;
    }
    if (candidate.type === "TOOL_CALL") {
      const toolCall = candidate as {
        readonly toolCallId?: unknown;
        readonly toolName?: unknown;
        readonly input?: unknown;
      };
      if (typeof toolCall.toolCallId !== "string" || toolCall.toolCallId.length === 0) {
        throw new TypeError(
          "Agent assistant tool call part toolCallId must be a non-empty string.",
        );
      }
      if (typeof toolCall.toolName !== "string" || toolCall.toolName.length === 0) {
        throw new TypeError("Agent assistant tool call part toolName must be a non-empty string.");
      }
      if (typeof toolCall.input !== "object" || toolCall.input === null) {
        throw new TypeError("Agent assistant tool call part input must be an object.");
      }
      if (toolCallIds.has(toolCall.toolCallId)) {
        throw new TypeError("Agent assistant message must not announce the same toolCallId twice.");
      }
      toolCallIds.add(toolCall.toolCallId);
      continue;
    }
    throw new TypeError("Agent assistant message content part type is unknown.");
  }
}

/** Every tool call an assistant content list announces, in announcement order. */
export function assistantToolCalls(
  content: readonly AgentAssistantContentPart[],
): readonly AgentAssistantToolCallPart[] {
  return content.filter((part): part is AgentAssistantToolCallPart => part.type === "TOOL_CALL");
}

function assertOptionalString(candidate: object, field: string, label: string): void {
  const value = (candidate as Record<string, unknown>)[field];
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new TypeError(`${label} ${field} must be a string when present.`);
  }
}
