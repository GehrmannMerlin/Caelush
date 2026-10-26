import type { SessionId } from "@caelush/protocol";

import { digestJsonValue } from "../../messages/canonical-json.js";
import type { AgentConversationSnapshot } from "../../messages/conversation/conversation-snapshot.js";
import type { ContextMessageRange } from "./context-compaction-contracts.js";
import { createContextMessageRange } from "./context-compaction-contracts.js";
import { ContextPlanningError } from "../planner/context-planning-errors.js";

export interface ContextSourceCoverage {
  readonly version: 1;
  readonly sessionId: SessionId;
  readonly segments: readonly ContextMessageRange[];
  readonly messageCount: number;
  readonly coverageDigest: string;
}

export interface ContextSourceCoverageInput {
  readonly sessionId: SessionId;
  readonly segments: readonly ContextMessageRange[];
  readonly conversation: AgentConversationSnapshot;
}

/**
 * Validate and freeze a contiguous, model-visible Session prefix selected for compaction.
 * Each segment remains scoped to one Run and Turn; local message sequence values are never
 * compared across Runs.
 */
export function createContextSourceCoverage(
  input: ContextSourceCoverageInput,
): ContextSourceCoverage {
  if (String(input.sessionId) !== String(input.conversation.sessionId)) {
    throw new ContextPlanningError("INCONSISTENT_PLAN");
  }
  if (input.segments.length === 0) throw new ContextPlanningError("INCONSISTENT_PLAN");

  const visible = input.conversation.turns.flatMap((turn) =>
    turn.messages
      .filter((stored) => stored.message.audience.model)
      .map((stored) => ({ turn, stored })),
  );
  const visibleIndex = new Map(
    visible.map((entry, index) => [String(entry.stored.message.id), index]),
  );
  const coveredIds = new Set<string>();
  const normalized: ContextMessageRange[] = [];
  let previousEnd = -1;
  let messageCount = 0;

  for (const raw of input.segments) {
    const range = createContextMessageRange(raw);
    const turn = input.conversation.turns.find(
      (candidate) =>
        String(candidate.runId) === String(range.runId) &&
        String(candidate.id) === String(range.conversationTurnId),
    );
    if (turn === undefined || String(turn.sessionId) !== String(input.sessionId)) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }
    const messages = turn.messages.filter(
      (stored) =>
        stored.message.audience.model &&
        stored.sequence >= range.firstSequence &&
        stored.sequence <= range.lastSequence,
    );
    const first = messages[0];
    const last = messages[messages.length - 1];
    if (
      first === undefined ||
      last === undefined ||
      String(first.message.id) !== String(range.firstMessageId) ||
      String(last.message.id) !== String(range.lastMessageId) ||
      first.sequence !== range.firstSequence ||
      last.sequence !== range.lastSequence ||
      messages.length !== range.lastSequence - range.firstSequence + 1
    ) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }

    const start = visibleIndex.get(String(range.firstMessageId));
    const end = visibleIndex.get(String(range.lastMessageId));
    if (start === undefined || end === undefined || start <= previousEnd || end < start) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }
    for (const { stored } of visible.slice(start, end + 1)) {
      const id = String(stored.message.id);
      if (coveredIds.has(id)) throw new ContextPlanningError("INCONSISTENT_PLAN");
      coveredIds.add(id);
      messageCount += 1;
    }

    const prior = normalized[normalized.length - 1];
    if (
      prior !== undefined &&
      String(prior.runId) === String(range.runId) &&
      String(prior.conversationTurnId) === String(range.conversationTurnId) &&
      range.firstSequence === prior.lastSequence + 1
    ) {
      normalized[normalized.length - 1] = createContextMessageRange({
        ...prior,
        lastMessageId: range.lastMessageId,
        lastSequence: range.lastSequence,
      });
    } else {
      normalized.push(range);
    }
    previousEnd = end;
  }

  // A safe current-turn split may intentionally retain a leading user message before compacting
  // complete Tool batches. After the first covered message, however, coverage must stay contiguous:
  // no later message can be hidden behind a retained middle gap.
  let coverageStarted = false;
  let retainedAfterCoverage = false;
  for (const { stored } of visible) {
    const isCovered = coveredIds.has(String(stored.message.id));
    if (isCovered) {
      if (retainedAfterCoverage) throw new ContextPlanningError("INCONSISTENT_PLAN");
      coverageStarted = true;
    } else if (coverageStarted) {
      retainedAfterCoverage = true;
    }
  }

  assertCompleteToolProtocols(input.conversation, coveredIds);
  const segments = Object.freeze(normalized);
  const coverageDigest = digestCoverage({
    version: 1,
    sessionId: input.sessionId,
    segments,
    messageCount,
  });
  return Object.freeze({
    version: 1,
    sessionId: input.sessionId,
    segments,
    messageCount,
    coverageDigest,
  });
}

