import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type { ContextSourceInput, ContextSourceProvider } from "./context-source.js";
import { AGENT_CONTEXT_SOURCE_IDS } from "./source-ids.js";
import { createSourceResult, estimateContextTokens } from "./generic-provider-helpers.js";
import { createContextSourceItem } from "./context-source-item.js";
import { createContextItemId } from "../item/context-item.js";

const PROVIDER_VERSION = "conversation-v1";

/**
 * Projects the durable Agent conversation into canonical message items.
 *
 * This provider deliberately does not select, reorder, group Tool protocol units, or
 * project messages into AI protocol values. Those responsibilities stay with the
 * HistoryIndexer, Planner, and later Materializer respectively.
 */
export function createConversationContextSourceProvider(): ContextSourceProvider {
  return Object.freeze({
    id: AGENT_CONTEXT_SOURCE_IDS.conversation,
    async collect(input: ContextSourceInput) {
      const items = input.conversation.turns.flatMap((conversationTurn) =>
        conversationTurn.messages
          .filter((storedMessage) => storedMessage.message.audience.model)
          .map((storedMessage) => conversationItem(input, conversationTurn.id, storedMessage)),
      );
      return createSourceResult(AGENT_CONTEXT_SOURCE_IDS.conversation, PROVIDER_VERSION, items);
    },
  });
}

function conversationItem(
  input: ContextSourceInput,
  conversationTurnId: string,
  storedMessage: StoredAgentMessage,
) {
  const message = storedMessage.message;
  return createContextSourceItem({
    id: createContextItemId(`agent.conversation:${message.id}`),
    type: "agent.conversation",
    source: {
      providerId: AGENT_CONTEXT_SOURCE_IDS.conversation,
      sourceRef: [
        `session:${input.conversation.sessionId}`,
        `run:${message.runId}`,
        `turn:${conversationTurnId}`,
        `message:${message.id}`,
        `sequence:${storedMessage.sequence}`,
      ].join("/"),
      version: PROVIDER_VERSION,
    },
    scope: "SESSION",
    retention: "COMPRESSIBLE",
    priorityClass: "NORMAL",
    tokenEstimate: estimateContextTokens(storedMessage),
    cacheStability: "STABLE",
    freshness: "CURRENT",
    sensitivity: "INTERNAL",
    whyLoaded: "durable conversation message",
    payload: { kind: "AGENT_MESSAGE", message: storedMessage },
  });
}
