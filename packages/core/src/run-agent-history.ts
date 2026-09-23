import {
  AgentTurnInputError,
  assertConversationProtocolIntegrity,
  assertPendingAssistantHistory,
  type AgentMessageCodecRegistry,
  type AgentMessageProjectorRegistry,
  type AgentMessageRecord,
  type AgentToolCallsDecision,
} from "@caelush/agent";
import type { AIMessage, AIToolResultMessage } from "@caelush/ai";

import { semanticEqual } from "./semantic-equality.js";
import type { LegacyFacadeTurnInput } from "./legacy-agent-conversation.js";

/** Machine-readable marker retained for architecture guards and migration diagnostics. */
export const RUN_AGENT_HISTORY_MODE = "COMPATIBILITY ONLY" as const;

/** COMPATIBILITY ONLY — Phase 5D production Context and Run execution do not call this projector. */

/** The compatibility projection required while Context/AgentLoop still speak AI messages. */
export interface RunAgentMessageProjection {
  readonly codecs: AgentMessageCodecRegistry;
  readonly projectors: AgentMessageProjectorRegistry;
}

/** What one turn's history is, once projected. */
export type RunAgentHistoryProjection =
  | {
      readonly kind: "COMPLETE_TURN";
      readonly history: readonly AIMessage[];
      /** The current USER_INPUT projected from the durable ledger. */
      readonly input?: Extract<LegacyFacadeTurnInput, { kind: "USER_INPUT" }>;
    }
  | {
      readonly kind: "TOOL_RESULTS";
      readonly history: readonly AIMessage[];
      readonly pendingDecision: AgentToolCallsDecision;
      readonly results: readonly AIToolResultMessage[];
    };

export interface RunAgentHistoryInput {
  /** The frozen turn input the coordinator's directive carries. */
  readonly input: LegacyFacadeTurnInput;
  /** Raw V2 records are the durable authority; AI messages are made only below this seam. */
  readonly conversationRecords: readonly AgentMessageRecord[];
  readonly messageProjection: RunAgentMessageProjection;
  readonly historyPrefix?: readonly AIMessage[] | undefined;
}

/**
 * Project one turn's history from durable V2 records.
 *
 * Codec selection follows the stored schema version and projector selection follows the stored
 * model-projection version. Unknown visible history therefore fails closed instead of silently
 * re-encoding or falling forward to a newer model view.
 */
export function projectRunAgentHistory(input: RunAgentHistoryInput): RunAgentHistoryProjection {
  const prefix = input.historyPrefix ?? [];
  const durable = projectDurableRecords(
    input.conversationRecords,
    input.messageProjection.codecs,
    input.messageProjection.projectors,
  );

  if (input.input.kind === "TOOL_RESULTS") {
    return projectToolResults(prefix, durable, input.input);
  }

  const history = [...prefix, ...dropTrailingUserTurn(flattenProjected(durable))];
  assertConversationProtocolIntegrity(history);
  return {
    kind: "COMPLETE_TURN",
    history,
    ...(input.input.kind === "USER_INPUT" ? { input: durableUserInput(durable, input.input) } : {}),
  };
}

interface ProjectedDurableMessage {
  readonly record: AgentMessageRecord;
  readonly messages: readonly AIMessage[];
}

function projectDurableRecords(
  records: readonly AgentMessageRecord[],
  codecs: AgentMessageCodecRegistry,
  projectors: AgentMessageProjectorRegistry,
): readonly ProjectedDurableMessage[] {
  return records.map((record) => {
    const message = codecs.decode(record);
    const projection = projectors.project({
      sequence: record.sequence,
      schemaVersion: record.schemaVersion,
      ...(record.modelProjectionVersion === undefined
        ? {}
        : { modelProjectionVersion: record.modelProjectionVersion }),
      message,
    });
    return { record, messages: projection.messages };
  });
}

function flattenProjected(entries: readonly ProjectedDurableMessage[]): readonly AIMessage[] {
  return entries.flatMap((entry) => entry.messages);
}

function projectToolResults(
  prefix: readonly AIMessage[],
  durable: readonly ProjectedDurableMessage[],
  turn: Extract<LegacyFacadeTurnInput, { kind: "TOOL_RESULTS" }>,
): RunAgentHistoryProjection {
  assertKnownResults(turn);

  const assistantIndex = durable.findIndex(
    (entry) =>
      entry.record.messageType === "ASSISTANT" && entry.record.sourceStepId === turn.sourceStepId,
  );
  if (assistantIndex < 0) throw new AgentTurnInputError("PENDING_ASSISTANT_MISSING");

  const previous = flattenProjected(durable.slice(0, assistantIndex));
  const openTurn = flattenProjected(durable.slice(assistantIndex, assistantIndex + 1));
  const persistedResults = flattenProjected(durable.slice(assistantIndex + 1));
  const results = persistedResults.length === 0 ? turn.results : asToolResults(persistedResults);
  if (persistedResults.length !== 0 && !sameToolResults(results, turn.results)) {
    throw new AgentTurnInputError("TOOL_RESULT_ALREADY_PRESENT");
  }

  const openHistory = [...prefix, ...previous, ...openTurn];
  assertDurablePendingAssistant(openHistory, turn.pendingDecision, results);
  assertConversationProtocolIntegrity([...prefix, ...previous]);
  assertConversationProtocolIntegrity([...prefix, ...openTurn, ...results]);

  return {
    kind: "TOOL_RESULTS",
    history: [...prefix, ...previous],
    pendingDecision: turn.pendingDecision,
    results,
  };
}

function assertKnownResults(turn: Extract<LegacyFacadeTurnInput, { kind: "TOOL_RESULTS" }>): void {
  if (typeof turn.sourceStepId !== "string" || turn.sourceStepId.length === 0) {
    throw new AgentTurnInputError("MISSING_SOURCE_STEP_ID");
  }
  if (!Array.isArray(turn.results) || turn.results.length === 0) {
    throw new AgentTurnInputError("EMPTY_TOOL_RESULTS");
  }
}

function assertDurablePendingAssistant(
  history: readonly AIMessage[],
  pendingDecision: AgentToolCallsDecision,
  results: readonly AIToolResultMessage[],
): void {
  assertPendingAssistantHistory(history, pendingDecision, results);
}

function asToolResults(messages: readonly AIMessage[]): readonly AIToolResultMessage[] {
  if (messages.some((message) => message.role !== "tool")) {
    throw new AgentTurnInputError("PENDING_ASSISTANT_MISMATCH");
  }
  return messages as readonly AIToolResultMessage[];
}

function sameToolResults(
  left: readonly AIToolResultMessage[],
  right: readonly AIToolResultMessage[],
): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) => {
      const other = right[index];
      return other !== undefined && semanticEqual(message, other);
    })
  );
}

/** Drop the current durable USER message; the frozen turn input supplies it exactly once. */
function dropTrailingUserTurn(messages: readonly AIMessage[]): readonly AIMessage[] {
  return messages.at(-1)?.role === "user" ? messages.slice(0, -1) : messages;
}

function durableUserInput(
  entries: readonly ProjectedDurableMessage[],
  fallback: Extract<LegacyFacadeTurnInput, { kind: "USER_INPUT" }>,
): Extract<LegacyFacadeTurnInput, { kind: "USER_INPUT" }> {
  const entry = [...entries].reverse().find((candidate) => candidate.record.messageType === "USER");
  if (entry === undefined) return fallback;
  const messages = entry.messages.filter(
    (message): message is Extract<AIMessage, { role: "user" }> => message.role === "user",
  );
  return messages.length === 0 ? fallback : { kind: "USER_INPUT", messages };
}
