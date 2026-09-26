import { describe, expect, it } from "vitest";

import { createRunId, createSessionId, createTimestampMs } from "@caelush/protocol";
import {
  CONTEXT_COMPACTION_REASONS,
  createContextCheckpointId,
  createContextMessageRange,
  createContextSummaryPromptVersion,
  createStructuredCheckpoint,
  type AgentExecutionIdentity,
  type ContextAuthoritySnapshot,
  type ContextCheckpointRecordV2,
  type ContextCheckpointRef,
  type ContextCompactionPlan,
  type ContextMessageRange,
  type ContextSummarizationInput,
  type RehydratedContextState,
  type StructuredCheckpoint,
} from "@caelush/agent";
import { agentMessageId, conversationTurnId, type StoredAgentMessage } from "@caelush/agent";
import type { ModelDescriptor } from "@caelush/ai";

const identity: AgentExecutionIdentity = {
  runId: createRunId(),
  sessionId: createSessionId(),
  goal: "Ship semantic context compaction.",
};

const sourceRange: ContextMessageRange = createContextMessageRange({
  runId: identity.runId,
  conversationTurnId: conversationTurnId("cturn_phase_7d"),
  firstMessageId: agentMessageId("amsg_phase_7d_first"),
  lastMessageId: agentMessageId("amsg_phase_7d_last"),
  firstSequence: 10,
  lastSequence: 20,
});

const checkpoint = createStructuredCheckpoint({
  version: 1,
  goal: identity.goal,
  constraints: ["Keep production compatibility."],
  completedWork: ["Phase 7C"],
  inProgress: ["Phase 7D"],
  blocked: [],
  importantDiscoveries: ["Durable sequence is the source identity."],
  keyDecisions: ["V2 is a parallel target path."],
  changedFiles: ["packages/agent/src/context"],
  readFiles: ["spec.md"],
  recentErrors: [],
  verificationState: "focused tests pending",
  activeProcesses: [],
  pendingApprovals: [],
  resourceGovernance: "bounded",
  criticalReferences: ["spec.md"],
  nextIntent: "Implement the planner.",
  sourceRange: { from: 10, to: 20 },
});

const model: ModelDescriptor = {
  ref: { provider: "test", model: "phase-7d" },
  api: "test-api",
  limits: { contextWindowTokens: 10_000, maxOutputTokens: 1_000 },
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

describe("Phase 7D canonical contracts", () => {
  it("freezes the V1 StructuredCheckpoint payload and its nested values", () => {
    expect(checkpoint.version).toBe(1);
    expect(checkpoint.sourceRange).toEqual({ from: 10, to: 20 });
    expect(Object.isFrozen(checkpoint)).toBe(true);
    expect(Object.isFrozen(checkpoint.constraints)).toBe(true);
    expect(Object.isFrozen(checkpoint.sourceRange)).toBe(true);
    expect(() => (checkpoint.constraints as string[]).push("mutation")).toThrow();
  });

  it("keeps the exact compaction reason vocabulary", () => {
    expect(CONTEXT_COMPACTION_REASONS).toEqual([
      "PROACTIVE_PRESSURE",
      "SELECTION_PRESSURE",
      "FORCED_PROVIDER_OVERFLOW",
    ]);
  });

  it("freezes durable source identity and the V2 reference", () => {
    const ref: ContextCheckpointRef = {
      checkpointId: createContextCheckpointId("checkpoint_7d"),
      schemaVersion: 2,
      sourceRange,
      degraded: false,
    };
    const plan: ContextCompactionPlan = {
      reason: "SELECTION_PRESSURE",
      sourceRange,
      selectedUnitIds: ["conversation:one"],
      retainedUnitIds: ["conversation:two"],
      estimatedTokensBefore: 100,
      selectedTokens: 40,
      targetRecentTailTokens: 60,
    };

    expect(Object.isFrozen(sourceRange)).toBe(true);
    expect(Object.isFrozen(ref)).toBe(false);
    expect(plan.sourceRange.firstSequence).toBe(10);
    expect(plan.sourceRange.lastSequence).toBe(20);
  });

  it("expresses V2 records, summarization inputs, and authority snapshots without widening them", () => {
    const record: ContextCheckpointRecordV2 = {
      checkpointId: createContextCheckpointId("checkpoint_7d_record"),
      runId: identity.runId,
      schemaVersion: 2,
      sourceRange,
      structuredCheckpoint: checkpoint,
      tokensBefore: 100,
      tokensAfter: 45,
      modelRef: model.ref,
      summaryPromptVersion: createContextSummaryPromptVersion(1),
      sourceDigest: "sha256:source",
      checkpointDigest: "sha256:checkpoint",
      degraded: false,
      reason: "PROACTIVE_PRESSURE",
      createdAt: createTimestampMs(1),
    };
    const authorities: ContextAuthoritySnapshot = {
      goal: "Current goal",
      changedFiles: [],
      pendingApprovals: ["approval-1"],
      activeProcesses: [],
      verificationState: "passed",
      resourceGovernance: "bounded",
      projectFacts: [],
    };
    const sourceMessages: readonly StoredAgentMessage[] = [];
    const input: ContextSummarizationInput = {
      identity,
      reason: "PROACTIVE_PRESSURE",
      previousCheckpoint: checkpoint,
      sourceMessages,
      sourceRange,
      authorities,
      targetTokens: 45,
      model,
    };
    const state: RehydratedContextState = {
      goal: "Current goal",
      changedFiles: [],
      pendingApprovals: ["approval-1"],
      activeProcesses: [],
      verificationState: "passed",
      resourceGovernance: "bounded",
      projectFacts: [],
      checkpoint,
    };

    expect(record.schemaVersion).toBe(2);
    expect(input.sourceRange).toBe(sourceRange);
    expect(state.changedFiles).toEqual([]);
  });
});
