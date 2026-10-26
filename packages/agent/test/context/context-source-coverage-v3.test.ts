import { describe, expect, it } from "vitest";
import {
  ContextPlanningError,
  createContextCheckpointId,
  createContextIncrementalCoverageResolverV3,
  createContextMessageRange,
  createContextSummaryPromptVersion,
  createContextSourceCoverage,
  createStructuredCheckpointV2,
} from "@caelush/agent";
import type { ContextCheckpointRecordV3 } from "@caelush/agent";
import {
  assistantMessage,
  snapshot,
  turn,
  userMessage,
  toolResultMessage,
  RUN_ID,
  OTHER_RUN_ID,
  SESSION_ID,
} from "../messages/fixtures.js";

function range(
  runId: string,
  first: ReturnType<typeof userMessage>,
  last: ReturnType<typeof assistantMessage> | ReturnType<typeof userMessage>,
  firstSequence: number,
  lastSequence: number,
) {
  return createContextMessageRange({
    runId: runId as never,
    conversationTurnId: first.message.conversationTurnId,
    firstMessageId: first.message.id,
    lastMessageId: last.message.id,
    firstSequence,
    lastSequence,
  });
}

describe("Session-scoped V3 source coverage", () => {
  it("accepts canonical multi-Run coverage when every Run sequence starts at one", () => {
    const runA = RUN_ID;
    const runB = OTHER_RUN_ID;
    const runC = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9f";
    const a1 = userMessage({ runId: runA, sequence: 1, text: "A start" });
    const a2 = assistantMessage({ runId: runA, sequence: 2, text: "A done" });
    const b1 = userMessage({ runId: runB, sequence: 1, text: "B start" });
    const b2 = assistantMessage({ runId: runB, sequence: 2, text: "B done" });
    const c1 = userMessage({ runId: runC, sequence: 1, text: "current goal" });
    const conversation = snapshot(
      [
        turn([a1, a2], { runId: runA, status: "CLOSED", openedAt: 1 }),
        turn([b1, b2], { runId: runB, status: "CLOSED", openedAt: 2 }),
        turn([c1], { runId: runC, status: "OPEN", openedAt: 3 }),
      ],
      { runId: runC },
    );

    const coverage = createContextSourceCoverage({
      sessionId: SESSION_ID as never,
      conversation,
      segments: [range(runA, a1, a2, 1, 2), range(runB, b1, b2, 1, 2)],
    });

    expect(coverage).toMatchObject({ version: 1, messageCount: 4 });
    expect(coverage.segments).toHaveLength(2);
    expect(
      coverage.segments.map((segment) => [segment.firstSequence, segment.lastSequence]),
    ).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(coverage.coverageDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("extends A/B coverage for a new owner Run without comparing owner identity to source Runs", () => {
    const runA = RUN_ID;
    const runB = OTHER_RUN_ID;
    const runC = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9f";
    const runD = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e8f";
    const a = userMessage({ runId: runA, sequence: 1, text: "A" });
    const b = userMessage({ runId: runB, sequence: 1, text: "B" });
    const c = userMessage({ runId: runC, sequence: 1, text: "C" });
    const d = userMessage({ runId: runD, sequence: 1, text: "D current goal" });
    const conversation = snapshot(
      [
        turn([a], { runId: runA, status: "CLOSED", openedAt: 1 }),
        turn([b], { runId: runB, status: "CLOSED", openedAt: 2 }),
        turn([c], { runId: runC, status: "CLOSED", openedAt: 3 }),
        turn([d], { runId: runD, status: "OPEN", openedAt: 4 }),
      ],
      { runId: runD },
    );
    const rangeA = range(runA, a, a, 1, 1);
    const rangeB = range(runB, b, b, 1, 1);
    const rangeC = range(runC, c, c, 1, 1);
    const priorCoverage = createContextSourceCoverage({
      sessionId: SESSION_ID as never,
      conversation,
      segments: [rangeA, rangeB],
    });
    const priorCheckpoint: ContextCheckpointRecordV3 = {
      checkpointId: createContextCheckpointId("checkpoint-owner-c"),
      schemaVersion: 3,
      ownerRunId: runC as never,
      ownerStepSequence: 1,
      sessionId: SESSION_ID as never,
      activationOperationId: "operation-owner-c",
      coverage: priorCoverage,
      structuredCheckpoint: createStructuredCheckpointV2({
        version: 2,
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
        verificationState: "UNKNOWN",
        activeProcesses: [],
        pendingApprovals: [],
        resourceGovernance: "UNKNOWN",
        criticalReferences: [],
        nextIntent: "continue",
        sourceCoverage: priorCoverage,
      }),
      tokensBefore: 100_000,
      tokensAfter: 10_000,
      modelRef: { provider: "fixture", model: "fixture" },
      summaryPromptVersion: createContextSummaryPromptVersion(4),
      sourceDigest: "a".repeat(64),
      checkpointDigest: "b".repeat(64),
      degraded: false,
      reason: "PROACTIVE_PRESSURE",
      targetStatus: "DEEP",
      createdAt: 4 as never,
    };

    const result = createContextIncrementalCoverageResolverV3().resolve({
      sessionId: SESSION_ID as never,
      conversation,
      latest: priorCheckpoint,
      sourceCoverageDelta: [rangeC],
    });

    expect(result.previousCheckpoint?.ownerRunId).toBe(runC);
    expect(result.cumulativeCoverage.segments.map((segment) => segment.runId)).toEqual([
      runA,
      runB,
      runC,
    ]);
    expect(result.newSourceMessages.map((stored) => stored.message.id)).toEqual([c.message.id]);
  });

  it("rejects cross-Session, duplicate, gapped, and partial Tool protocol coverage", () => {
    const run = RUN_ID;
    const first = userMessage({ runId: run, sequence: 1 });
    const second = assistantMessage({ runId: run, sequence: 2, text: "middle" });
    const third = userMessage({ runId: run, sequence: 3 });
    const conversation = snapshot(
      [turn([first, second, third], { runId: run, status: "CLOSED" })],
      { runId: run },
    );
    const firstOnly = range(run, first, first, 1, 1);
    const thirdOnly = range(run, third, third, 3, 3);

    expect(
      createContextSourceCoverage({
        sessionId: SESSION_ID as never,
        conversation,
        // A leading message can remain literal while the following closed history is compacted.
        segments: [
          createContextMessageRange({
            runId: run as never,
            conversationTurnId: second.message.conversationTurnId,
            firstMessageId: second.message.id,
            lastMessageId: second.message.id,
            firstSequence: 2,
            lastSequence: 2,
          }),
        ],
      }).messageCount,
    ).toBe(1);

    expect(() =>
      createContextSourceCoverage({
        sessionId: "ses_different" as never,
        conversation,
        segments: [firstOnly],
      }),
    ).toThrow(ContextPlanningError);
    expect(() =>
      createContextSourceCoverage({
        sessionId: SESSION_ID as never,
        conversation,
        segments: [firstOnly, firstOnly],
      }),
    ).toThrow(ContextPlanningError);
    expect(() =>
      createContextSourceCoverage({
        sessionId: SESSION_ID as never,
        conversation,
        segments: [firstOnly, thirdOnly],
      }),
    ).toThrow(ContextPlanningError);

    const assistant = assistantMessage({ runId: run, sequence: 2, toolCalls: ["call_pair"] });
    const result = toolResultMessage({ runId: run, sequence: 3, toolCallId: "call_pair" });
    const toolTurn = turn([first, assistant, result], { runId: run, status: "CLOSED" });
    const toolConversation = snapshot([toolTurn], { runId: run });
    expect(() =>
      createContextSourceCoverage({
        sessionId: SESSION_ID as never,
        conversation: toolConversation,
        segments: [range(run, first, assistant, 1, 2)],
      }),
    ).toThrow(ContextPlanningError);
  });
});
