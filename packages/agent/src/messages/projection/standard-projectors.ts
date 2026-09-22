import type { AIConversationMessage } from "@caelush/ai";

import type { AgentUserMessage } from "../types/user-message.js";
import type { AgentAssistantMessage } from "../types/assistant-message.js";
import type { AgentToolResultMessage } from "../types/tool-result-message.js";
import { createAgentMessageAIProjection } from "./projector.js";
import type { AgentMessageProjector } from "./projector.js";

/**
 * The three standard projectors.
 *
 * ```text
 * USER v1          content parts → one user message
 * ASSISTANT v1     content parts → text and tool-call content, in order, plus provider state
 * TOOL_RESULT v1   projectedContent → one tool message, verbatim
 * ```
 *
 * Every projector here is pure, deterministic and provider-neutral. None of them imports
 * a provider adapter, reads a clock, or consults Storage, the Runtime or the network, and
 * a Phase 5A architecture guard asserts that the whole projection directory stays free of
 * provider-specific branching.
 */

/* --------------------------------------------------------------------------------- USER */

/**
 * The version of the user projection, and of the attachment marker it emits.
 *
 * The marker's format is part of what this version *means*: changing the marker changes
 * what a historical user message projects to, so it requires a new projector version
 * rather than an edit to this one.
 */
export const AGENT_USER_MESSAGE_PROJECTOR_VERSION = 1;

/**
 * The fixed, versioned marker an attachment reference projects to.
 *
 * ```text
 * [attachment v1 artifactId="<id>" label="<label>" mediaType="<media-type>"]
 * ```
 *
 * ## Why a marker rather than the attachment
 *
 * Phase 5A is text-first. A projector cannot turn an attachment reference into an image
 * block, a file part or an upload, because the provider multimodal contract is not open
 * and the bytes are not here. What it can do — and must do — is tell the model, honestly
 * and reproducibly, that the turn referenced an artifact. Silently dropping the reference
 * would lose the fact; embedding the artifact would invent a payload.
 *
 * ## Why the fields are escaped and the format is fixed
 *
 * `artifactId`, `label` and `mediaType` are caller-supplied strings that end up inside a
 * user message, so each is `JSON.stringify`-escaped: a label containing a quote or a
 * newline cannot break the marker's structure, and a label that contains a host path is
 * transmitted as *text the user wrote* rather than being interpreted. The projector adds
 * no path of its own, resolves no artifact and reads no file, so it cannot leak one.
 *
 * Absent optional fields are omitted entirely, so `label` and `mediaType` never appear as
 * empty strings that a model would have to interpret.
 */
export const AGENT_ATTACHMENT_MARKER_VERSION = "v1";

/** Render the canonical attachment marker for one reference. */
export function attachmentMarker(part: {
  readonly artifactId: string;
  readonly label?: string | undefined;
  readonly mediaType?: string | undefined;
}): string {
  const parts = [`artifactId=${JSON.stringify(part.artifactId)}`];
  if (part.label !== undefined) parts.push(`label=${JSON.stringify(part.label)}`);
  if (part.mediaType !== undefined) parts.push(`mediaType=${JSON.stringify(part.mediaType)}`);
  return `[attachment ${AGENT_ATTACHMENT_MARKER_VERSION} ${parts.join(" ")}]`;
}

/**
 * The canonical `USER` projector.
 *
 * One `AIUserMessage` whose content is the message's text parts in order, with each
 * attachment reference replaced by {@link attachmentMarker} *at its own position*. Order
 * is preserved because a user who wrote "look at this" *after* attaching a file meant
 * something different from one who attached it after writing.
 */
export const AGENT_USER_MESSAGE_PROJECTOR_V1: AgentMessageProjector<AgentUserMessage> = {
  type: "USER",
  version: AGENT_USER_MESSAGE_PROJECTOR_VERSION,
  project(message: AgentUserMessage) {
    const content = message.content
      .map((part) => (part.type === "TEXT" ? part.text : attachmentMarker(part)))
      .join("\n");
    return createAgentMessageAIProjection([{ role: "user", content }]);
  },
};

/* ---------------------------------------------------------------------------- ASSISTANT */

/** The version of the assistant projection. */
export const AGENT_ASSISTANT_MESSAGE_PROJECTOR_VERSION = 1;

