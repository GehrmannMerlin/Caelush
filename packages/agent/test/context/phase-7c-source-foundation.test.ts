import { describe, expect, it } from "vitest";

import {
  AGENT_CONTEXT_SOURCE_IDS,
  createContextItemId,
  createContextSourceId,
  createContextSourceItem,
  freezeContextSourceResult,
  type ContextItem,
} from "@caelush/agent";

function testItem(): ContextItem {
  return {
    id: createContextItemId("agent.test:item"),
    type: "agent.test",
    source: {
      providerId: createContextSourceId("agent.test"),
      sourceRef: "test:item",
      version: "schema-1",
    },
    scope: "TURN",
    retention: "EPHEMERAL",
    priorityClass: "NORMAL",
    tokenEstimate: 2,
    cacheStability: "DYNAMIC",
    freshness: "CURRENT",
    sensitivity: "INTERNAL",
    whyLoaded: "test source",
    payload: { kind: "TEXT", text: "hello" },
  };
}

describe("Phase 7C source foundation", () => {
  it("publishes the exact Generic Source IDs", () => {
    expect(AGENT_CONTEXT_SOURCE_IDS).toEqual({
      corePolicy: "agent.core-policy",
      conversation: "agent.conversation",
      checkpoint: "agent.checkpoint",
      memory: "agent.memory",
      extensionContributions: "agent.extension-contributions",
      branchContext: "agent.branch-context",
    });
  });

  it("canonicalizes and freezes a ContextItem and result", () => {
    const item = createContextSourceItem(testItem());
    const result = freezeContextSourceResult({
      providerId: createContextSourceId("agent.test"),
      providerVersion: "test-v1",
      items: [item],
      diagnostics: [],
    });

    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(result.items[0]).toEqual(item);
  });
});
