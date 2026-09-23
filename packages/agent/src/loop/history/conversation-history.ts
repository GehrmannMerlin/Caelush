import { assertAIMessage } from "@caelush/ai";
import type { AIAssistantMessage, AIMessage, AIToolResultMessage } from "@caelush/ai";

import type { AgentToolCallsDecision } from "../decision/decision.js";
import type { AgentTurnInput } from "../types.js";

/**
 * General Agent conversation and turn-input integrity.
 *
 * This is the canonical implementation of the two questions the general kernel must answer
 * before it spends any work on a turn:
 *
 * ```text
 * Layer A   is this durable-reference AgentTurnInput internally consistent?
 * Layer B   does a compatibility caller's projected history agree with the decision it is resuming from?
 * ```
 *
 * Layer A is about IDs and decision cardinality only. Message identity, ordering and Tool linkage
 * are the Conversation Validator's question over the durable snapshot. The AI-message helpers below
 * remain a compatibility authority for the legacy Core projector and do not participate in Phase 5D.
 *
 * What is deliberately *not* here:
 *
 * ```text
 * conversation grouping and token budgeting   the Context Engine owns them
 * run status, workspace, runtime, policy      the Run Layer owns them
 * ```
 *
 * Nothing in this module may import a context, tool, runtime, storage or core package.
 */

/** Why a turn input was rejected. Closed on purpose: a caller switches on it. */
export type AgentTurnInputErrorReason =
  | "EMPTY_USER_INPUT"
  | "INVALID_USER_MESSAGE"
  | "EMPTY_TOOL_RESULTS"
  | "INVALID_TOOL_RESULT"
  | "MISSING_SOURCE_STEP_ID"
  | "TOOL_RESULT_COUNT_MISMATCH"
  | "TOOL_RESULT_ID_MISMATCH"
  | "TOOL_RESULT_NAME_MISMATCH"
  | "DUPLICATE_TOOL_REQUEST_ID"
  | "DUPLICATE_TOOL_RESULT_ID"
  | "EMPTY_CONTINUATION_MESSAGE"
  | "INVALID_CONTINUATION_REASON"
  | "INVALID_TURN_INPUT_KIND"
  | "INVALID_HISTORY"
  | "PENDING_ASSISTANT_MISSING"
  | "PENDING_ASSISTANT_MISMATCH"
  | "TOOL_RESULT_ALREADY_PRESENT"
  | "INCOMPLETE_CONVERSATION";

/** Every rejection reason, in canonical order. */
export const AGENT_TURN_INPUT_ERROR_REASONS = [
  "EMPTY_USER_INPUT",
  "INVALID_USER_MESSAGE",
  "EMPTY_TOOL_RESULTS",
  "INVALID_TOOL_RESULT",
  "MISSING_SOURCE_STEP_ID",
  "TOOL_RESULT_COUNT_MISMATCH",
  "TOOL_RESULT_ID_MISMATCH",
  "TOOL_RESULT_NAME_MISMATCH",
  "DUPLICATE_TOOL_REQUEST_ID",
  "DUPLICATE_TOOL_RESULT_ID",
  "EMPTY_CONTINUATION_MESSAGE",
  "INVALID_CONTINUATION_REASON",
  "INVALID_TURN_INPUT_KIND",
  "INVALID_HISTORY",
  "PENDING_ASSISTANT_MISSING",
  "PENDING_ASSISTANT_MISMATCH",
  "TOOL_RESULT_ALREADY_PRESENT",
  "INCOMPLETE_CONVERSATION",
] as const satisfies readonly AgentTurnInputErrorReason[];

/**
 * The general turn-input rejection.
 *
 * It carries a closed reason and a fixed safe summary — never the offending message body, tool
 * argument or Tool result text. A caller that needs to explain the rejection uses the reason.
 */
export class AgentTurnInputError extends Error {
  readonly reason: AgentTurnInputErrorReason;
  /** A bounded index into the offending collection, when the reason names one. */
  readonly index?: number;