/**
 * The canonical `ASSISTANT` projector.
 *
 * ```text
 * AgentAssistantTextPart       → { type: "text", text }
 * AgentAssistantToolCallPart   → { type: "tool-call", toolCallId, toolName, input }
 * ```
 *
 * ## Part order is the model's order
 *
 * The parts are mapped one-to-one and in place. A model that narrated before it called a
 * Tool is projected as a text part followed by a tool-call part; reordering would change
 * what the model said, and a compaction that later summarized this message would be
 * summarizing a different turn.
 *
 * ## `input` is handed over unchanged
 *
 * The tool-call input is the exact object the model produced. It is not re-validated,
 * re-serialized, defaulted or normalized here: the Tool layer already validated it at the
 * call boundary, and a second normalization would let the arguments the model is shown on
 * replay differ from the arguments that were actually executed.
 *
 * ## Provider state is carried, not interpreted
 *
 * It is copied onto the AI message when present and simply absent otherwise. A state
 * belonging to a different provider or API is still copied: deciding whether the receiving
 * dialect can use it is the adapter's job, and a projector that dropped it would destroy
 * continuity the provider issued.
 */
export const AGENT_ASSISTANT_MESSAGE_PROJECTOR_V1: AgentMessageProjector<AgentAssistantMessage> = {
  type: "ASSISTANT",
  version: AGENT_ASSISTANT_MESSAGE_PROJECTOR_VERSION,
  project(message: AgentAssistantMessage) {
    const content = message.content.map((part) =>
      part.type === "TEXT"
        ? ({ type: "text", text: part.text } as const)
        : ({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          } as const),
    );
    return createAgentMessageAIProjection([
      {
        role: "assistant",
        content,
        ...(message.providerState === undefined ? {} : { providerState: message.providerState }),
      },
    ]);
  },
};

/* -------------------------------------------------------------------------- TOOL_RESULT */

/** The version of the Tool result projection. */
export const AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_VERSION = 1;

/**
 * The canonical `TOOL_RESULT` projector.
 *
 * ```text
 * projectedContent   taken verbatim
 * ```
 *
 * ## Why the projection is a copy and not a computation
 *
 * `AgentToolResultMessage.projectedContent` **is** the text the model was shown when the
 * Tool settled. This projector copies it. It does not load the `ToolObservation` the
 * message points at, does not re-apply the observation policy, does not re-truncate and
 * does not re-sanitize.
 *
 * Every one of those would be a way to produce a *different* string on replay than the
 * one the model actually received, and the difference would be invisible: a message that
 * now says the output was truncated where the model was originally shown it in full, or
 * one that now leaks a region a later redaction rule would have removed. The
 * `observationId` on the message is a pointer of record for audit; it is not an
 * instruction to go and look something up.
 *
 * A Phase 5A test proves this by projecting a message whose `observationId` names an
 * observation that does not exist anywhere, and asserting the projection still succeeds
 * with the stored text.
 */
export const AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_V1: AgentMessageProjector<AgentToolResultMessage> =
  {
    type: "TOOL_RESULT",
    version: AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_VERSION,
    project(message: AgentToolResultMessage) {
      return createAgentMessageAIProjection([
        {
          role: "tool",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: message.projectedContent,
          isError: message.isError,
        },
      ]);
    },
  };

/** The three standard projectors, in canonical order. */
export const STANDARD_AGENT_MESSAGE_PROJECTORS = [
  AGENT_USER_MESSAGE_PROJECTOR_V1,
  AGENT_ASSISTANT_MESSAGE_PROJECTOR_V1,
  AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_V1,
] as const;

/** The projection version each standard message type is currently written under. */
export const STANDARD_AGENT_MESSAGE_PROJECTION_VERSIONS: Readonly<Record<string, number>> =
  Object.freeze({
    USER: AGENT_USER_MESSAGE_PROJECTOR_VERSION,
    ASSISTANT: AGENT_ASSISTANT_MESSAGE_PROJECTOR_VERSION,
    TOOL_RESULT: AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_VERSION,
  });

/** Every projected message has exactly this shape; used by the registry's integrity check. */
export function isValidProjectedConversation(messages: readonly AIConversationMessage[]): boolean {
  return messages.every(
    (message) => message.role === "user" || message.role === "assistant" || message.role === "tool",
  );
}
