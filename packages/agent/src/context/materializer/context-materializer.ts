import type { AIMessage, ModelDescriptor } from "@caelush/ai";

import type { AgentMessageProjectorRegistry } from "../../messages/projection/registry.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type { PreparedAgentContext } from "../contracts/prepared-agent-context.js";
import type { ContextDocument } from "../document/context-document.js";
import type { ContextTokenEstimatorPort } from "../token/context-token-estimator.js";

export interface ContextMaterializer {
  materialize(input: {
    readonly prepared: PreparedAgentContext;
    readonly model: ModelDescriptor;
    readonly signal: AbortSignal;
  }): Promise<readonly AIMessage[]>;
}

export interface ContextMaterializerOptions {
  readonly projectors: AgentMessageProjectorRegistry;
  readonly tokenEstimator: ContextTokenEstimatorPort;
}

/** Build the one provider-neutral AI message sequence for a prepared Context. */
export function createContextMaterializer(
  options: ContextMaterializerOptions,
): ContextMaterializer {
  return Object.freeze({
    async materialize(input: {
      readonly prepared: PreparedAgentContext;
      readonly model: ModelDescriptor;
      readonly signal: AbortSignal;
    }): Promise<readonly AIMessage[]> {
      throwIfAborted(input.signal);
      const documentText = renderContextDocument(input.prepared.document);
      assertEstimate(options.tokenEstimator.estimateText(documentText, input.model), "document");
      throwIfAborted(input.signal);

      const ordered = orderStoredMessages(input.prepared.conversationMessages);
      const messages: AIMessage[] = [Object.freeze({ role: "system", content: documentText })];
      for (const stored of ordered.historical) {
        throwIfAborted(input.signal);
        appendProjection(messages, stored, options, input.model);
      }
      for (const stored of ordered.tail) {
        throwIfAborted(input.signal);
        appendProjection(messages, stored, options, input.model);
      }
      throwIfAborted(input.signal);
      return Object.freeze(messages);
    },
  });
}

function appendProjection(
  messages: AIMessage[],
  stored: StoredAgentMessage,
  options: ContextMaterializerOptions,
  model: ModelDescriptor,
): void {
  if (!stored.message.audience.model) return;
  assertEstimate(options.tokenEstimator.estimateAgentMessage(stored.message, model), "message");
  const projection = options.projectors.project(stored);
  for (const message of projection.messages) messages.push(Object.freeze({ ...message }));
}

function renderContextDocument(document: ContextDocument): string {
  const sections = document.sections.filter(
    (section) => !isConversationSection(section.id, section.sourceRef),
  );
  const body = sections
    .map(
      (section) =>
        `[${section.authority}|${section.cacheStability}|${section.sensitivity}] ${section.sourceRef}\n${section.text}`,
    )
    .join("\n");
  return `<context_document>\n${body}\n</context_document>`;
}

function isConversationSection(id: string, sourceRef: string): boolean {
  return id.startsWith("agent.conversation:") || sourceRef.includes("/message:");
}

function orderStoredMessages(messages: readonly StoredAgentMessage[]): {
  readonly historical: readonly StoredAgentMessage[];
  readonly tail: readonly StoredAgentMessage[];
} {
  const ordered = [...messages].sort(compareStoredMessages);
  const latestTurnId = ordered.at(-1)?.message.conversationTurnId;
  const openProtocolMessageIds = openProtocolMessages(ordered);
  const tail = ordered.filter(
    (stored) =>
      stored.message.conversationTurnId === latestTurnId ||
      openProtocolMessageIds.has(stored.message.id),
  );
  const tailIds = new Set(tail.map((stored) => stored.message.id));
  return Object.freeze({
    historical: Object.freeze(ordered.filter((stored) => !tailIds.has(stored.message.id))),
    tail: Object.freeze(tail),
  });
}

function openProtocolMessages(messages: readonly StoredAgentMessage[]): ReadonlySet<string> {
  const toolResults = new Set<string>();
  for (const stored of messages) {
    if (stored.message.type === "TOOL_RESULT") toolResults.add(stored.message.toolCallId);
  }
  const openAssistantIds = new Set<string>();
  const openCallIds = new Set<string>();
  for (const stored of messages) {
    if (stored.message.type !== "ASSISTANT") continue;
    const calls = stored.message.content.filter((part) => part.type === "TOOL_CALL");
    const missing = calls.filter((call) => !toolResults.has(call.toolCallId));
    if (missing.length === 0) continue;
    openAssistantIds.add(stored.message.id);
    for (const call of calls) openCallIds.add(call.toolCallId);
  }
  const ids = new Set<string>(openAssistantIds);
  for (const stored of messages) {
    if (stored.message.type === "TOOL_RESULT" && openCallIds.has(stored.message.toolCallId)) {
      ids.add(stored.message.id);
    }
  }
  return ids;
}

function compareStoredMessages(left: StoredAgentMessage, right: StoredAgentMessage): number {
  return left.sequence - right.sequence || compareStrings(left.message.id, right.message.id);
}

function assertEstimate(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Context materializer ${label} token estimate is invalid.`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("Context materialization was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
