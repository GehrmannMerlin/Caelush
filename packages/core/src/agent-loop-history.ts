import { assertAIMessage, type AIMessage, type AIToolResultMessage } from "@caelush/ai";
import {
  AgentTurnInputError,
  assertConversationProtocolIntegrity,
  assertPendingAssistantHistory,
} from "@caelush/agent";
import type { AgentToolCallsDecision } from "./agent-decision.js";
import { AgentLoopInputError } from "./agent-errors.js";
import type { AgentLoopCommonInput } from "./agent-loop-input.js";

/**
 * The durable-history compatibility boundary.
 *
 * This file is deliberately thin, and what is left in it is deliberate too. It contains only
 * the parts of history validation that are about *this* host:
 *
 * ```text
 * Run and AgentState agreement        a Core/Run projection invariant
 * historySourceSequences alignment    a durable agent_messages concern
 * splitting the open turn out         how this host phrases a tool continuation
 * ```
 *
 * Everything that is a general statement about `AIMessage`, `AgentTurnInput` and
 * `AgentDecision` delegates to `@caelush/agent`:
 *
 * ```text
 * pending-assistant consistency       assertPendingAssistantHistory
 * tool request/result consistency     the agent turn-input validator
 * duplicate tool result detection     assertPendingAssistantHistory
 * conversation turn protocol          assertConversationProtocolIntegrity
 * ```
 *
 * That delegation is the point. A second comparison algorithm here would be a second authority
 * free to disagree with the kernel about the same batch, and the kernel is the component that
 * refuses an invalid one before it spends a provider call.
 */

export interface ResumeHistoryParts {
  readonly historyBeforeCurrentTurn: readonly AIMessage[];
  readonly historyBeforeCurrentTurnSourceSequences?: readonly number[];
  readonly currentTurnMessages: readonly AIMessage[];
}

/**
 * Assert the Run/Coding projection invariants of one loop input.
 *
 * These are compatibility facts — the two projections must describe the same Run, and an
 * executing Run must not carry an active step into a new Reason. None of them is a general
 * statement about an agent turn, so none of them moves into the kernel.
 */
export function validateAgentLoopInput(input: AgentLoopCommonInput): void {
  if (input.run.status !== "RUNNING" || input.state.status !== "RUNNING") {
    throw new AgentLoopInputError("run and state must both be RUNNING");
  }
  if (input.run.id !== input.state.runId || input.run.sessionId !== input.state.sessionId) {
    throw new AgentLoopInputError("run and state identity does not match");
  }
  if (input.run.goal !== input.state.goal) {
    throw new AgentLoopInputError("run and state goal does not match");
  }
  if (
    input.run.workspace.id !== input.state.workspace.id ||
    input.run.workspace.path !== input.state.workspace.path
  ) {
    throw new AgentLoopInputError("run and state workspace does not match");
  }
  if (
    input.run.runtime.id !== input.state.runtime.id ||
    input.run.runtime.kind !== input.state.runtime.kind
  ) {
    throw new AgentLoopInputError("run and state runtime does not match");
  }
  if (
    input.run.permissionProfile !== input.state.permissionProfile ||
    input.run.approvalPolicy !== input.state.approvalPolicy
  ) {
    throw new AgentLoopInputError("run and state policy does not match");
  }
  if (input.run.currentStepId !== undefined || input.state.currentStepId !== undefined) {
    throw new AgentLoopInputError("run and state cannot contain an active step");
  }
  if (
    input.historySourceSequences !== undefined &&
    input.historySourceSequences.length !== input.history.length
  ) {
    throw new AgentLoopInputError("history source sequences must align with history");
  }
  if (
    input.historySourceSequences?.some(
      (sequence) => !Number.isSafeInteger(sequence) || sequence < 1,
    )
  ) {
    throw new AgentLoopInputError("history source sequences must be positive safe integers");
  }
}

/**
 * Run one general kernel assertion against a durable legacy history.
 *
 * The legacy ledger is projected onto the frozen `AIMessage` view first, so the kernel is asked
 * about the same conversation the model will be shown. Its rejection is translated into this
 * host's own input error, which is what the Run Layer already settles.
 */
function assertGeneral(assertion: () => void, fallback: string): void {
  try {
    assertion();
  } catch (error) {
    if (error instanceof AgentTurnInputError) throw new AgentLoopInputError(error.message);
    throw new AgentLoopInputError(fallback);
  }
}

/** Assert the history up to, but excluding, the pending assistant message. */
function assertCompleteHistory(messages: readonly AIMessage[], reason: string): void {
  assertGeneral(() => assertConversationProtocolIntegrity(messages), reason);
}

export function prepareResumeHistory(
  history: readonly AIMessage[],
  pendingDecision: AgentToolCallsDecision,
  normalizedResults: readonly AIToolResultMessage[],
  historySourceSequences?: readonly number[],
): ResumeHistoryParts {
  // The general kernel owns the pending-assistant and already-consumed-result checks: the same
  // questions are asked of a hand-written turn input in a standalone kernel test, so there is
  // exactly one implementation of them.
  assertGeneral(
    () =>
      assertPendingAssistantHistory(
        history,
        pendingDecision,
        normalizedResults,
      ),
    "resume history does not match the pending decision",
  );
  try {
    assertAIMessage(history.at(-1));
  } catch {
    throw new AgentLoopInputError("resume history has an invalid pending assistant");
  }

  const pendingIndex = history.length - 1;
  let currentStart = -1;
  for (let index = pendingIndex - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "user") {
      currentStart = index;
      break;
    }
  }
  const historyBeforeCurrentTurn =
    currentStart < 0
      ? history.slice(0, pendingIndex)
      : [...history.slice(0, currentStart), ...history.slice(currentStart + 1, pendingIndex)];
  const historyBeforeCurrentTurnSourceSequences =
    historySourceSequences === undefined
      ? undefined
      : currentStart < 0
        ? historySourceSequences.slice(0, pendingIndex)
        : [
            ...historySourceSequences.slice(0, currentStart),
            ...historySourceSequences.slice(currentStart + 1, pendingIndex),
          ];
  const currentTurnMessages = [
    ...(currentStart < 0 ? [] : [history[currentStart]!]),
    history[pendingIndex]!,
    ...normalizedResults,
  ];
  if (currentTurnMessages.at(-1)?.role !== "tool") {
    throw new AgentLoopInputError("resume continuation must end with a tool result");
  }
  if (currentTurnMessages.at(-1) !== normalizedResults.at(-1)) {
    throw new AgentLoopInputError("resume continuation lost normalized tool results");
  }
  assertCompleteHistory(historyBeforeCurrentTurn, "previous history is incomplete");
  assertCompleteHistory(currentTurnMessages, "current open turn is invalid");
  return {
    historyBeforeCurrentTurn,
    ...(historyBeforeCurrentTurnSourceSequences === undefined
      ? {}
      : { historyBeforeCurrentTurnSourceSequences }),
    currentTurnMessages,
  };
}
