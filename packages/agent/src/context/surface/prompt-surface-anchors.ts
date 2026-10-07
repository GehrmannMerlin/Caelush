import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type { AgentMessageId } from "../../messages/types/ids.js";
import { PromptSurfaceIntegrityError } from "./prompt-surface.js";
import type { PromptSurfaceAnchor } from "./prompt-surface.js";

/** Find complete Tool-safe boundaries, independently within each ConversationTurn. */
export function completePromptSurfaceAnchors(
  messages: readonly StoredAgentMessage[],
): ReadonlyMap<AgentMessageId, PromptSurfaceAnchor> {
  const messagesByTurn = new Map<string, StoredAgentMessage[]>();
  for (const stored of messages) {
    if (!stored.message.audience.model) continue;
    const scope = messageTurnScope(stored.message.runId, stored.message.conversationTurnId);
    const turnMessages = messagesByTurn.get(scope) ?? [];
    turnMessages.push(stored);
    messagesByTurn.set(scope, turnMessages);
  }

  const boundaries = new Map<AgentMessageId, PromptSurfaceAnchor>();
  for (const turnMessages of messagesByTurn.values()) {
    const turnBoundaries = completeTurnAnchors(turnMessages);
    for (const [messageId, anchor] of turnBoundaries) {
      const previous = boundaries.get(messageId);
      if (previous !== undefined && !samePromptSurfaceAnchor(previous, anchor)) {
        throw new PromptSurfaceIntegrityError("Prompt Surface message identity is ambiguous.");
      }
      boundaries.set(messageId, anchor);
    }
  }
  return boundaries;
}

/** Return the latest complete boundary in the caller's canonical Snapshot order. */
export function latestCompletePromptSurfaceAnchor(
  messages: readonly StoredAgentMessage[],
): PromptSurfaceAnchor {
  const boundaries = completePromptSurfaceAnchors(messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const stored = messages[index]!;
    const anchor = boundaries.get(stored.message.id);
    if (anchor !== undefined) return anchor;
  }
  throw new PromptSurfaceIntegrityError(
    "Prompt Surface cannot anchor without a complete model-visible message boundary.",
  );
}

/** Validate persisted anchors against their exact durable messages and Turn scope. */
export function promptSurfaceAnchorsAreAvailable(
  messages: readonly StoredAgentMessage[],
  anchors: readonly PromptSurfaceAnchor[],
): boolean {
  const boundaries = completePromptSurfaceAnchors(messages);
  return anchors.every((anchor) => {
    const boundary = boundaries.get(anchor.messageId);
    return boundary !== undefined && samePromptSurfaceAnchor(boundary, anchor);
  });
}

/** Compare anchors only by their positions in a canonical message list, never by local sequence. */
export function comparePromptSurfaceAnchorOrder(
  messages: readonly StoredAgentMessage[],
  left: PromptSurfaceAnchor,
  right: PromptSurfaceAnchor,
): number {
  const boundaries = completePromptSurfaceAnchors(messages);
  const positions = new Map<AgentMessageId, number>();
  messages.forEach((stored, index) => positions.set(stored.message.id, index));
  const leftBoundary = boundaries.get(left.messageId);
  const rightBoundary = boundaries.get(right.messageId);
  const leftPosition = positions.get(left.messageId);
  const rightPosition = positions.get(right.messageId);
  if (
    leftBoundary === undefined ||
    rightBoundary === undefined ||
    leftPosition === undefined ||
    rightPosition === undefined ||
    !samePromptSurfaceAnchor(leftBoundary, left) ||
    !samePromptSurfaceAnchor(rightBoundary, right)
  ) {
    throw new PromptSurfaceIntegrityError("Prompt Surface anchor identity is unavailable.");
  }
  return leftPosition - rightPosition;
}

function completeTurnAnchors(
  messages: readonly StoredAgentMessage[],
): ReadonlyMap<AgentMessageId, PromptSurfaceAnchor> {
  const boundaries = new Map<AgentMessageId, PromptSurfaceAnchor>();
  let previousSequence = 0;
  let pendingBatch:
    | {
        readonly assistantMessageId: AgentMessageId;
        readonly runId: string;
        readonly conversationTurnId: string;
        readonly assistantByCallId: Map<string, AgentMessageId>;
      }
    | undefined;

  for (const stored of messages) {
    if (stored.sequence <= previousSequence) {
      throw new PromptSurfaceIntegrityError(
        "Prompt Surface messages are not ordered within their ConversationTurn.",
      );
    }
    previousSequence = stored.sequence;
    const message = stored.message;
    if (pendingBatch !== undefined) {
      if (
        message.runId !== pendingBatch.runId ||
        message.conversationTurnId !== pendingBatch.conversationTurnId
      ) {
        throw new PromptSurfaceIntegrityError(
          "Prompt Surface Tool batch escaped its Run and ConversationTurn scope.",
        );
      }
      if (message.type === "ASSISTANT") {
        throw new PromptSurfaceIntegrityError(
          "Prompt Surface conversation has an incomplete Tool batch.",
        );
      }
      if (message.type === "TOOL_RESULT") {
        if (
          pendingBatch.assistantByCallId.get(message.toolCallId) !== pendingBatch.assistantMessageId
        ) {
          throw new PromptSurfaceIntegrityError(
            "Prompt Surface conversation has an unmatched Tool result.",
          );
        }
        pendingBatch.assistantByCallId.delete(message.toolCallId);
        if (pendingBatch.assistantByCallId.size === 0) {
          boundaries.set(message.id, anchorFor(stored));
          pendingBatch = undefined;
        }
      }
      continue;
    }

    if (message.type === "ASSISTANT") {
      const callIds = message.content
        .filter((part) => part.type === "TOOL_CALL")
        .map((part) => part.toolCallId);
      if (callIds.length > 0) {
        if (new Set(callIds).size !== callIds.length) {
          throw new PromptSurfaceIntegrityError(
            "Prompt Surface assistant Tool calls are not unique.",
          );
        }
        pendingBatch = {
          assistantMessageId: message.id,
          runId: message.runId,
          conversationTurnId: message.conversationTurnId,
          assistantByCallId: new Map(callIds.map((callId) => [callId, message.id])),
        };
        continue;
      }
    }
    if (message.type === "TOOL_RESULT") {
      throw new PromptSurfaceIntegrityError(
        "Prompt Surface conversation has an unmatched Tool result.",
      );
    }
    boundaries.set(message.id, anchorFor(stored));
  }

  return boundaries;
}

function anchorFor(stored: StoredAgentMessage): PromptSurfaceAnchor {
  return Object.freeze({
    messageId: stored.message.id,
    runId: stored.message.runId,
    conversationTurnId: stored.message.conversationTurnId,
    sequence: stored.sequence,
  });
}

function samePromptSurfaceAnchor(left: PromptSurfaceAnchor, right: PromptSurfaceAnchor): boolean {
  return (
    left.messageId === right.messageId &&
    left.runId === right.runId &&
    left.conversationTurnId === right.conversationTurnId &&
    left.sequence === right.sequence
  );
}

function messageTurnScope(runId: string, conversationTurnId: string): string {
  return JSON.stringify([runId, conversationTurnId]);
}