  constructor(reason: AgentTurnInputErrorReason, index?: number) {
    super(agentTurnInputErrorMessage(reason));
    this.name = "AgentTurnInputError";
    this.reason = reason;
    if (index !== undefined) this.index = index;
  }
}

/** The fixed, safe summary of one reason. */
export function agentTurnInputErrorMessage(reason: AgentTurnInputErrorReason): string {
  switch (reason) {
    case "EMPTY_USER_INPUT":
      return "An agent user turn must carry at least one user message.";
    case "INVALID_USER_MESSAGE":
      return "An agent user turn carried a message that is not a user message.";
    case "EMPTY_TOOL_RESULTS":
      return "An agent tool result batch must carry at least one result.";
    case "INVALID_TOOL_RESULT":
      return "An agent tool result batch carried a message that is not a tool result.";
    case "MISSING_SOURCE_STEP_ID":
      return "An agent tool result batch must name the step that requested the tools.";
    case "TOOL_RESULT_COUNT_MISMATCH":
      return "The tool result batch does not match the requested tool call count.";
    case "TOOL_RESULT_ID_MISMATCH":
      return "A tool result does not answer the requested tool call at the same position.";
    case "TOOL_RESULT_NAME_MISMATCH":
      return "A tool result names a different tool than the request at the same position.";
    case "DUPLICATE_TOOL_REQUEST_ID":
      return "The pending decision requests the same tool call identity twice.";
    case "DUPLICATE_TOOL_RESULT_ID":
      return "The tool result batch answers the same tool call identity twice.";
    case "EMPTY_CONTINUATION_MESSAGE":
      return "An agent continuation message must be a non-empty user message.";
    case "INVALID_CONTINUATION_REASON":
      return "An agent continuation must name a known reason.";
    case "INVALID_TURN_INPUT_KIND":
      return "The agent turn input is not one of the frozen turn kinds.";
    case "INVALID_HISTORY":
      return "The agent turn history is not a list of well-formed AI messages.";
    case "PENDING_ASSISTANT_MISSING":
      return "A tool result resume must follow the assistant message that requested the tools.";
    case "PENDING_ASSISTANT_MISMATCH":
      return "The pending assistant message does not match the decision it is resuming from.";
    case "TOOL_RESULT_ALREADY_PRESENT":
      return "The history already contains a tool result this batch supplies again.";
    case "INCOMPLETE_CONVERSATION":
      return "The conversation is not a sequence of complete turns.";
  }
}

const CONTINUATION_REASONS: readonly string[] = ["VERIFICATION_REPAIR", "STEERING"];

/* ----------------------------------------------------- Layer A: turn input */

/**
 * Assert one frozen turn input.
 *
 * `AgentLoop.advance()` calls this before it prepares any context, so an invalid turn costs no
 * context build, no admission decision, no durable commit and no provider call.
 */
export function assertAgentTurnInput(value: unknown): asserts value is AgentTurnInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentTurnInputError("INVALID_TURN_INPUT_KIND");
  }
  const input = value as { readonly kind?: unknown };
  switch (input.kind) {
    case "USER_INPUT":
      assertMessageId(
        (input as { readonly userMessageId?: unknown }).userMessageId,
        "EMPTY_USER_INPUT",
      );
      return;
    case "TOOL_RESULTS":
      assertToolResultsTurn(input as ToolResultsTurn);
      return;
    case "CONTINUATION":
      assertContinuationTurn(input as ContinuationTurn);
      return;
    default:
      throw new AgentTurnInputError("INVALID_TURN_INPUT_KIND");
  }
}

interface ToolResultsTurn {
  readonly sourceStepId?: unknown;
  readonly pendingDecision?: unknown;
  readonly toolResultMessageIds?: unknown;
}

interface ContinuationTurn {
  readonly reason?: unknown;
  readonly messageIds?: unknown;
}

function assertMessageId(value: unknown, reason: AgentTurnInputErrorReason): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentTurnInputError(reason);
  }
}

/**
 * Assert one tool result batch against the decision that opened it.
 *
 * The batch is positional: result `i` answers request `i`. That is the only ordering the model
 * can be shown, so an out-of-order batch is rejected here rather than silently normalized —
 * normalizing would let a caller believe it had answered calls it had not.
 */
