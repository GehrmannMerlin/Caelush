import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import {
  ContextCurrentTurnTooLargeError,
  ContextMandatoryInputTooLargeError,
  ContextDocumentConstructionError,
  createContextDocumentBuilder,
  createContextHistoryIndexer,
  createContextItem,
  createContextItemId,
  createContextPlanner,
  createContextPolicy,
  createContextSourceId,
  type ContextHistoryIndex,
  type ContextItem,
  type ContextPlan,
} from "@caelush/agent";
import type { ContextSourceId } from "@caelush/agent";

import {
  assistantMessage,
  snapshot,
  toolResultMessage,
  turn,
  userMessage,
} from "../messages/fixtures.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-7b" },
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

const SOURCE = createContextSourceId("agent.test");

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

function item(
  id: string,
  tokenEstimate: number,
  options: Partial<
    Pick<ContextItem, "retention" | "priorityClass" | "freshness" | "type" | "cacheStability">
  > & {
    readonly sourceId?: ContextSourceId;
    readonly atomicGroupId?: string;
  } = {},
): ContextItem {
  return createContextItem({
    id: createContextItemId(id),
    type: options.type ?? "agent.extension",
    source: {
      providerId: options.sourceId ?? SOURCE,
      sourceRef: id,
      version: "1",
    },
    scope: "RUN",
    retention: options.retention ?? "EPHEMERAL",
    priorityClass: options.priorityClass ?? "NORMAL",
    tokenEstimate,
    cacheStability: options.cacheStability ?? "DYNAMIC",
    freshness: options.freshness ?? "CURRENT",
    ...(options.atomicGroupId === undefined ? {} : { atomicGroupId: options.atomicGroupId }),
    sensitivity: "PUBLIC",
    whyLoaded: `fixture ${id}`,
    payload: { kind: "TEXT", text: id },
  });
}

function planOf(
  items: readonly ContextItem[],
  options: {
    readonly history?: ContextHistoryIndex;
    readonly currentTurnId?: string;
    readonly sourcePriorities?: Readonly<Record<string, number>>;
  } = {},
): ContextPlan {
  return createContextPlanner().plan({
    items,
    policy: policy(),
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.currentTurnId === undefined
      ? {}
      : { currentTurnId: options.currentTurnId as never }),
    ...(options.sourcePriorities === undefined
      ? {}
      : { sourcePriorities: options.sourcePriorities }),
  });
}

