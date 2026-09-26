import type { AIConversationMessage } from "@caelush/ai";

/**
 * How much of the model's context budget a set of projected messages costs.
 *
 * ```text
 * the Agent Domain owns the port and implementation      this interface
 * Context Engine callers consume the estimator
 * ```
 *
 * ## Why this port exists instead of an import
 *
 * The Agent package owns the provider-independent UTF-8 byte heuristic. Keeping the implementation
 * beside the port prevents Context Engine callers from creating a second estimator authority.
 *
 * The ownership is therefore explicit:
 *
 * ```text
 * @caelush/agent     declares and implements TokenEstimator
 * Context Engine     consumes it through the Agent contract
 * ```
 *
 * ## The port speaks projected AI, not Agent messages
 *
 * The input is `AIConversationMessage[]`, deliberately. The question the selector asks is
 * "how much of the model's budget does this cost?", and the only honest answer comes from
 * what the model would actually receive. A port typed against `AgentMessage` would invite an
 * implementation to `JSON.stringify` the durable envelope — `id`, `runId`, `sessionId`,
 * `audience`, `source`, `observationId` — and count characters the model never sees, which
 * would systematically over-estimate and drop history that fits.
 *
 * ## It is an estimate
 *
 * A token count is provider-independent planning metadata, not billing truth. The port is
 * named accordingly and no consumer may treat its answer as exact.
 */
export interface TokenEstimator {
  estimateMessages(messages: readonly AIConversationMessage[]): number;
}

/**
 * A structural estimator the Agent Domain may use when nothing was injected.
 *
 * It counts the UTF-8 bytes of the *semantic* text a projected message carries — the text
 * of a user or assistant turn, the content of a Tool result — and nothing else. It adds no
 * per-message constant for the provider's own framing, because inventing one would make the
 * estimate look more precise than it is.
 *
 * It is the canonical provider-independent Context Engine estimator; host composition may still
 * inject a specialized estimator through the same narrow port when required.
 */
export const STRUCTURAL_TOKEN_ESTIMATOR: TokenEstimator = Object.freeze({
  estimateMessages(messages: readonly AIConversationMessage[]): number {
    let bytes = 0;
    for (const message of messages) {
      switch (message.role) {
        case "user":
          bytes += utf8(message.content);
          break;
        case "assistant":
          for (const part of message.content) {
            bytes += part.type === "text" ? utf8(part.text) : utf8(part.toolName);
          }
          break;
        case "tool":
          bytes += utf8(message.content);
          break;
      }
    }
    return bytes === 0 ? 0 : Math.ceil(bytes / 3);
  },
});

function utf8(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
