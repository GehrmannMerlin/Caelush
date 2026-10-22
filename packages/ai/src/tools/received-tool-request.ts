import { assertNonEmptyString } from "../internal/assertions.js";
import { assertAIToolCall } from "./tool-call.js";
import type { AIToolCall } from "./tool-call.js";

/**
 * What the model asked for, one entry per request it actually sent.
 *
 * ```text
 * EXECUTABLE          the arguments are a JSON object and every Tool can receive them
 * INVALID_ARGUMENTS   the request is identifiable, but its arguments cannot be executed
 * ```
 *
 * ## Why this is not a tag on `AIToolCall`
 *
 * `AIToolCall.input` is a `JsonObject`, and that is the whole point: a value that reaches the Tool
 * layer as a `JsonObject` has already been proven structured. A malformed argument string cannot be
 * squeezed into that contract, and it must not be squeezed in as `{}` either — an empty object is a
 * *claim* that the model asked for no arguments, and a handler that accepted it would be applying a
 * request nobody made.
 *
 * So a request that could not be parsed is a first-class value beside the executable ones, carrying
 * only what is actually known: the provider's call identity, the Tool name, the source order, and a
 * typed reason. It deliberately carries **no** parsed input, no raw argument text and no error
 * message from a provider body or JSON parser.
 *
 * ## Order is part of the contract
 *
 * `sourceOrdinal` is the request's position in the model turn, counted over every request the turn
 * produced. It is what lets a caller prove that the one result it is about to send answers the one
 * request it is about to describe — including when text, valid calls and rejected calls interleave.
 */
export type AIReceivedToolRequest =
  | {
      readonly kind: "EXECUTABLE";
      readonly sourceOrdinal: number;
      readonly call: AIToolCall;
    }
  | {
      readonly kind: "INVALID_ARGUMENTS";
      readonly sourceOrdinal: number;
      readonly id: string;
      readonly name: string;
      readonly issue: AIRejectedToolArgumentsIssue;
    };

/**
 * Why a received request could not be executed.
 *
 * ```text
 * MALFORMED_JSON        the argument text is not a JSON document
 * EXPECTED_OBJECT       it is a JSON document, but not an object
 * INCOMPLETE_ARGUMENTS  it is reliably truncated rather than written that way
 * ```
 *
 * `INCOMPLETE_ARGUMENTS` is reserved for a turn whose provider reported that it stopped because of
 * a length limit. A plain parse failure is never reported as truncation: the two are different
 * facts, and only one of them is evidence that the rest of the arguments existed.
 *
 * There is deliberately no field for the raw argument text. The bytes belong to the provider replay
 * artifact, not to a public contract, an event or a diagnostic.
 */
export interface AIRejectedToolArgumentsIssue {
  readonly code: AIRejectedToolArgumentsIssueCode;
  /** UTF-8 byte length of the argument text the provider sent. Never the text itself. */
  readonly argumentBytes: number;
}

/** Every rejection reason, in canonical order. */
export const AI_REJECTED_TOOL_ARGUMENT_ISSUE_CODES = [
  "MALFORMED_JSON",
  "EXPECTED_OBJECT",
  "INCOMPLETE_ARGUMENTS",
] as const;

/** A rejection reason code. */
export type AIRejectedToolArgumentsIssueCode =
  (typeof AI_REJECTED_TOOL_ARGUMENT_ISSUE_CODES)[number];

/** Every received-request discriminant, in canonical order. */
export const AI_RECEIVED_TOOL_REQUEST_KINDS = ["EXECUTABLE", "INVALID_ARGUMENTS"] as const;

/** True when the value is one of the frozen rejection reasons. */
export function isAIRejectedToolArgumentsIssueCode(
  value: unknown,
): value is AIRejectedToolArgumentsIssueCode {
  return (
    typeof value === "string" &&
    (AI_REJECTED_TOOL_ARGUMENT_ISSUE_CODES as readonly string[]).includes(value)
  );
}