describe("Phase 7B semantic history units", () => {
  it("indexes closed Tool protocol units with durable identities and frozen output", () => {
    const user = userMessage({ sequence: 1, text: "run the tool" });
    const assistant = assistantMessage({ sequence: 2, toolCalls: ["call_1"] });
    const result = toolResultMessage({ sequence: 3, toolCallId: "call_1" });
    const conversation = snapshot([turn([user, assistant, result], { status: "CLOSED" })]);

    const index = createContextHistoryIndexer().index({ conversation, model: MODEL });
    const protocol = index.units.find((unit) => unit.kind === "TOOL_PROTOCOL");

    expect(protocol).toMatchObject({
      kind: "TOOL_PROTOCOL",
      status: "CLOSED",
      compactionEligible: true,
      sourceAssistantMessageId: assistant.message.id,
      toolCallIds: ["call_1"],
      toolResultMessageIds: [result.message.id],
    });
    expect(protocol?.messages.map((ref) => ref.messageId)).toEqual([
      assistant.message.id,
      result.message.id,
    ]);
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(protocol)).toBe(true);
  });

  it("marks an unanswered Tool protocol OPEN and non-compaction-eligible", () => {
    const assistant = assistantMessage({ sequence: 2, toolCalls: ["open_call"] });
    const conversation = snapshot([turn([userMessage({ sequence: 1 }), assistant])]);

    const index = createContextHistoryIndexer().index({ conversation, model: MODEL });
    const protocol = index.units.find((unit) => unit.kind === "TOOL_PROTOCOL");

    expect(protocol?.status).toBe("OPEN");
    expect(protocol?.compactionEligible).toBe(false);
    expect(index.openUnits).toContain(protocol);
  });

  it("keeps semantic history in ConversationTurn order when Run-local sequences collide", () => {
    const run1 = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a";
    const run2 = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b";
    const run3 = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c";
    const first = [
      userMessage({ runId: run1, sequence: 1 }),
      assistantMessage({ runId: run1, sequence: 2, toolCalls: ["shared_call"] }),
      toolResultMessage({ runId: run1, sequence: 3, toolCallId: "shared_call" }),
      assistantMessage({ runId: run1, sequence: 4, text: "first final" }),
    ];
    const second = [
      userMessage({ runId: run2, sequence: 1 }),
      assistantMessage({ runId: run2, sequence: 2, toolCalls: ["shared_call"] }),
      toolResultMessage({ runId: run2, sequence: 3, toolCallId: "shared_call" }),
    ];
    const third = [
      userMessage({ runId: run3, sequence: 1 }),
      assistantMessage({ runId: run3, sequence: 2, text: "third answer" }),
    ];
    const conversation = snapshot(
      [
        turn(first, { runId: run1, status: "CLOSED", openedAt: 1 }),
        turn(second, { runId: run2, status: "CLOSED", openedAt: 2 }),
        turn(third, { runId: run3, openedAt: 3 }),
      ],
      { runId: run3 },
    );

    const index = createContextHistoryIndexer().index({ conversation, model: MODEL });

    expect(index.units.map((unit) => [unit.kind, unit.messages[0]?.runId])).toEqual([
      ["CONVERSATION_TURN", run1],
      ["TOOL_PROTOCOL", run1],
      ["CONVERSATION_TURN", run2],
      ["TOOL_PROTOCOL", run2],
      ["CONVERSATION_TURN", run3],
    ]);
    expect(
      index.units
        .filter((unit) => unit.kind === "TOOL_PROTOCOL")
        .map((unit) => unit.messages.map((message) => [message.runId, message.sequence])),
    ).toEqual([
      [
        [run1, 2],
        [run1, 3],
      ],
      [
        [run2, 2],
        [run2, 3],
      ],
    ]);
  });
});

