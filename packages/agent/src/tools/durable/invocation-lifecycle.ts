import {
  ToolInvocationSchema,
  type JsonObject,
  type RiskLevel,
  type RunId,
  type StepId,
  type TimestampMs,
  type ToolInvocation,
  type ToolInvocationId,
  type ToolInvocationStatus,
  type ToolName,
} from "@caelush/protocol";

import { cloneJsonValue, deepFreezeJson } from "../schema/json-canonical.js";
import { ToolExecutionInvariantError } from "./durable-errors.js";

/**
 * The Tool Invocation lifecycle.
 *
 * ```text
 * REQUESTED ──▶ WAITING_APPROVAL ──▶ RUNNING ──▶ COMPLETED
 *     │                │                 │
 *     └────────────────┴─────────────────┴──────▶ FAILED
 *
 * CANCELLED    terminal; reachable only from durable state a host already wrote
 * ```
 *
 * Phase 4C moved this table here, into the general Agent Tool Layer, because the *decision* to move an
 * invocation belongs to the same coordinator that owns its durable commit. Phase 4F then removed the
 * legacy package that used to re-export it: there is exactly one transition table in the repository,
 * and it is this one.
 *
 * ## The transition table is not a convenience
 *
 * Every transition is validated against the *current* status before the candidate invocation is built,
 * and the candidate is then validated against the full lifecycle invariant. A caller that tries
 * `COMPLETED → RUNNING` gets an error rather than a rewritten row, because the durable history of a
 * Tool call is evidence, not a mutable field.
 *
 * ## `CANCELLED` is deliberately unreachable from here
 *
 * There is no `cancelToolInvocation`. Protocol v1 declares `CANCELLED` and the durable invariant
 * admits it, but **no production transition in this phase enters it**: Run cancellation settles a Run,
 * and a Tool invocation that was already terminal keeps the terminal state it earned. Recovery
 * therefore *reads* a `CANCELLED` invocation and returns it without executing anything, but nothing in
 * this module invents a new cancellation semantics that the frozen Run cancellation invariants do not
 * authorize.
 */

const ALLOWED_TRANSITIONS: Readonly<Record<ToolInvocationStatus, readonly ToolInvocationStatus[]>> =
  Object.freeze({
    REQUESTED: Object.freeze(["WAITING_APPROVAL", "RUNNING", "FAILED"] as const),
    WAITING_APPROVAL: Object.freeze(["RUNNING", "FAILED"] as const),
    RUNNING: Object.freeze(["COMPLETED", "FAILED"] as const),
    COMPLETED: Object.freeze([] as const),
    FAILED: Object.freeze([] as const),
    CANCELLED: Object.freeze([] as const),
  });

/** Every status a transition may move *to* from `from`, in canonical order. */
export function allowedToolInvocationTransitions(
  from: ToolInvocationStatus,
): readonly ToolInvocationStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

/** Refuse a lifecycle transition the table does not contain. */
export function assertToolInvocationTransition(
  from: ToolInvocationStatus,
  to: ToolInvocationStatus,
): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new ToolExecutionInvariantError(`Invalid ToolInvocation transition: ${from} -> ${to}`);
  }
}

/** Everything needed to create the first durable state of a Tool call. */
export interface CreateRequestedToolInvocationInput {
  readonly id: ToolInvocationId;
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly toolName: ToolName;
  readonly externalCallId: string;
  readonly args: JsonObject;
  /**
   * The durable risk level.
   *
   * It comes from the host's `ToolDurableMetadataPort`, not from `AgentTool`: Protocol v1 persists this
   * field on the invocation, and the general Tool contract deliberately has no opinion about risk.
   */
  readonly riskLevel: RiskLevel;
  readonly createdAt: TimestampMs;
}

/**
 * Create the `REQUESTED` invocation.
 *
 * The arguments are cloned and deep-frozen, so a caller that keeps a reference cannot mutate the
 * invocation it is about to commit, and a Tool cannot mutate the arguments it was resolved against.
 * The result is parsed by the Protocol schema and then checked against the lifecycle invariant, so an
 * invocation that could never be committed is refused before it reaches storage.
 */
export function createRequestedToolInvocation(
  input: CreateRequestedToolInvocationInput,
): ToolInvocation {
  const invocation: ToolInvocation = {
    id: input.id,
    runId: input.runId,
    stepId: input.stepId,
    toolName: input.toolName,
    externalCallId: input.externalCallId,
    args: deepFreezeJson(cloneJsonValue(input.args)) as JsonObject,
    riskLevel: input.riskLevel,
    status: "REQUESTED",
    createdAt: input.createdAt,
  };
  const parsed = ToolInvocationSchema.parse(invocation);
  assertToolInvocationInvariant(parsed);
  return Object.freeze(parsed);
}

/**
 * Park the invocation on approval.
 *
 * It is terminal-free on purpose: the invocation keeps no `finishedAt` and no `error`, because nothing
 * has finished and nothing has failed. The approval it is waiting for settles into the same commit as
 * this transition.
 */
export function markToolInvocationWaitingApproval(invocation: ToolInvocation): ToolInvocation {
  assertToolInvocationTransition(invocation.status, "WAITING_APPROVAL");
  return replaceInvocation(invocation, { status: "WAITING_APPROVAL" });
}

