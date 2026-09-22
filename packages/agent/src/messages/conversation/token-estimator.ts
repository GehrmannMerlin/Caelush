import type { AIConversationMessage } from "@caelush/ai";

/**
 * How much of the model's context budget a set of projected messages costs.
 *
 * ```text
 * the Agent Domain owns the port      this interface
 * @caelush/context owns an implementation   Utf8HeuristicTokenEstimator
 * ```
 *
 * ## Why this port exists instead of an import
 *
 * `@caelush/context` already has a `TokenEstimator`, and it is the right one — a UTF-8 byte
 * heuristic that is provider-independent and cheap. But `@caelush/agent` may not depend on
 * `@caelush/context`: the dependency direction is frozen, and the Context package depends
 * on the Agent package's contracts rather than the other way round. Importing it would
 * invert a boundary that the whole migration exists to establish.
 *
 * So the Agent Domain declares the *narrowest* port it can use and leaves the algorithm
 * where it lives:
 *
 * ```text
 * @caelush/agent     declares TokenEstimator        this file
 * @caelush/context   implements it structurally     Utf8HeuristicTokenEstimator
 * composition root   passes one to the selector
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
 * It is deliberately **not** the Context algorithm: it is a floor that keeps a
 * misconfigured composition root from treating every conversation as free. A production
 * host injects the Context implementation.
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