describe("Phase 7B ContextPlanner", () => {
  it("makes atomic groups all-or-none and returns complete immutable decisions", () => {
    const first = item("group-a", 40, { atomicGroupId: "atomic-1", priorityClass: "HIGH" });
    const second = item("group-b", 40, { atomicGroupId: "atomic-1", priorityClass: "HIGH" });
    const optional = item("optional", 20, { retention: "RETRIEVABLE" });

    const plan = planOf([optional, second, first]);

    expect(plan.selectedItems.map((entry) => entry.id)).toEqual([
      createContextItemId("group-a"),
      createContextItemId("group-b"),
    ]);
    expect(plan.decisions).toHaveLength(3);
    expect(plan.decisions.find((decision) => decision.itemId === optional.id)).toMatchObject({
      disposition: "DEFERRED",
      reason: "RETRIEVABLE_DEFERRED",
    });
    expect(plan.budget.selectedTokens).toBe(80);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.selectedItems)).toBe(true);
    expect(Object.isFrozen(plan.decisions)).toBe(true);
  });

  it("applies source limits before the elastic total budget", () => {
    const limited = item("limited", 20, { sourceId: createContextSourceId("limited") });
    const elastic = item("elastic", 20, { sourceId: createContextSourceId("elastic") });

    const plan = createContextPlanner().plan({
      items: [limited, elastic],
      policy: policy({ limited: 10 }),
    });

    expect(plan.selectedItems.map((entry) => entry.id)).toEqual([elastic.id]);
    expect(plan.decisions.find((decision) => decision.itemId === limited.id)).toMatchObject({
      disposition: "DROPPED",
      reason: "SOURCE_LIMIT",
    });
  });

  it("protects PINNED/current material and reports open-unit overflow without dropping it", () => {
    const oldAssistant = assistantMessage({
      sequence: 2,
      toolCalls: ["open_call"],
      runId: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c",
    });
    const oldTurn = turn(
      [
        userMessage({ runId: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c", sequence: 1 }),
        oldAssistant,
      ],
      {
        runId: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c",
      },
    );
    const current = turn([userMessage({ sequence: 1, text: "current" })], { status: "CLOSED" });
    const history = createContextHistoryIndexer().index({
      conversation: snapshot([oldTurn, current]),
      model: MODEL,
    });
    const openItem = createContextItem({
      ...item("open", 100),
      payload: { kind: "AGENT_MESSAGE", message: oldAssistant },
    });

    const plan = createContextPlanner().plan({
      items: [openItem],
      policy: policy(),
      history,
      currentTurnId: current.id,
    });

    expect(plan.selectedItems).toHaveLength(1);
    expect(plan.requiresCompaction).toBe(true);
    expect(plan.budget.remainingTokens).toBe(0);
    expect(plan.decisions[0]).toMatchObject({
      disposition: "SELECTED",
      reason: "OPEN_PROTOCOL_UNIT",
    });
  });

  it("fails closed when a pinned/current mandatory group cannot fit", () => {
    expect(() =>
      planOf([item("pinned", 91, { retention: "PINNED", priorityClass: "CRITICAL" })]),
    ).toThrow(ContextMandatoryInputTooLargeError);

    const currentMessage = userMessage({ sequence: 1, text: "too large current ask" });
    const currentTurn = turn([currentMessage], { status: "CLOSED" });
    const history = createContextHistoryIndexer().index({
      conversation: snapshot([currentTurn]),
      model: MODEL,
    });
    const currentItem = createContextItem({
      ...item("current", 91, { retention: "RECENT", priorityClass: "HIGH" }),
      payload: { kind: "AGENT_MESSAGE", message: currentMessage },
    });
    expect(() =>
      createContextPlanner().plan({
        items: [currentItem],
        policy: policy(),
        history,
        currentTurnId: currentTurn.id,
      }),
    ).toThrow(ContextCurrentTurnTooLargeError);
  });

  it("keeps a closed historical Tool protocol atomic and protects the current turn tail", () => {
    const oldRunId = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c";
    const oldAssistant = assistantMessage({
      runId: oldRunId,
      sequence: 2,
      toolCalls: ["closed_call"],
    });
    const oldResult = toolResultMessage({
      runId: oldRunId,
      sequence: 3,
      toolCallId: "closed_call",
    });
    const oldTurn = turn([userMessage({ runId: oldRunId, sequence: 1 }), oldAssistant, oldResult], {
      runId: oldRunId,
      status: "CLOSED",
      openedAt: 1,
    });
    const currentMessage = userMessage({ sequence: 1, text: "current ask" });
    const currentTurn = turn([currentMessage], { status: "CLOSED", openedAt: 2 });
    const history = createContextHistoryIndexer().index({
      conversation: snapshot([oldTurn, currentTurn]),
      model: MODEL,
    });
    const oldItems = [
      createContextItem({
        ...item("old-assistant", 50),
        payload: { kind: "AGENT_MESSAGE", message: oldAssistant },
      }),
      createContextItem({
        ...item("old-result", 50),
        payload: { kind: "AGENT_MESSAGE", message: oldResult },
      }),
    ];
    const currentItem = createContextItem({
      ...item("current-message", 40, { retention: "RECENT" }),
      payload: { kind: "AGENT_MESSAGE", message: currentMessage },
    });

    const plan = createContextPlanner().plan({
      items: [...oldItems, currentItem],
      policy: policy(),
      history,
      currentTurnId: currentTurn.id,
    });

    expect(plan.selectedItems.map((entry) => entry.id)).toEqual([currentItem.id]);
    expect(
      plan.decisions.filter((decision) => decision.itemId === oldItems[0]?.id)[0],
    ).toMatchObject({
      disposition: "DROPPED",
      reason: "TOTAL_BUDGET",
    });
    expect(
      plan.decisions.filter((decision) => decision.itemId === oldItems[1]?.id)[0],
    ).toMatchObject({
      disposition: "DROPPED",
      reason: "TOTAL_BUDGET",
    });
    expect(plan.decisions.find((decision) => decision.itemId === currentItem.id)).toMatchObject({
      disposition: "SELECTED",
      reason: "RECENT",
    });
  });

  it("preserves selected ConversationTurn order alongside non-history context items", () => {
    const runs = [
      "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
      "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b",
      "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c",
    ];
    const messages = runs.flatMap((runId, index) => [
      userMessage({ runId, sequence: 1, text: `Run ${String(index + 1)} user` }),
      assistantMessage({ runId, sequence: 2, text: `Run ${String(index + 1)} assistant` }),
    ]);
    const turns = runs.map((runId, index) =>
      turn(messages.slice(index * 2, index * 2 + 2), {
        runId,
        status: "CLOSED",
        openedAt: index + 1,
      }),
    );
    const history = createContextHistoryIndexer().index({
      conversation: snapshot(turns),
      model: MODEL,
    });
    const ids = [
      "z_history_user_1",
      "z_history_assistant_1",
      "a_history_user_2",
      "a_history_assistant_2",
      "n_history_user_3",
      "n_history_assistant_3",
    ];
    const messageItems = messages.map((message, index) =>
      createContextItem({
        ...item(ids[index]!, 1, { retention: "RECENT" }),
        payload: { kind: "AGENT_MESSAGE", message },
      }),
    );
    const nonHistoryItem = item("m_interleaved_context", 1);

    const plan = createContextPlanner().plan({
      items: [messageItems[0]!, messageItems[1]!, nonHistoryItem, ...messageItems.slice(2)],
      policy: policy(),
      history,
      currentTurnId: turns[2]!.id,
    });

    expect(
      plan.selectedItems.flatMap((entry) =>
        entry.payload.kind === "AGENT_MESSAGE" ? [entry.payload.message.message.id] : [],
      ),
    ).toEqual(messages.map((message) => message.message.id));
  });

  it("produces the same plan for the same semantic input regardless of item insertion order", () => {
    const items = [
      item("zeta", 10, { priorityClass: "LOW", cacheStability: "STABLE" }),
      item("alpha", 10, { priorityClass: "HIGH", cacheStability: "STABLE" }),
      item("retrievable", 100, { retention: "RETRIEVABLE" }),
    ];

    const first = planOf(items);
    const second = planOf([...items].reverse());

    expect(second).toEqual(first);
  });
});