/**
 * Move the invocation to `RUNNING`.
 *
 * This transition is the durable side-effect boundary: it must be committed **before** the Tool
 * handler runs, so a crash during execution leaves a `RUNNING` row that recovery treats as uncertain
 * rather than a `REQUESTED` row that recovery would happily re-run.
 */
export function startToolInvocation(
  invocation: ToolInvocation,
  startedAt: TimestampMs,
): ToolInvocation {
  assertToolInvocationTransition(invocation.status, "RUNNING");
  return replaceInvocation(invocation, { status: "RUNNING", startedAt });
}

/** Move the invocation to `COMPLETED`. Only a non-error observation may accompany this. */
export function completeToolInvocation(
  invocation: ToolInvocation,
  finishedAt: TimestampMs,
): ToolInvocation {
  assertToolInvocationTransition(invocation.status, "COMPLETED");
  return replaceInvocation(invocation, { status: "COMPLETED", finishedAt });
}

/** Move the invocation to `FAILED`, recording the safe error the observation describes. */
export function failToolInvocation(
  invocation: ToolInvocation,
  error: import("@caelush/protocol").AgentError,
  finishedAt: TimestampMs,
): ToolInvocation {
  assertToolInvocationTransition(invocation.status, "FAILED");
  return replaceInvocation(invocation, { status: "FAILED", error, finishedAt });
}

function replaceInvocation(
  invocation: ToolInvocation,
  changes: Partial<Pick<ToolInvocation, "status" | "startedAt" | "finishedAt" | "error">>,
): ToolInvocation {
  const candidate = ToolInvocationSchema.parse({ ...invocation, ...changes });
  assertToolInvocationInvariant(candidate);
  return Object.freeze({
    ...candidate,
    args: deepFreezeJson(cloneJsonValue(candidate.args)) as JsonObject,
  });
}

/**
 * The lifecycle invariant, applied to one invocation in isolation.
 *
 * ```text
 * REQUESTED, WAITING_APPROVAL   no startedAt, no finishedAt, no error
 * RUNNING                       startedAt >= createdAt; no finishedAt, no error
 * COMPLETED                     startedAt and finishedAt; no error
 * FAILED                        finishedAt; an error; startedAt only if it really started
 * CANCELLED                     finishedAt; startedAt only if it really started; no error
 * ```
 *
 * The `FAILED` rule is the subtle one. A policy denial happens before anything started, so its
 * invocation legitimately has no `startedAt` — but an invocation that *does* carry one must carry a
 * coherent one. Requiring `startedAt` unconditionally would make every pre-execution denial
 * unrepresentable; permitting an incoherent one would let a fabricated start time into durable audit
 * data.
 */
export function assertToolInvocationInvariant(invocation: ToolInvocation): void {
  const parsed = ToolInvocationSchema.parse(invocation);
  if (parsed.externalCallId !== undefined && parsed.externalCallId.trim().length === 0) {
    throw new ToolExecutionInvariantError("Tool invocation externalCallId must be non-empty.");
  }
  switch (parsed.status) {
    case "REQUESTED":
    case "WAITING_APPROVAL":
      requireAbsent(parsed.startedAt, "startedAt", parsed.status);
      requireAbsent(parsed.finishedAt, "finishedAt", parsed.status);
      requireAbsent(parsed.error, "error", parsed.status);
      return;
    case "RUNNING":
      requireStarted(parsed);
      requireAbsent(parsed.finishedAt, "finishedAt", parsed.status);
      requireAbsent(parsed.error, "error", parsed.status);
      return;
    case "COMPLETED":
      requireStarted(parsed);
      requireFinished(parsed);
      requireAbsent(parsed.error, "error", parsed.status);
      return;
    case "FAILED":
      if (parsed.startedAt !== undefined) requireStarted(parsed);
      requireFinished(parsed);
      if (parsed.error === undefined) {
        throw new ToolExecutionInvariantError("Failed tool invocation requires error.");
      }
      return;
    case "CANCELLED":
      if (parsed.startedAt !== undefined) requireStarted(parsed);
      requireFinished(parsed);
      requireAbsent(parsed.error, "error", parsed.status);
      return;
  }
}

/** True when the invocation can no longer change: it has earned its final durable state. */
export function isTerminalToolInvocation(invocation: ToolInvocation): boolean {
  return (
    invocation.status === "COMPLETED" ||
    invocation.status === "FAILED" ||
    invocation.status === "CANCELLED"
  );
}

function requireStarted(invocation: ToolInvocation): void {
  if (invocation.startedAt === undefined || invocation.startedAt < invocation.createdAt) {
    throw new ToolExecutionInvariantError(
      "Tool invocation startedAt must be at or after createdAt.",
    );
  }
}

function requireFinished(invocation: ToolInvocation): void {
  if (invocation.finishedAt === undefined) {
    throw new ToolExecutionInvariantError("Terminal tool invocation requires finishedAt.");
  }
  const lowerBound = invocation.startedAt ?? invocation.createdAt;
  if (invocation.finishedAt < lowerBound) {
    throw new ToolExecutionInvariantError(
      "Tool invocation finishedAt must not precede its lifecycle start.",
    );
  }
}

function requireAbsent(value: unknown, field: string, status: string): void {
  if (value !== undefined) {
    throw new ToolExecutionInvariantError(`${status} tool invocation cannot have ${field}.`);
  }
}