function assertToolResultsTurn(turn: ToolResultsTurn): void {
  if (typeof turn.sourceStepId !== "string" || turn.sourceStepId.length === 0) {
    throw new AgentTurnInputError("MISSING_SOURCE_STEP_ID");
  }
  const decision = turn.pendingDecision;
  if (!isToolCallsDecision(decision)) {
    throw new AgentTurnInputError("INVALID_TURN_INPUT_KIND");
  }
  const messageIds = turn.toolResultMessageIds;
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new AgentTurnInputError("EMPTY_TOOL_RESULTS");
  }
  for (const [index, messageId] of messageIds.entries()) {
    if (typeof messageId !== "string" || messageId.length === 0) {
      throw new AgentTurnInputError("INVALID_TOOL_RESULT", index);
    }
  }

  const requests = decision.toolRequests;
  assertUniqueRequestIds(requests.map((request) => request.externalCallId));
  assertUniqueResultIds(messageIds);

  if (requests.length !== messageIds.length) {
    throw new AgentTurnInputError("TOOL_RESULT_COUNT_MISMATCH");
  }
}

function assertContinuationTurn(turn: ContinuationTurn): void {
  if (typeof turn.reason !== "string" || !CONTINUATION_REASONS.includes(turn.reason)) {
    throw new AgentTurnInputError("INVALID_CONTINUATION_REASON");
  }
  if (turn.messageIds === undefined) return;
  if (!Array.isArray(turn.messageIds)) throw new AgentTurnInputError("INVALID_USER_MESSAGE");
  const seen = new Set<string>();
  for (const [index, messageId] of turn.messageIds.entries()) {
    if (typeof messageId !== "string" || messageId.length === 0) {
      throw new AgentTurnInputError("INVALID_USER_MESSAGE", index);
    }
    if (seen.has(messageId)) throw new AgentTurnInputError("DUPLICATE_TOOL_RESULT_ID", index);
    seen.add(messageId);
  }
}

function assertUniqueRequestIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new AgentTurnInputError("DUPLICATE_TOOL_REQUEST_ID");
    seen.add(id);
  }
}

function assertUniqueResultIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) throw new AgentTurnInputError("DUPLICATE_TOOL_RESULT_ID", index);
    seen.add(id);
  }
}

/* --------------------------------- Layer B: durable history compatibility */

/**
 * Assert that a caller's history agrees with the decision it is resuming from.
 *
 * Called by a compatibility facade *after* it has projected its own durable history onto
 * `AIMessage` and *before* it trims that history into the frozen `history` shape. It answers
 * three questions:
 *
 * ```text
 * does the last message match the decision's own assistant message?
 * does that assistant message announce exactly the requested tool calls?
 * has one of these results already been recorded?
 * ```
 *
 * The third is what stops a restart from replaying an observation the model already saw.
 */
export function assertPendingAssistantHistory(
  history: readonly AIMessage[],
  pendingDecision: AgentToolCallsDecision,
  results: readonly AIToolResultMessage[],
): void {
  assertHistory(history);
  const tail = history.at(-1);
  if (tail === undefined || tail.role !== "assistant") {
    throw new AgentTurnInputError("PENDING_ASSISTANT_MISSING");
  }
  const expected = pendingDecision.modelTurn.assistantMessage;
  if (!assistantMatches(tail, expected)) {
    throw new AgentTurnInputError("PENDING_ASSISTANT_MISMATCH");
  }
  const announced = assistantToolCalls(tail);
  const requests = pendingDecision.toolRequests;
  if (announced.length !== requests.length) {
    throw new AgentTurnInputError("PENDING_ASSISTANT_MISMATCH");
  }
  for (const [index, call] of announced.entries()) {
    const request = requests[index];
    if (
      request === undefined ||
      call.toolCallId !== request.externalCallId ||
      call.toolName !== request.toolName ||
      !semanticEqual(call.input, request.args)
    ) {
      throw new AgentTurnInputError("PENDING_ASSISTANT_MISMATCH", index);
    }
  }
  const supplied = new Set(results.map((result) => result.toolCallId));
  if (history.some((message) => message.role === "tool" && supplied.has(message.toolCallId))) {
    throw new AgentTurnInputError("TOOL_RESULT_ALREADY_PRESENT");
  }
}

