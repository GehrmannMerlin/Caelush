import type { AgentConversationSnapshot } from "../../messages/conversation/conversation-snapshot.js";
import type { SessionId } from "@caelush/protocol";
import type {
  ContextCheckpointRecordV2,
  LegacyContextCheckpointRecordV1,
} from "./context-compaction-contracts.js";
import type { ContextCheckpointRecordV3 } from "./context-checkpoint-v3.js";
import { assertContextCheckpointRecordV3 } from "./context-checkpoint-v3.js";
import { createContextSourceCoverage } from "./context-source-coverage.js";
import { ContextPlanningError } from "../planner/context-planning-errors.js";

export type ApplicableContextCheckpoint =
  ContextCheckpointRecordV3 | ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1;

export interface ContextCheckpointActivationReaderPort {
  /** V3 proof is written with activation; V1/V2 require a verified historical Surface and event. */
  isActivated(input: {
    readonly checkpoint: ApplicableContextCheckpoint;
    readonly sessionId: SessionId;
  }): Promise<boolean>;
}

/** Session-bounded lookup supplied by the host, with activation and message coverage verified here. */
export interface ContextSessionCheckpointResolverPort {
  resolve(input: {
    readonly conversation: AgentConversationSnapshot;
    readonly throughRunId: import("@caelush/protocol").RunId;
  }): Promise<ApplicableContextCheckpoint | undefined>;
}

/** Choose the newest visible, integrity-valid checkpoint with an activation proof. */
export async function resolveApplicableCheckpoint(input: {
  readonly conversation: AgentConversationSnapshot;
  readonly candidates: readonly ApplicableContextCheckpoint[];
  readonly activationReader: ContextCheckpointActivationReaderPort;
}): Promise<ApplicableContextCheckpoint | undefined> {
  for (const candidate of input.candidates) {
    const ownerRunId = candidate.schemaVersion === 3 ? candidate.ownerRunId : candidate.runId;
    const ownerTurnIndex = input.conversation.turns.findIndex(
      (turn) => String(turn.runId) === String(ownerRunId),
    );
    if (ownerTurnIndex < 0) continue;
    const ownerTurn = input.conversation.turns[ownerTurnIndex];
    const currentTurnIndex = input.conversation.turns.findIndex(
      (turn) => String(turn.runId) === String(input.conversation.currentRunId),
    );
    if (
      ownerTurn === undefined ||
      String(ownerTurn.sessionId) !== String(input.conversation.sessionId) ||
      currentTurnIndex < 0 ||
      ownerTurnIndex > currentTurnIndex ||
      (ownerTurnIndex < currentTurnIndex && ownerTurn.status !== "CLOSED")
    ) {
      continue;
    }

    assertCandidateCoverage(candidate, input.conversation);
    if (
      await input.activationReader.isActivated({
        checkpoint: candidate,
        sessionId: input.conversation.sessionId,
      })
    ) {
      return candidate;
    }
  }
  return undefined;
}

function assertCandidateCoverage(
  candidate: ApplicableContextCheckpoint,
  conversation: AgentConversationSnapshot,
): void {
  if (candidate.schemaVersion === 3) {
    assertContextCheckpointRecordV3(candidate);
    if (String(candidate.sessionId) !== String(conversation.sessionId)) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }
    const coverage = createContextSourceCoverage({
      sessionId: conversation.sessionId,
      segments: candidate.coverage.segments,
      conversation,
    });
    if (
      coverage.messageCount !== candidate.coverage.messageCount ||
      coverage.coverageDigest !== candidate.coverage.coverageDigest
    ) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }
    return;
  }

  if (candidate.schemaVersion === 2) {
    const range = candidate.sourceRange;
    const turn = conversation.turns.find(
      (entry) =>
        String(entry.runId) === String(range.runId) &&
        String(entry.id) === String(range.conversationTurnId),
    );
    assertRangeExists(
      turn,
      range.firstSequence,
      range.lastSequence,
      range.firstMessageId,
      range.lastMessageId,
    );
    return;
  }

  if (
    !Number.isSafeInteger(candidate.sourceSequenceFrom) ||
    !Number.isSafeInteger(candidate.sourceSequenceTo) ||
    candidate.sourceSequenceFrom < 0 ||
    candidate.sourceSequenceTo < candidate.sourceSequenceFrom
  ) {
    throw new ContextPlanningError("INCONSISTENT_PLAN");
  }
  const turn = conversation.turns.find((entry) => String(entry.runId) === String(candidate.runId));
  assertRangeExists(turn, candidate.sourceSequenceFrom, candidate.sourceSequenceTo);
}

function assertRangeExists(
  turn: AgentConversationSnapshot["turns"][number] | undefined,
  firstSequence: number,
  lastSequence: number,
  firstMessageId?: string,
  lastMessageId?: string,
): void {
  if (turn === undefined) throw new ContextPlanningError("INCONSISTENT_PLAN");
  const messages = turn.messages.filter(
    (stored) =>
      stored.message.audience.model &&
      stored.sequence >= firstSequence &&
      stored.sequence <= lastSequence,
  );
  if (
    messages.length === 0 ||
    messages.length !== lastSequence - firstSequence + 1 ||
    messages[0]?.sequence !== firstSequence ||
    messages.at(-1)?.sequence !== lastSequence ||
    (firstMessageId !== undefined && String(messages[0]?.message.id) !== String(firstMessageId)) ||
    (lastMessageId !== undefined && String(messages.at(-1)?.message.id) !== String(lastMessageId))
  ) {
    throw new ContextPlanningError("INCONSISTENT_PLAN");
  }
}
