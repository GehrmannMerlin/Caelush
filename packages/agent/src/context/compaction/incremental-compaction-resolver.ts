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
import type { ContextCheckpointRecordV3 } from "./context-checkpoint-v3.js";
import {
  createContextSourceCoverage,
  extendContextSourceCoverage,
  type ContextSourceCoverage,
} from "./context-source-coverage.js";

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

export interface ContextIncrementalCoverageResolutionV3 {
  readonly previousCheckpoint?: ContextCheckpointRecordV3;
  readonly sourceCoverageDelta: readonly ContextMessageRange[];
  readonly cumulativeCoverage: ContextSourceCoverage;
  readonly newSourceMessages: readonly StoredAgentMessage[];
}

/** Incremental Session resolver that tracks source coverage independently from owner Run. */
export interface ContextIncrementalCoverageResolverV3 {
  resolve(input: {
    readonly sessionId: import("@caelush/protocol").SessionId;
    readonly conversation: AgentConversationSnapshot;
    readonly latest?: ContextCheckpointRecordV3;
    readonly sourceCoverageDelta: readonly ContextMessageRange[];
  }): ContextIncrementalCoverageResolutionV3;
}

export function createContextIncrementalCoverageResolverV3(): ContextIncrementalCoverageResolverV3 {
  return Object.freeze({
    resolve(input: Parameters<ContextIncrementalCoverageResolverV3["resolve"]>[0]) {
      if (
        String(input.sessionId) !== String(input.conversation.sessionId) ||
        (input.latest !== undefined && String(input.latest.sessionId) !== String(input.sessionId))
      ) {
        throw new ContextPlanningError("INCONSISTENT_PLAN");
      }
      const cumulativeCoverage =
        input.latest === undefined
          ? createContextSourceCoverage({
              sessionId: input.sessionId,
              segments: input.sourceCoverageDelta,
              conversation: input.conversation,
            })
          : extendContextSourceCoverage({
              previous: input.latest.coverage,
              sessionId: input.sessionId,
              additions: input.sourceCoverageDelta,
              conversation: input.conversation,
            });
      const newSourceMessages = selectCoverageDeltaMessages(
        input.conversation,
        input.sourceCoverageDelta,
      );
      return Object.freeze({
        ...(input.latest === undefined ? {} : { previousCheckpoint: input.latest }),
        sourceCoverageDelta: Object.freeze([...input.sourceCoverageDelta]),
        cumulativeCoverage,
        newSourceMessages: Object.freeze(newSourceMessages),
      });
    },
  });
}

function selectCoverageDeltaMessages(
  conversation: AgentConversationSnapshot,
  segments: readonly ContextMessageRange[],
): StoredAgentMessage[] {
  const selected: StoredAgentMessage[] = [];
  const selectedIds = new Set<string>();
  for (const segment of segments) {
    const turn = conversation.turns.find(
      (candidate) =>
        String(candidate.runId) === String(segment.runId) &&
        String(candidate.id) === String(segment.conversationTurnId),
    );
    if (turn === undefined || String(turn.sessionId) !== String(conversation.sessionId)) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }
    const messages = turn.messages.filter(
      (stored) =>
        stored.message.audience.model &&
        stored.sequence >= segment.firstSequence &&
        stored.sequence <= segment.lastSequence,
    );
    if (
      messages.length !== segment.lastSequence - segment.firstSequence + 1 ||
      String(messages[0]?.message.id) !== String(segment.firstMessageId) ||
      String(messages.at(-1)?.message.id) !== String(segment.lastMessageId)
    ) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }
    for (const stored of messages) {
      if (selectedIds.has(String(stored.message.id))) {
        throw new ContextPlanningError("INCONSISTENT_PLAN");
      }
      selectedIds.add(String(stored.message.id));
      selected.push(stored);
    }
  }
  return selected;
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