/**
 * Assert that history is a sequence of complete assistant/tool turns.
 *
 * A turn is complete when every tool call it announced is answered, in announcement order,
 * before the conversation moves on. An orphaned call or an unattributed result means the
 * caller's ledger and the model's view have diverged, and continuing would send the provider a
 * request whose tool protocol is invalid.
 *
 * This is protocol integrity only. Conversation grouping, history selection and token
 * budgeting stay with the Context Engine.
 */
export function assertConversationProtocolIntegrity(history: readonly AIMessage[]): void {
  assertHistory(history);
  let open: readonly { readonly toolCallId: string; readonly toolName: string }[] = [];
  let answered = 0;
  for (const message of history) {
    if (message.role === "tool") {
      const expected = open[answered];
      if (expected === undefined || expected.toolCallId !== message.toolCallId) {
        throw new AgentTurnInputError("INCOMPLETE_CONVERSATION");
      }
      answered += 1;
      if (answered === open.length) {
        open = [];
        answered = 0;
      }
      continue;
    }
    if (open.length !== 0) throw new AgentTurnInputError("INCOMPLETE_CONVERSATION");
    if (message.role === "assistant") {
      const calls = assistantToolCalls(message);
      assertUniqueRequestIds(calls.map((call) => call.toolCallId));
      if (calls.length > 0) open = calls;
    }
  }
  if (open.length !== 0) throw new AgentTurnInputError("INCOMPLETE_CONVERSATION");
}

/* ---------------------------------------------------------------- helpers */

/**
 * Assert that a history is a list of well-formed messages.
 *
 * An empty list is valid here — the very first Reason of a Run sees no history at all — so each
 * message is checked individually rather than through the request-boundary helper, which also
 * requires a non-empty list.
 */
function assertHistory(history: readonly AIMessage[]): void {
  if (!Array.isArray(history)) throw new AgentTurnInputError("INVALID_HISTORY");
  for (const [index, message] of history.entries()) {
    try {
      // The AI contract rejects unknown fields and wrong shapes, so a history that passes it is
      // one the model can be shown.
      assertAIMessage(message);
    } catch {
      throw new AgentTurnInputError("INVALID_HISTORY", index);
    }
  }
}

function isToolCallsDecision(value: unknown): value is AgentToolCallsDecision {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly type?: unknown; readonly toolRequests?: unknown };
  return candidate.type === "TOOL_CALLS_REQUESTED" && Array.isArray(candidate.toolRequests);
}

/** The tool calls an assistant message announces, in announcement order. */
function assistantToolCalls(
  message: AIAssistantMessage,
): readonly { readonly toolCallId: string; readonly toolName: string; readonly input: unknown }[] {
  return message.content.flatMap((part) =>
    part.type === "tool-call"
      ? [{ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }]
      : [],
  );
}

/** Compare two assistant messages as durable records. */
function assistantMatches(actual: AIAssistantMessage, expected: AIAssistantMessage): boolean {
  if (actual.content.length !== expected.content.length) return false;
  for (const [index, part] of actual.content.entries()) {
    const other = expected.content[index];
    if (other === undefined || part.type !== other.type) return false;
    if (part.type === "text" && other.type === "text" && part.text !== other.text) return false;
    if (
      part.type === "tool-call" &&
      other.type === "tool-call" &&
      (part.toolCallId !== other.toolCallId ||
        part.toolName !== other.toolName ||
        !semanticEqual(part.input, other.input))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Structural JSON equality.
 *
 * Tool arguments round-trip through durable JSON, so key order is not part of their identity
 * while their values are. A byte comparison would reject a semantically identical batch.
 */
export function semanticEqual(left: unknown, right: unknown): boolean {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
