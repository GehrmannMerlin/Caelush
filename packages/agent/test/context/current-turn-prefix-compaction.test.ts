import { describe, expect, it } from "vitest";
import { createRunId, createTimestampMs } from "@caelush/protocol";
import {
  createAgentConversationSnapshot,
  createContextCutPointSelector,
  createContextHistoryIndexer,
  createConversationTurn,
  createContextCompactionPlanner,
  type ContextHistoryIndex,
  type ContextPolicy,
  type StoredAgentMessage,
} from "@caelush/agent";
import {
  SESSION_ID,
  assistantMessage,
  toolResultMessage,
  turnIdFor,
  userMessage,
} from "../messages/fixtures.js";

const MODEL = {
  ref: { provider: "test", model: "current-turn-prefix" },
  api: "test-api",
  limits: { contextWindowTokens: 64_000, maxOutputTokens: 2_000 },
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
} as const;

function currentOpenTurn() {
  const runId = createRunId();
  const id = turnIdFor(runId);
  const messages: StoredAgentMessage[] = [
    userMessage({
      runId,
      turnId: id,
      sequence: 1,
      text: "Preserve this user request and steering.",
    }),
  ];
  for (let index = 0; index < 5; index += 1) {
    const callId = `current_prefix_call_${String(index)}`;
    messages.push(
      assistantMessage({
        runId,
        turnId: id,
        sequence: index * 2 + 2,
        toolCalls: [callId],
      }),
      toolResultMessage({
        runId,
        turnId: id,
        sequence: index * 2 + 3,
        toolCallId: callId,
        projectedContent: `Closed batch ${String(index)} ${"evidence ".repeat(800)}`,
      }),
    );
  }
  const openCallId = "current_prefix_open_call";
  messages.push(
    assistantMessage({
      runId,
      turnId: id,
      sequence: 12,
      toolCalls: [openCallId],
    }),
  );
  const turn = createConversationTurn({
    id,
    sessionId: SESSION_ID as never,
    runId,
    status: "OPEN",
    openedAt: createTimestampMs(1_700_000_000_000),
    messages,
  });
  return { runId, turn };
}

function indexCurrentTurn(): {
  readonly history: ContextHistoryIndex;
  readonly turn: ReturnType<typeof currentOpenTurn>["turn"];
} {
  const { runId, turn } = currentOpenTurn();
  const conversation = createAgentConversationSnapshot({
    sessionId: SESSION_ID as never,
    currentRunId: runId,
    currentTurnId: turn.id,
    turns: [turn],
  });
  return {
    history: createContextHistoryIndexer().index({ conversation, model: MODEL }),
    turn,
  };
}

describe("WORKING_SET_V2 current-turn protocol prefix", () => {
  it("does not compact a single open user turn under the legacy selector policy", () => {
    const { history } = indexCurrentTurn();
    expect(
      createContextCutPointSelector().select({
        history,
        targetRecentTailTokens: 1,
        minRecentTailTokens: 1,
      }),
    ).toBeNull();
  });

  it("plans a complete old protocol prefix while preserving the user, recent batch, and open call", () => {
    const { history, turn } = indexCurrentTurn();
    const policy = {
      targetRecentTailTokens: Math.max(1, Math.floor(history.estimatedTokens * 0.4)),
      minRecentTailTokens: 1,
      allowCurrentTurnPrefix: true,
    } as ContextPolicy;
    const plan = createContextCompactionPlanner().plan({
      history,
      policy,
      reason: "PROACTIVE_PRESSURE",
    });

    expect(plan?.cut.kind).toBe("PROTOCOL_SAFE_SPLIT");
    expect(plan?.sourceRange.runId).toBe(turn.runId);
    expect(plan?.sourceRange.conversationTurnId).toBe(turn.id);
    expect(plan?.sourceRange.firstSequence).toBeGreaterThan(1);
    expect(plan?.sourceRange.firstMessageId).not.toBe(turn.messages[0]?.message.id);
    expect(plan?.sourceRange.lastSequence).toBeLessThan(12);
    expect(turn.messages.at(-1)?.message.type).toBe("ASSISTANT");
    expect(plan?.retainedUnitIds).toContain(`conversation:${turn.id}`);
    const newestCompletedProtocol = history.units
      .filter((unit) => unit.kind === "TOOL_PROTOCOL" && unit.status === "CLOSED")
      .at(-1);
    expect(newestCompletedProtocol).toBeDefined();
    expect(plan?.sourceRange.lastSequence).toBeLessThan(
      newestCompletedProtocol?.messages[0]?.sequence ?? Number.MAX_SAFE_INTEGER,
    );
  });
});
