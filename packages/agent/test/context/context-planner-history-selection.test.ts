import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import {
  createContextHistoryIndexer,
  createContextItem,
  createContextItemId,
  createContextPlanner,
  createContextPolicy,
  createContextSourceId,
  type ContextItem,
} from "@caelush/agent";

import {
  OTHER_RUN_ID,
  RUN_ID,
  SESSION_ID,
  snapshot,
  turn,
  userMessage,
} from "../messages/fixtures.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "history-selection" },
  api: "test-api",
  limits: { contextWindowTokens: 100, maxOutputTokens: 10 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

const CONVERSATION_SOURCE = createContextSourceId("agent.conversation");
const EXTENSION_SOURCE = createContextSourceId("agent.extension");

function policy(sourceLimits?: Readonly<Record<string, number>>) {
  return createContextPolicy({
    model: MODEL,
    requestOverhead: { toolSchemaTokens: 0, protocolOverheadTokens: 0, totalTokens: 0 },
    options: {
      outputReserveTokens: 5,
      safetyReserveTokens: 5,
      ...(sourceLimits === undefined ? {} : { sourceLimits }),
    },
  });
}

function messageItem(message: ReturnType<typeof userMessage>, tokenEstimate: number): ContextItem {
  return createContextItem({
    id: createContextItemId(`agent.conversation:${message.message.id}`),
    type: "agent.conversation",
    source: {
      providerId: CONVERSATION_SOURCE,
      sourceRef: String(message.message.id),
      version: "fixture-v1",
    },
    scope: "SESSION",
    retention: "COMPRESSIBLE",
    priorityClass: "NORMAL",
    tokenEstimate,
    cacheStability: "STABLE",
    freshness: "CURRENT",
    sensitivity: "INTERNAL",
    whyLoaded: "durable conversation fixture",
    payload: { kind: "AGENT_MESSAGE", message },
  });
}

function optionalItem(tokenEstimate: number): ContextItem {
  return createContextItem({
    id: createContextItemId("extension:retrievable"),
    type: "agent.extension",
    source: {
      providerId: EXTENSION_SOURCE,
      sourceRef: "extension:retrievable",
      version: "fixture-v1",
    },
    scope: "RUN",
    retention: "RETRIEVABLE",
    priorityClass: "LOW",
    tokenEstimate,
    cacheStability: "DYNAMIC",
    freshness: "CURRENT",
    sensitivity: "PUBLIC",
    whyLoaded: "optional retrieved fixture",
    payload: { kind: "TEXT", text: "optional" },
  });
}

function historyFixture() {
  const old = userMessage({
    runId: OTHER_RUN_ID,
    sessionId: SESSION_ID,
    sequence: 1,
    text: "old request",
  });
  const current = userMessage({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    sequence: 1,
    text: "current request",
  });
  const conversation = snapshot(
    [
      turn([old], { runId: OTHER_RUN_ID, sessionId: SESSION_ID, status: "CLOSED", openedAt: 1 }),
      turn([current], { runId: RUN_ID, sessionId: SESSION_ID, status: "OPEN", openedAt: 2 }),
    ],
    { runId: RUN_ID, sessionId: SESSION_ID },
  );
  const history = createContextHistoryIndexer().index({ conversation, model: MODEL });
  return { old, current, conversation, history };
}

describe("ContextPlanner history selection pressure", () => {
  it("signals eligible closed history excluded by total budget while preserving the current turn", () => {
    const { old, current, history, conversation } = historyFixture();
    const oldItem = messageItem(old, 60);
    const currentItem = createContextItem({
      ...messageItem(current, 40),
      retention: "RECENT",
    });

    const result = createContextPlanner().plan({
      items: [oldItem, currentItem],
      policy: policy(),
      history,
      currentTurnId: conversation.currentTurnId,
    });

    expect(result.historySelectionPressure).toBe(true);
    expect(result.selectedItems.map((item) => item.id)).toEqual([currentItem.id]);
    expect(result.decisions.find((decision) => decision.itemId === oldItem.id)).toMatchObject({
      disposition: "DROPPED",
      reason: "TOTAL_BUDGET",
    });
  });

  it("does not signal when optional retrievable context alone is deferred", () => {
    const { current, history, conversation } = historyFixture();
    const currentItem = createContextItem({
      ...messageItem(current, 40),
      retention: "RECENT",
    });
    const optional = optionalItem(60);

    const result = createContextPlanner().plan({
      items: [currentItem, optional],
      policy: policy(),
      history,
      currentTurnId: conversation.currentTurnId,
    });

    expect(result.historySelectionPressure).toBe(false);
    expect(result.decisions.find((decision) => decision.itemId === optional.id)).toMatchObject({
      disposition: "DEFERRED",
      reason: "RETRIEVABLE_DEFERRED",
    });
  });

  it("does not signal eligible history excluded by a source limit", () => {
    const { old, current, history, conversation } = historyFixture();
    const oldItem = messageItem(old, 60);
    const currentItem = createContextItem({
      ...messageItem(current, 40),
      retention: "RECENT",
    });

    const result = createContextPlanner().plan({
      items: [oldItem, currentItem],
      policy: policy({ [CONVERSATION_SOURCE]: 0 }),
      history,
      currentTurnId: conversation.currentTurnId,
    });

    expect(result.historySelectionPressure).toBe(false);
    expect(result.decisions.find((decision) => decision.itemId === oldItem.id)).toMatchObject({
      disposition: "DROPPED",
      reason: "SOURCE_LIMIT",
    });
  });
});
