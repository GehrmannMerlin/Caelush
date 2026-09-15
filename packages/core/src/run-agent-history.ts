import {
  AgentTurnInputError,
  assertConversationProtocolIntegrity,
  assertPendingAssistantHistory,
  type AgentTurnInput,
  type AgentToolCallsDecision,
} from "@caelush/agent";
import type { AIMessage, AIToolResultMessage } from "@caelush/ai";

import type { RunConversationEntry } from "./run-execution-store.js";

/**
 * The canonical production history projection.
 *
 * ```text
 * durable Run conversation + directive -> the exact AIMessage[] the AgentLoop reasons from
 * ```
 *
 * Phase 3C checkpoint 6 removed the legacy `LLMMessage` history path from the production Agent
 * turn. The frozen `AgentLoop.advance()` takes `readonly AIMessage[]`, and this is where that list
 * is projected from the durable conversation — in one place, with the frozen validators asked the
 * questions they already answer.
 *
 * The four cases, and what the model sees in each:
 *
 * ```text
 * INITIAL / RETRY        prefix + durable conversation before the current user turn
 *                        the directive's own USER_INPUT supplies the current user message
 * TOOL_RESULTS           prefix + previous complete history + current open user message
 *                        the directive's own TOOL_RESULTS supplies the pending assistant tool call
 *                        and the results, so neither is duplicated into `history`
 * COMPLETION_REPAIR      prefix + the whole durable conversation: a repair is a continuation of
 *                        the same Run, never a fabricated new user follow-up
 * STEERING               prefix + the whole durable conversation before the trailing user turn
 * ```
 *
 * **Nothing here re-implements a kernel check.** Tool-call identity comparison, tool-name
 * comparison, duplicate-result detection and pending-assistant consistency are all asked of
 * `assertPendingAssistantHistory` and `assertConversationProtocolIntegrity`, which are the frozen
 * implementations the standalone kernel is conformance-tested against.
 */

/** What one turn's history is, once projected. */
export type RunAgentHistoryProjection =
  | {
      readonly kind: "COMPLETE_TURN";
      readonly history: readonly AIMessage[];
    }
  | {
      readonly kind: "TOOL_RESULTS";
      /** Previous complete history plus the current open user message. */
      readonly history: readonly AIMessage[];
      readonly pendingDecision: AgentToolCallsDecision;
      readonly results: readonly AIToolResultMessage[];
    };

export interface RunAgentHistoryInput {
  /** The frozen turn input the coordinator's directive carries. */
  readonly input: AgentTurnInput;
  readonly conversation: readonly RunConversationEntry[];
  readonly historyPrefix?: readonly AIMessage[] | undefined;
}

/**
 * Project one turn's history from the durable Run conversation.
 *
 * A rejection is an `AgentTurnInputError`: the durable ledger and the turn input disagree about what
 * this turn is, and continuing would send the provider a request whose tool protocol is invalid.
 */
export function projectRunAgentHistory(input: RunAgentHistoryInput): RunAgentHistoryProjection {
  const prefix = input.historyPrefix ?? [];
  const durable = input.conversation.map((entry) => entry.message);

  if (input.input.kind === "TOOL_RESULTS") {
    return projectToolResults(prefix, durable, input.input);
  }

  // Every other turn kind is a complete turn as far as `history` is concerned: the current user
  // message travels in the turn input itself, so the trailing user turn is dropped rather than
  // duplicated.
  const history = [...prefix, ...dropTrailingUserTurn(durable)];
  assertConversationProtocolIntegrity(history);
  return { kind: "COMPLETE_TURN", history };
}

function projectToolResults(
  prefix: readonly AIMessage[],
  durable: readonly AIMessage[],
  turn: Extract<AgentTurnInput, { kind: "TOOL_RESULTS" }>,
): RunAgentHistoryProjection {
  assertKnownResults(turn);
  assertDurablePendingAssistant(durable, turn.pendingDecision, turn.results);
  // The whole durable ledger is the authority on what the pending turn looked like: the assertion
  // above already proved its tail is the assistant message the decision describes, and the model
  // is shown that record rather than a reconstructed copy of it.
  const openTurn = durable.slice(-1);
  const previous = durable.slice(0, -1);

  // A previous turn that ends on an unanswered tool call would orphan a call from its result, so
  // the durable prefix is validated as complete history before anything is assembled onto it.
  assertConversationProtocolIntegrity([...prefix, ...previous]);

  // The current open turn, however, *is* the pending assistant plus its results, and the results
  // have not been appended to the durable ledger yet — so the assembled turn is what proves the
  // batch answers exactly what was announced.
  assertConversationProtocolIntegrity([...prefix, ...openTurn, ...turn.results]);

  return {
    kind: "TOOL_RESULTS",
    // The complete history a Tool resume reasons from is everything that precedes the pending
    // assistant message. The current open user turn stays in `history`: the frozen turn input
    // re-supplies the pending assistant and the results, so dropping the user here would send the
    // provider a tool result whose user message is missing — the orphaned protocol the kernel
    // refuses.
    history: [...prefix, ...previous],
    pendingDecision: turn.pendingDecision,
    results: turn.results,
  };
}

/**
 * Assert one tool-result turn's own shape before any history is assembled.
 *
 * The frozen turn-input vocabulary owns these checks, so this only delegates: asking
 * `assertPendingAssistantHistory` about an empty result batch would report a provenance problem
 * instead of the real one.
 */
function assertKnownResults(turn: Extract<AgentTurnInput, { kind: "TOOL_RESULTS" }>): void {
  if (typeof turn.sourceStepId !== "string" || turn.sourceStepId.length === 0) {
    throw new AgentTurnInputError("MISSING_SOURCE_STEP_ID");
  }
  if (!Array.isArray(turn.results) || turn.results.length === 0) {
    throw new AgentTurnInputError("EMPTY_TOOL_RESULTS");
  }
}

/**
 * Ask the frozen kernel whether the durable ledger agrees with the decision being resumed.
 *
 * The history the kernel is asked about is the complete durable projection, which is what makes the
 * three answers exact:
 *
 * ```text
 * the tail really is the assistant message that requested these Tools
 * it really announces exactly the requested calls, in order
 * none of these results has already been recorded
 * ```
 */
function assertDurablePendingAssistant(
  durable: readonly AIMessage[],
  pendingDecision: AgentToolCallsDecision,
  results: readonly AIToolResultMessage[],
): void {
  assertPendingAssistantHistory(durable, pendingDecision, results);
}

/**
 * Drop the trailing user turn, when there is one.
 *
 * `INITIAL` and `RETRY` are entered from a durable state whose current user message is *not* in the
 * ledger yet — the directive supplies it. A ledger that already carries one would mean the turn was
 * half-persisted, and re-appending it would show the model the user twice.
 */
function dropTrailingUserTurn(messages: readonly AIMessage[]): readonly AIMessage[] {
  return messages.at(-1)?.role === "user" ? messages.slice(0, -1) : messages;
}
