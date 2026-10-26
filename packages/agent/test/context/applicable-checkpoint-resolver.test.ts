import { describe, expect, it } from "vitest";
import {
  createContextCheckpointId,
  createContextMessageRange,
  createContextSummaryPromptVersion,
  createStructuredCheckpoint,
  resolveApplicableCheckpoint,
  type ContextCheckpointRecordV2,
} from "@caelush/agent";
import {
  assistantMessage,
  snapshot,
  turn,
  userMessage,
  RUN_ID,
  OTHER_RUN_ID,
  SESSION_ID,
} from "../messages/fixtures.js";

describe("applicable Context checkpoint resolution", () => {
  it("does not trust a historical V2 record until its activation reader proves the Surface", async () => {
    const sourceUser = userMessage({ runId: RUN_ID, sequence: 1, text: "old request" });
    const sourceAssistant = assistantMessage({ runId: RUN_ID, sequence: 2, text: "old answer" });
    const currentUser = userMessage({ runId: OTHER_RUN_ID, sequence: 1, text: "continue" });
    const conversation = snapshot(
      [
        turn([sourceUser, sourceAssistant], { runId: RUN_ID, status: "CLOSED", openedAt: 1 }),
        turn([currentUser], { runId: OTHER_RUN_ID, status: "OPEN", openedAt: 2 }),
      ],
      { runId: OTHER_RUN_ID },
    );
    const sourceRange = createContextMessageRange({
      runId: RUN_ID as never,
      conversationTurnId: sourceUser.message.conversationTurnId,
      firstMessageId: sourceUser.message.id,
      lastMessageId: sourceAssistant.message.id,
      firstSequence: 1,
      lastSequence: 2,
    });
    const checkpoint: ContextCheckpointRecordV2 = {
      checkpointId: createContextCheckpointId("checkpoint:historical-v2"),
      runId: RUN_ID as never,
      schemaVersion: 2,
      sourceRange,
      structuredCheckpoint: createStructuredCheckpoint({
        version: 1,
        goal: "old request",
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
        sourceRange: { from: 1, to: 2 },
      }),
      tokensBefore: 100,
      tokensAfter: 20,
      modelRef: { provider: "fixture", model: "fixture" },
      summaryPromptVersion: createContextSummaryPromptVersion(3),
      sourceDigest: "source",
      checkpointDigest: "checkpoint",
      degraded: false,
      reason: "SELECTION_PRESSURE",
      createdAt: 3 as never,
    };

    await expect(
      resolveApplicableCheckpoint({
        conversation,
        candidates: [checkpoint],
        activationReader: {
          async isActivated() {
            return false;
          },
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveApplicableCheckpoint({
        conversation,
        candidates: [checkpoint],
        activationReader: {
          async isActivated() {
            return true;
          },
        },
      }),
    ).resolves.toBe(checkpoint);
    expect(String(conversation.sessionId)).toBe(SESSION_ID);
  });
});
