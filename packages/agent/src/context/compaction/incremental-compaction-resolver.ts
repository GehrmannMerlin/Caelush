import type { AgentConversationSnapshot } from "../../messages/conversation/conversation-snapshot.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import { ContextPlanningError } from "../planner/context-planning-errors.js";
import {
  createContextMessageRange,
  type ContextCheckpointRecordV2,
  type ContextCompactionPlan,
  type ContextMessageRange,
} from "./context-compaction-contracts.js";
import type { IncrementalCheckpointState } from "./incremental-checkpoint-resolver.js";

export interface ContextIncrementalCompactionInput {
  readonly previousCheckpoint?: ContextCheckpointRecordV2;
  readonly newSourceMessages: readonly StoredAgentMessage[];
  readonly cumulativeSourceRange: ContextMessageRange;
  readonly newSourceRange: ContextMessageRange;
}

export interface ContextIncrementalCompactionResolver {
  resolve(input: {
    readonly plan: ContextCompactionPlan;
    readonly latest: IncrementalCheckpointState;
    readonly conversation: AgentConversationSnapshot;
  }): ContextIncrementalCompactionInput;
}

export function createContextIncrementalCompactionResolver(): ContextIncrementalCompactionResolver {
  return Object.freeze({
    resolve(input: {
      readonly plan: ContextCompactionPlan;
      readonly latest: IncrementalCheckpointState;
      readonly conversation: AgentConversationSnapshot;
    }): ContextIncrementalCompactionInput {
      const newSourceRange = input.plan.sourceRange;
      const previousCheckpoint = input.latest.kind === "V2" ? input.latest.checkpoint : undefined;
      if (
        previousCheckpoint !== undefined &&
        (String(previousCheckpoint.runId) !== String(newSourceRange.runId) ||
          String(previousCheckpoint.sourceRange.conversationTurnId) !==
            String(newSourceRange.conversationTurnId) ||
          newSourceRange.firstSequence <= previousCheckpoint.sourceRange.lastSequence)
      ) {
        throw new ContextPlanningError("INCONSISTENT_PLAN");
      }

      const newSourceMessages = selectNewSourceMessages(input.conversation, newSourceRange);
      const cumulativeSourceRange =
        previousCheckpoint === undefined
          ? newSourceRange
          : createContextMessageRange({
              runId: newSourceRange.runId,
              conversationTurnId: previousCheckpoint.sourceRange.conversationTurnId,
              firstMessageId: previousCheckpoint.sourceRange.firstMessageId,
              lastMessageId: newSourceRange.lastMessageId,
              firstSequence: previousCheckpoint.sourceRange.firstSequence,
              lastSequence: newSourceRange.lastSequence,
            });

      return Object.freeze({
        ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
        newSourceMessages: Object.freeze([...newSourceMessages]),
        cumulativeSourceRange,
        newSourceRange,
      });
    },
  });
}

function selectNewSourceMessages(
  conversation: AgentConversationSnapshot,
  range: ContextMessageRange,
): readonly StoredAgentMessage[] {
  const selected = conversation.turns
    .flatMap((turn) => turn.messages)
    .filter(
      (stored) =>
        stored.message.audience.model &&
        String(stored.message.runId) === String(range.runId) &&
        String(stored.message.conversationTurnId) === String(range.conversationTurnId) &&
        stored.sequence >= range.firstSequence &&
        stored.sequence <= range.lastSequence,
    );
  const first = selected[0];
  const last = selected[selected.length - 1];
  if (
    first === undefined ||
    last === undefined ||
    String(first.message.id) !== String(range.firstMessageId) ||
    String(last.message.id) !== String(range.lastMessageId) ||
    first.sequence !== range.firstSequence ||
    last.sequence !== range.lastSequence
  ) {
    throw new ContextPlanningError("INCONSISTENT_PLAN");
  }
  return selected;
}