/** True when the request can be handed to the Tool layer unchanged. */
export function isExecutableToolRequest(
  request: AIReceivedToolRequest,
): request is Extract<AIReceivedToolRequest, { kind: "EXECUTABLE" }> {
  return request.kind === "EXECUTABLE";
}

/** The executable projection of an ordered request list, in source order. */
export function executableToolCalls(
  requests: readonly AIReceivedToolRequest[],
): readonly AIToolCall[] {
  return requests.flatMap((request) => (request.kind === "EXECUTABLE" ? [request.call] : []));
}

/** The rejected projection of an ordered request list, in source order. */
export function rejectedToolRequests(
  requests: readonly AIReceivedToolRequest[],
): readonly Extract<AIReceivedToolRequest, { kind: "INVALID_ARGUMENTS" }>[] {
  return requests.flatMap((request) => (request.kind === "INVALID_ARGUMENTS" ? [request] : []));
}

/**
 * How many Tool requests a settled turn actually produced, executable or not.
 *
 * This is the one helper every "a turn that must not use Tools" check calls. Reading
 * `toolCalls.length` instead is the mistake it exists to prevent: `toolCalls` is the *executable
 * projection*, so a turn whose only request had unparseable arguments reports zero executable calls
 * while still having asked for a Tool.
 *
 * It tolerates a turn value produced before `toolRequests` existed — a host-supplied or historical
 * result may carry only the executable projection — by falling back to that projection, which is the
 * most that turn can prove. A value that carries `toolRequests` is answered from it exclusively, so
 * a rejected request can never be hidden behind an empty `toolCalls`.
 */
export function countReceivedToolRequests(turn: {
  readonly toolRequests?: readonly AIReceivedToolRequest[] | undefined;
  readonly toolCalls: readonly AIToolCall[];
}): number {
  const requests = turn.toolRequests;
  return Array.isArray(requests) ? requests.length : turn.toolCalls.length;
}

/**
 * Assert one received request.
 *
 * The executable arm reuses the frozen `AIToolCall` assertion rather than restating it, so a
 * request cannot be executable-by-declaration while its call is malformed. The rejected arm checks
 * only identity and a typed reason, because that is all it claims to know.
 */
export function assertAIReceivedToolRequest(value: unknown): asserts value is AIReceivedToolRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("AI received tool request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const ordinal = candidate["sourceOrdinal"];
  if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 0) {
    throw new TypeError("AI received tool request sourceOrdinal must be a non-negative integer.");
  }
  if (candidate["kind"] === "EXECUTABLE") {
    assertExactKeys(candidate, ["kind", "sourceOrdinal", "call"], "AI executable tool request");
    assertAIToolCall(candidate["call"]);
    return;
  }
  if (candidate["kind"] === "INVALID_ARGUMENTS") {
    assertExactKeys(
      candidate,
      ["kind", "sourceOrdinal", "id", "name", "issue"],
      "AI rejected tool request",
    );
    assertNonEmptyString(candidate["id"], "AI rejected tool request id");
    assertNonEmptyString(candidate["name"], "AI rejected tool request name");
    assertAIRejectedToolArgumentsIssue(candidate["issue"]);
    return;
  }
  throw new TypeError("AI received tool request kind is unknown.");
}

/** Assert one rejection issue. */
export function assertAIRejectedToolArgumentsIssue(
  value: unknown,
): asserts value is AIRejectedToolArgumentsIssue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("AI rejected tool arguments issue must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, ["code", "argumentBytes"], "AI rejected tool arguments issue");
  if (!isAIRejectedToolArgumentsIssueCode(candidate["code"])) {
    throw new TypeError("AI rejected tool arguments issue code is unknown.");
  }
  const bytes = candidate["argumentBytes"];
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) {
    throw new TypeError(
      "AI rejected tool arguments issue argumentBytes must be a non-negative integer.",
    );
  }
}

function assertExactKeys(
  candidate: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(candidate);
  if (keys.length !== expected.length || !expected.every((key) => Object.hasOwn(candidate, key))) {
    throw new TypeError(`${label} has an unexpected field set.`);
  }
}