describe("Phase 7B ContextDocument", () => {
  it("builds stable semantic sections from selected items only", () => {
    const plan = planOf([
      item("dynamic", 2, { type: "coding.runtime_fact", priorityClass: "NORMAL" }),
      item("stable", 2, { type: "agent.goal", priorityClass: "CRITICAL" }),
    ]);
    const document = createContextDocumentBuilder().build({
      plan,
      rehydrated: {
        goal: "",
        changedFiles: [],
        pendingApprovals: [],
        activeProcesses: [],
        verificationState: "",
        resourceGovernance: "",
        projectFacts: [],
      },
    });

    expect(document.sections.map((section) => section.id)).toEqual(["stable", "dynamic"]);
    expect(document.sections.every((section) => section.sourceRef.includes("agent.test@1"))).toBe(
      true,
    );
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.sections)).toBe(true);
    expect(Object.isFrozen(document.sections[0])).toBe(true);
  });

  it("rejects plans with selected items that disagree with their decisions", () => {
    const plan = planOf([item("selected", 2)]);
    expect(() =>
      createContextDocumentBuilder().build({
        plan: { ...plan, selectedItems: [] },
        rehydrated: {
          goal: "",
          changedFiles: [],
          pendingApprovals: [],
          activeProcesses: [],
          verificationState: "",
          resourceGovernance: "",
          projectFacts: [],
        },
      }),
    ).toThrow(ContextDocumentConstructionError);
  });
});
