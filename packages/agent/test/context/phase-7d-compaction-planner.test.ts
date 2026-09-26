import { describe, expect, it } from "vitest";

import { createRunId, createTimestampMs } from "@caelush/protocol";
import {
  createContextCheckpointId,
  createContextCompactionPlanner,
  createContextMessageRange,
  createContextSummaryPromptVersion,
  prepareContextCompactionCandidates,
  type ContextHistoryIndex,
  type ContextHistoryUnit,
  type ContextMessageRef,
  type ContextPolicy,
  type ToolProtocolUnit,
} from "@caelush/agent";
import { agentMessageId, conversationTurnId } from "@caelush/agent";
import type { ContextCheckpointRecordV2, LegacyContextCheckpointRecordV1 } from "@caelush/agent";

const runId = createRunId();
const turnId = conversationTurnId("cturn_phase_7d_planner");

function policy(targetRecentTailTokens: number, minRecentTailTokens: number): ContextPolicy {
  return { targetRecentTailTokens, minRecentTailTokens } as ContextPolicy;
}

function unit(
  id: string,
  firstSequence: number,
  lastSequence: number,
  tokenEstimate: number,
  options: Partial<Pick<ContextHistoryUnit, "status" | "compactionEligible" | "kind">> = {},
): ContextHistoryUnit {
  const messages: ContextMessageRef[] = [];
  for (let sequence = firstSequence; sequence <= lastSequence; sequence += 1) {
    messages.push({
      messageId: agentMessageId(`amsg_${id}_${String(sequence)}`),
      runId,
      conversationTurnId: turnId,
      sequence,
    });
  }
  return {
    id,
    kind: options.kind ?? "CONVERSATION_TURN",
    status: options.status ?? "CLOSED",
    messages,
    tokenEstimate,
    atomicGroupId: id,
    compactionEligible: options.compactionEligible ?? true,
  };
}

function history(units: readonly ContextHistoryUnit[]): ContextHistoryIndex {
  return {
    units,
    openUnits: units.filter((candidate) => candidate.status === "OPEN"),
    closedUnits: units.filter((candidate) => candidate.status === "CLOSED"),
    estimatedTokens: units.reduce((total, candidate) => total + candidate.tokenEstimate, 0),
  };
}

function checkpoint(sourceFrom: number, sourceTo: number): ContextCheckpointRecordV2 {
  const sourceRange = createContextMessageRange({
    runId,
    conversationTurnId: turnId,
    firstMessageId: agentMessageId(`amsg_checkpoint_${String(sourceFrom)}`),
    lastMessageId: agentMessageId(`amsg_checkpoint_${String(sourceTo)}`),
    firstSequence: sourceFrom,
    lastSequence: sourceTo,
  });
  return {
    checkpointId: createContextCheckpointId("checkpoint_v2"),
    runId,
    schemaVersion: 2,
    sourceRange,
    structuredCheckpoint: {
      version: 1,
      goal: "goal",
      constraints: [],
      completedWork: [],
      inProgress: [],
      blocked: [],
      importantDiscoveries: [],
      keyDecisions: [],
      changedFiles: [],
      readFiles: [],
      recentErrors: [],
      verificationState: "unknown",
      activeProcesses: [],
      pendingApprovals: [],
      resourceGovernance: "bounded",
      criticalReferences: [],
      nextIntent: "continue",
      sourceRange: { from: sourceFrom, to: sourceTo },
    },
    tokensBefore: 100,
    tokensAfter: 20,
    modelRef: { provider: "test", model: "phase-7d" },
    summaryPromptVersion: createContextSummaryPromptVersion(1),
    sourceDigest: "sha256:source",
    checkpointDigest: "sha256:checkpoint",
    degraded: false,
    reason: "SELECTION_PRESSURE",
    createdAt: createTimestampMs(1),
  };
}

