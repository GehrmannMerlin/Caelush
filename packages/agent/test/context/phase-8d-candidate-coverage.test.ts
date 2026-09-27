import { describe, expect, it } from "vitest";

import { createRunId } from "@caelush/protocol";
import {
  agentMessageId,
  conversationTurnId,
  createContextCompactionCoverageForRange,
  createContextMessageRange,
  type ContextHistoryIndex,
  type ContextMessageRef,
} from "@caelush/agent";

const runId = createRunId();

function ref(name: string, sequence: number): ContextMessageRef {
  return {
    messageId: agentMessageId(`amsg_phase_8d_coverage_${name}`),
    runId,
    conversationTurnId: conversationTurnId("cturn_phase_8d_coverage"),
    sequence,
    tokenEstimate: 10,
  };
}

function history(refs: readonly ContextMessageRef[]): ContextHistoryIndex {
  const turn = {
    id: "conversation:phase-8d",
    kind: "CONVERSATION_TURN" as const,
    status: "CLOSED" as const,
    messages: refs,
    tokenEstimate: refs.length * 10,
    atomicGroupId: "phase-8d",
    compactionEligible: true,
  };
  const protocol = {
    id: "tool-protocol:phase-8d",
    kind: "TOOL_PROTOCOL" as const,
    status: "CLOSED" as const,
    messages: refs,
    tokenEstimate: refs.length * 10,
    atomicGroupId: "tool-protocol:phase-8d",
    compactionEligible: true,
    sourceAssistantMessageId: refs[0]!.messageId,
    toolCallIds: ["call_phase_8d"],
    toolResultMessageIds: [refs[1]!.messageId],
  };
  return {
    units: [turn, protocol],
    openUnits: [],
    closedUnits: [turn, protocol],
    estimatedTokens: refs.length * 10,
  };
}

function range(first: ContextMessageRef, last: ContextMessageRef) {
  return createContextMessageRange({
    runId,
    conversationTurnId: first.conversationTurnId,
    firstMessageId: first.messageId,
    lastMessageId: last.messageId,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
  });
}

describe("Phase 8D candidate coverage", () => {
  it("projects a complete candidate range using the canonical V2 coverage rules", () => {
    const refs = [ref("call", 1), ref("result", 2)];
    const projection = createContextCompactionCoverageForRange({
      history: history(refs),
      sourceRange: range(refs[0]!, refs[1]!),
    });

    expect([...projection.coveredMessageIds]).toEqual(refs.map((item) => item.messageId));
    expect(projection.history.units).toHaveLength(0);
  });

  it("fails closed when a tentative candidate range splits an open ToolProtocol unit", () => {
    const refs = [ref("call", 1), ref("result", 2)];

    expect(() =>
      createContextCompactionCoverageForRange({
        history: history(refs),
        sourceRange: range(refs[0]!, refs[0]!),
      }),
    ).toThrowError(/inconsistent/i);
  });
});
