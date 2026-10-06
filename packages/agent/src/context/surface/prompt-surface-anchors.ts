import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import { PromptSurfaceIntegrityError } from "./prompt-surface.js";

/** Find durable sequence boundaries that keep each assistant Tool call with its complete result batch. */
export function completePromptSurfaceAnchorSequences(
  messages: readonly StoredAgentMessage[],
): ReadonlySet<number> {
  const ordered = [...messages]
    .filter((stored) => stored.message.audience.model)
    .sort((left, right) => left.sequence - right.sequence);
  const boundaries = new Set<number>();
  let pendingCallIds: Set<string> | undefined;

  for (const stored of ordered) {
    const message = stored.message;
    if (pendingCallIds !== undefined) {
      if (message.type === "ASSISTANT") {
        throw new PromptSurfaceIntegrityError(
          "Prompt Surface conversation has an incomplete Tool batch.",
        );
      }
      if (message.type === "TOOL_RESULT") {
        if (!pendingCallIds.delete(message.toolCallId)) {
          throw new PromptSurfaceIntegrityError(
            "Prompt Surface conversation has an unmatched Tool result.",
          );
        }
        if (pendingCallIds.size === 0) {
          boundaries.add(stored.sequence);
          pendingCallIds = undefined;
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
        pendingCallIds = new Set(callIds);
        continue;
      }
    }
    if (message.type === "TOOL_RESULT") {
      throw new PromptSurfaceIntegrityError(
        "Prompt Surface conversation has an unmatched Tool result.",
      );
    }
    boundaries.add(stored.sequence);
  }

  return boundaries;
}

export function latestCompletePromptSurfaceAnchor(messages: readonly StoredAgentMessage[]): number {
  const boundaries = completePromptSurfaceAnchorSequences(messages);
  const latest = Math.max(0, ...boundaries);
  if (latest < 1) {
    throw new PromptSurfaceIntegrityError(
      "Prompt Surface cannot anchor without a complete model-visible message boundary.",
    );
  }
  return latest;
}

export function promptSurfaceAnchorsAreAvailable(
  messages: readonly StoredAgentMessage[],
  anchors: readonly number[],
): boolean {
  const boundaries = completePromptSurfaceAnchorSequences(messages);
  return anchors.every((anchor) => boundaries.has(anchor));
}
