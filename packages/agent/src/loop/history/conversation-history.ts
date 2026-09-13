import { assertAIMessage } from "@caelush/ai";
import type {
  AIAssistantMessage,
  AIMessage,
  AIToolResultMessage,
  AIUserMessage,
} from "@caelush/ai";

import type { AgentToolCallsDecision } from "../decision/decision.js";
import type { AgentTurnInput } from "../types.js";

/**
 * General Agent conversation and turn-input integrity.
 *
 * This is the canonical implementation of the two questions the general kernel must answer
 * before it spends any work on a turn:
 *
 * ```text
 * Layer A   is this AgentTurnInput internally consistent?
 * Layer B   does the caller's history agree with the decision it is resuming from?
 * ```
 *
 * Both are protocol questions about `AIMessage`, `AgentTurnInput` and `AgentDecision`. That is
 * why they live here and not in a host: the same checks must hold for a CLI, a daemon and a
 * test that drives the kernel with hand-written ports, and a host that reimplemented them
 * would be a second authority free to disagree about what a valid Tool result batch is.
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
      assertUserMessages((input as { readonly messages?: unknown }).messages);
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
  readonly results?: unknown;
}

interface ContinuationTurn {
  readonly reason?: unknown;
  readonly messages?: unknown;
}

function assertUserMessages(messages: unknown): asserts messages is readonly AIUserMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AgentTurnInputError("EMPTY_USER_INPUT");
  }
  for (const [index, message] of messages.entries()) {
    if (!isUserMessage(message)) throw new AgentTurnInputError("INVALID_USER_MESSAGE", index);
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
  const results = turn.results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new AgentTurnInputError("EMPTY_TOOL_RESULTS");
  }
  for (const [index, result] of results.entries()) {
    if (!isToolResultMessage(result)) throw new AgentTurnInputError("INVALID_TOOL_RESULT", index);
  }

  const requests = decision.toolRequests;
  assertUniqueRequestIds(requests.map((request) => request.externalCallId));
  assertUniqueResultIds(results.map((result) => result.toolCallId));

  if (requests.length !== results.length) {
    throw new AgentTurnInputError("TOOL_RESULT_COUNT_MISMATCH");
  }
  for (const [index, result] of results.entries()) {
    const request = requests[index];
    if (request === undefined || result.toolCallId !== request.externalCallId) {
      throw new AgentTurnInputError("TOOL_RESULT_ID_MISMATCH", index);
    }
    if (result.toolName !== request.toolName) {
      throw new AgentTurnInputError("TOOL_RESULT_NAME_MISMATCH", index);
    }
  }
}

function assertContinuationTurn(turn: ContinuationTurn): void {
  if (typeof turn.reason !== "string" || !CONTINUATION_REASONS.includes(turn.reason)) {
    throw new AgentTurnInputError("INVALID_CONTINUATION_REASON");
  }
  if (turn.messages === undefined) return;
  if (!Array.isArray(turn.messages)) throw new AgentTurnInputError("INVALID_USER_MESSAGE");
  for (const [index, message] of turn.messages.entries()) {
    if (!isUserMessage(message)) throw new AgentTurnInputError("INVALID_USER_MESSAGE", index);
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

function isUserMessage(value: unknown): value is AIUserMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly role?: unknown; readonly content?: unknown };
  return (
    candidate.role === "user" &&
    typeof candidate.content === "string" &&
    candidate.content.length > 0
  );
}

function isToolResultMessage(value: unknown): value is AIToolResultMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly role?: unknown;
    readonly toolCallId?: unknown;
    readonly toolName?: unknown;
    readonly content?: unknown;
    readonly isError?: unknown;
  };
  return (
    candidate.role === "tool" &&
    typeof candidate.toolCallId === "string" &&
    candidate.toolCallId.length > 0 &&
    typeof candidate.toolName === "string" &&
    candidate.toolName.length > 0 &&
    typeof candidate.content === "string" &&
    typeof candidate.isError === "boolean"
  );
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