export function assertContextSourceCoverage(
  value: unknown,
): asserts value is ContextSourceCoverage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("ContextSourceCoverage must be an object.");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["version", "sessionId", "segments", "messageCount", "coverageDigest"];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in record))
  ) {
    throw new TypeError("ContextSourceCoverage has an invalid shape.");
  }
  if (
    record.version !== 1 ||
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0 ||
    !Array.isArray(record.segments) ||
    !Number.isSafeInteger(record.messageCount) ||
    (record.messageCount as number) < 1 ||
    typeof record.coverageDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.coverageDigest)
  ) {
    throw new TypeError("ContextSourceCoverage fields are invalid.");
  }
  const segments = record.segments as ContextMessageRange[];
  if (segments.length === 0) throw new TypeError("ContextSourceCoverage must contain segments.");
  for (const segment of segments) createContextMessageRange(segment);
  if (
    digestCoverage({
      version: 1,
      sessionId: record.sessionId,
      segments,
      messageCount: record.messageCount as number,
    }) !== record.coverageDigest
  ) {
    throw new TypeError("ContextSourceCoverage digest does not match its content.");
  }
}

/** Add newly covered older-history segments to a checkpoint's cumulative Session coverage. */
export function extendContextSourceCoverage(input: {
  readonly previous?: ContextSourceCoverage;
  readonly sessionId: SessionId;
  readonly additions: readonly ContextMessageRange[];
  readonly conversation: AgentConversationSnapshot;
}): ContextSourceCoverage {
  if (
    input.previous !== undefined &&
    String(input.previous.sessionId) !== String(input.sessionId)
  ) {
    throw new ContextPlanningError("INCONSISTENT_PLAN");
  }
  if (input.previous !== undefined) assertContextSourceCoverage(input.previous);
  return createContextSourceCoverage({
    sessionId: input.sessionId,
    segments: [...(input.previous?.segments ?? []), ...input.additions],
    conversation: input.conversation,
  });
}

function assertCompleteToolProtocols(
  conversation: AgentConversationSnapshot,
  coveredIds: ReadonlySet<string>,
): void {
  for (const turn of conversation.turns) {
    const visibleMessages = turn.messages.filter((stored) => stored.message.audience.model);
    for (let index = 0; index < visibleMessages.length; index += 1) {
      const assistant = visibleMessages[index]?.message;
      if (assistant?.type !== "ASSISTANT") continue;
      const calls = assistant.content.filter(
        (part) => part.type === "TOOL_CALL" || part.type === "TOOL_CALL_REJECTED",
      );
      if (calls.length === 0) continue;
      const callIds = new Set(calls.map((part) => part.toolCallId));
      const unitIds = new Set([String(assistant.id)]);
      const answered = new Set<string>();
      for (let cursor = index + 1; cursor < visibleMessages.length; cursor += 1) {
        const candidate = visibleMessages[cursor]?.message;
        if (candidate === undefined || candidate.type === "ASSISTANT") break;
        if (candidate.type !== "TOOL_RESULT" || !callIds.has(candidate.toolCallId)) continue;
        if (answered.has(candidate.toolCallId)) continue;
        answered.add(candidate.toolCallId);
        unitIds.add(String(candidate.id));
        if (answered.size === callIds.size) break;
      }
      const intersects = [...unitIds].some((id) => coveredIds.has(id));
      if (!intersects) continue;
      if (answered.size !== callIds.size || [...unitIds].some((id) => !coveredIds.has(id))) {
        throw new ContextPlanningError("INCONSISTENT_PLAN");
      }
    }
  }
}

function digestCoverage(input: {
  readonly version: 1;
  readonly sessionId: string;
  readonly segments: readonly ContextMessageRange[];
  readonly messageCount: number;
}): string {
  return digestJsonValue(input as never);
}