describe("Phase 7D semantic compaction planner", () => {
  it("selects the oldest closed units and leaves the configured recent tail", () => {
    const index = history([
      unit("oldest", 1, 10, 40),
      unit("middle", 11, 20, 40),
      unit("recent", 21, 30, 50),
    ]);

    const plan = createContextCompactionPlanner().plan({
      history: index,
      policy: policy(60, 40),
      reason: "PROACTIVE_PRESSURE",
    });

    expect(plan).toMatchObject({
      selectedUnitIds: ["oldest", "middle"],
      retainedUnitIds: ["recent"],
      estimatedTokensBefore: 130,
      selectedTokens: 80,
      targetRecentTailTokens: 60,
    });
    expect(plan?.sourceRange.firstSequence).toBe(1);
    expect(plan?.sourceRange.lastSequence).toBe(20);
  });

  it("never selects open or ineligible protocol units and respects the minimum tail", () => {
    const index = history([
      unit("oldest", 1, 10, 50),
      unit("middle", 11, 20, 50),
      unit("open-protocol", 21, 24, 20, { status: "OPEN", compactionEligible: false }),
    ]);

    const plan = createContextCompactionPlanner().plan({
      history: index,
      policy: policy(70, 60),
      reason: "FORCED_PROVIDER_OVERFLOW",
    });

    expect(plan?.selectedUnitIds).toEqual(["oldest"]);
    expect(plan?.retainedUnitIds).toEqual(["middle", "open-protocol"]);
    expect(plan?.selectedUnitIds).not.toContain("open-protocol");
  });

  it("treats a closed Tool protocol as atomic and does not double-count its turn view", () => {
    const conversation = unit("turn-view", 1, 10, 50);
    const protocol: ToolProtocolUnit = {
      ...unit("tool-view", 5, 10, 20, { kind: "TOOL_PROTOCOL" }),
      kind: "TOOL_PROTOCOL",
      messages: conversation.messages.slice(4),
      sourceAssistantMessageId: agentMessageId("amsg_tool_call"),
      toolCallIds: ["call_1"],
      toolResultMessageIds: [agentMessageId("amsg_tool_result")],
    };
    const index = history([conversation, protocol, unit("recent", 11, 20, 60)]);

    const plan = createContextCompactionPlanner().plan({
      history: index,
      policy: policy(60, 40),
      reason: "SELECTION_PRESSURE",
    });

    expect(plan?.selectedUnitIds).toEqual(["turn-view"]);
    expect(plan?.selectedTokens).toBe(50);
    expect(plan?.selectedUnitIds).not.toContain("tool-view");
  });

  it("is deterministic for recreated unit arrays and fails closed at a turn boundary", () => {
    const original = history([unit("a", 1, 10, 50), unit("b", 11, 20, 50)]);
    const secondUnit = original.units[1]!;
    const firstUnit = original.units[0]!;
    const recreated = history([
      { ...secondUnit, messages: [...secondUnit.messages] },
      { ...firstUnit, messages: [...firstUnit.messages] },
    ]);

    const first = createContextCompactionPlanner().plan({
      history: original,
      policy: policy(40, 30),
      reason: "SELECTION_PRESSURE",
    });
    const second = createContextCompactionPlanner().plan({
      history: recreated,
      policy: policy(40, 30),
      reason: "SELECTION_PRESSURE",
    });

    expect(second).toEqual(first);
    expect(first?.sourceRange.conversationTurnId).toBe(turnId);
  });

  it("excludes V2-covered durable history but keeps a V1 checkpoint auxiliary only", () => {
    const indexed = history([unit("covered", 1, 10, 40), unit("new", 11, 20, 40)]);
    const v2 = prepareContextCompactionCandidates({
      history: indexed,
      latestCheckpoint: checkpoint(1, 10),
    });
    expect(v2.history.units.map((candidate) => candidate.id)).toEqual(["new"]);
    expect(v2.previousCheckpoint?.goal).toBe("goal");
    expect(v2.trustedPreviousCheckpointId).toBe("checkpoint_v2");

    const v1: LegacyContextCheckpointRecordV1 = {
      ...checkpoint(1, 10),
      checkpointId: "checkpoint_v1",
      runId: String(runId),
      schemaVersion: 1,
      sourceSequenceFrom: 1,
      sourceSequenceTo: 10,
      modelRef: { providerId: "test", modelId: "phase-7d" },
    };
    const legacy = prepareContextCompactionCandidates({
      history: indexed,
      latestCheckpoint: v1,
    });
    expect(legacy.history.units.map((candidate) => candidate.id)).toEqual(["new"]);
    expect(legacy.previousCheckpoint?.goal).toBe("goal");
    expect(legacy.trustedPreviousCheckpointId).toBeUndefined();
  });
});
