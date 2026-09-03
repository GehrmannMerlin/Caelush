import {
  LLMMessageSchema,
  type LLMAssistantMessage,
  type LLMMessage,
  type LLMToolResultMessage,
} from "@caelush/llm/messages";
import { validateAndGroupConversation, type ContextConversationError } from "@caelush/context";
import type { AgentToolCallsDecision, AgentToolRequest } from "./agent-decision.js";
import { AgentLoopInputError } from "./agent-errors.js";
import type { AgentLoopCommonInput } from "./agent-loop-input.js";

export interface ResumeHistoryParts {
  readonly historyBeforeCurrentTurn: readonly LLMMessage[];
  readonly currentTurnMessages: readonly LLMMessage[];
}

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
}

function assistantToolCalls(message: LLMAssistantMessage): readonly AgentToolRequest[] {
  return message.content.flatMap((part) =>
    part.type === "tool-call"
      ? [{ externalCallId: part.toolCallId, toolName: part.toolName, args: part.input }]
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function semanticEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => semanticEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && semanticEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function assertPendingAssistant(
  history: readonly LLMMessage[],
  pendingDecision: AgentToolCallsDecision,
  results: readonly LLMToolResultMessage[],
): LLMAssistantMessage {
  const tail = history.at(-1);
  if (tail === undefined || tail.role !== "assistant") {
    throw new AgentLoopInputError("resume history must end with the pending assistant");
  }
  const parsedTail = LLMMessageSchema.safeParse(tail);
  if (!parsedTail.success || parsedTail.data.role !== "assistant") {
    throw new AgentLoopInputError("resume history has an invalid pending assistant");
  }
  const actualCalls = assistantToolCalls(parsedTail.data);
  const expectedCalls = pendingDecision.toolRequests;
  if (actualCalls.length !== expectedCalls.length) {
    throw new AgentLoopInputError("pending assistant tool-call count does not match");
  }
  for (const [index, actual] of actualCalls.entries()) {
    const expected = expectedCalls[index];
    if (
      expected === undefined ||
      actual.externalCallId !== expected.externalCallId ||
      actual.toolName !== expected.toolName ||
      !semanticEqual(actual.args, expected.args)
    ) {
      throw new AgentLoopInputError("pending assistant tool-call identity does not match");
    }
  }
  const resultIds = new Set(results.map((result) => result.toolCallId));
  if (history.some((message) => message.role === "tool" && resultIds.has(message.toolCallId))) {
    throw new AgentLoopInputError("resume history already contains a supplied tool result");
  }
  return parsedTail.data;
}

function assertCompleteHistory(messages: readonly LLMMessage[], reason: string): void {
  try {
    validateAndGroupConversation(messages, { estimateText: (text) => text.length });
  } catch (error) {
    const detail = error as ContextConversationError;
    throw new AgentLoopInputError(`${reason}: ${detail.message}`);
  }
}

export function prepareResumeHistory(
  history: readonly LLMMessage[],
  pendingDecision: AgentToolCallsDecision,
  normalizedResults: readonly LLMToolResultMessage[],
): ResumeHistoryParts {
  assertPendingAssistant(history, pendingDecision, normalizedResults);
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
  return { historyBeforeCurrentTurn, currentTurnMessages };
}
