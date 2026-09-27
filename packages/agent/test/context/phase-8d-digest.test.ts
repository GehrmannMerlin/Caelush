import { describe, expect, it } from "vitest";

import {
  createContextCompactionDigestBuilder,
  createContextMessageRange,
  createContextCheckpointId,
  createStructuredCheckpoint,
  conversationTurnId,
  type ContextCheckpointRecordV2,
  type ContextCompactionDigestBuilder,
  type StoredAgentMessage,
} from "@caelush/agent";
import { createRunId } from "@caelush/protocol";

import { userMessage } from "../messages/fixtures.js";

const runId = createRunId();
const sourceRange = createContextMessageRange({
  runId,
  conversationTurnId: conversationTurnId("cturn_phase_8d_digest"),
  firstMessageId: "amsg_phase_8d_first" as never,
  lastMessageId: "amsg_phase_8d_last" as never,
  firstSequence: 1,
  lastSequence: 3,
});
const cumulativeRange = createContextMessageRange({
  ...sourceRange,
  lastMessageId: "amsg_phase_8d_cumulative_last" as never,
  lastSequence: 6,
});

function checkpoint(): ContextCheckpointRecordV2 {
  return {
    checkpointId: createContextCheckpointId("checkpoint:phase-8d:previous"),
    runId,
    schemaVersion: 2,
    sourceRange,
    structuredCheckpoint: createStructuredCheckpoint({
      version: 1,
      goal: "goal",
      constraints: [],
      completedWork: ["work"],
      inProgress: [],
      blocked: [],
      importantDiscoveries: [],
      keyDecisions: [],
      changedFiles: [],
      readFiles: [],
      recentErrors: [],
      verificationState: "CURRENT",
      activeProcesses: [],
      pendingApprovals: [],
      resourceGovernance: "BOUNDED",
      criticalReferences: [],
      nextIntent: "continue",
      sourceRange: { from: 1, to: 3 },
    }),
    tokensBefore: 100,
    tokensAfter: 20,
    modelRef: { provider: "fixture", model: "fixture" },
    summaryPromptVersion: 2,
    sourceDigest: "previous-source",
    checkpointDigest: "previous-checkpoint",
    degraded: false,
    reason: "PROACTIVE_PRESSURE",
    createdAt: 100 as never,
  };
}

const sourceMessages: readonly StoredAgentMessage[] = [
  userMessage({ runId, sequence: 4, text: "new source" }),
  userMessage({ runId, sequence: 5, text: "new source two" }),
];

function input(overrides: Partial<Parameters<ContextCompactionDigestBuilder["source"]>[0]> = {}) {
  return {
    semanticSourceDigest: "semantic-source",
    previousCheckpoint: checkpoint(),
    newSourceMessages: sourceMessages,
    newSourceRange: sourceRange,
    cumulativeSourceRange: cumulativeRange,
    ...overrides,
  };
}

describe("Phase 8D durable context compaction digests", () => {
  it("is byte-for-byte deterministic for the same source and checkpoint input", () => {
    const builder = createContextCompactionDigestBuilder();

    expect(builder.source(input())).toBe(builder.source(input()));
    expect(
      builder.checkpoint({
        structuredCheckpoint: checkpoint().structuredCheckpoint,
        sourceRange,
      }),
    ).toBe(
      builder.checkpoint({
        structuredCheckpoint: checkpoint().structuredCheckpoint,
        sourceRange,
      }),
    );
  });

  it.each([
    [
      "previous checkpoint id",
      {
        previousCheckpoint: {
          ...checkpoint(),
          checkpointId: createContextCheckpointId("checkpoint:phase-8d:other"),
        },
      },
    ],
    [
      "previous checkpoint digest",
      { previousCheckpoint: { ...checkpoint(), checkpointDigest: "other" } },
    ],
    ["semantic source", { semanticSourceDigest: "semantic-source-other" }],
    [
      "message identity",
      {
        newSourceMessages: [
          {
            ...sourceMessages[0]!,
            message: { ...sourceMessages[0]!.message, id: "amsg_phase_8d_other" as never },
          },
          sourceMessages[1]!,
        ],
      },
    ],
    [
      "message schema version",
      { newSourceMessages: [{ ...sourceMessages[0]!, schemaVersion: 2 }, sourceMessages[1]!] },
    ],
    [
      "message projection version",
      {
        newSourceMessages: [
          { ...sourceMessages[0]!, modelProjectionVersion: 2 },
          sourceMessages[1]!,
        ],
      },
    ],
    ["source range", { newSourceRange: { ...sourceRange, lastSequence: 4 } }],
  ] as const)("binds %s in the durable source digest", (_label, change) => {
    const builder = createContextCompactionDigestBuilder();
    expect(builder.source(input())).not.toBe(builder.source(input(change)));
  });

  it("binds the V2 schema and complete source range into the checkpoint digest", () => {
    const builder = createContextCompactionDigestBuilder();
    const base = builder.checkpoint({
      structuredCheckpoint: checkpoint().structuredCheckpoint,
      sourceRange,
    });

    expect(
      builder.checkpoint({
        structuredCheckpoint: checkpoint().structuredCheckpoint,
        sourceRange: { ...sourceRange, lastSequence: 4 },
      }),
    ).not.toBe(base);
    expect(
      builder.checkpoint({
        structuredCheckpoint: createStructuredCheckpoint({
          ...checkpoint().structuredCheckpoint,
          nextIntent: "changed",
        }),
        sourceRange,
      }),
    ).not.toBe(base);
  });
});
