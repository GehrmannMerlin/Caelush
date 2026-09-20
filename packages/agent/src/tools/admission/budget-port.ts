import type {
  RunId,
  TimestampMs,
  ToolInvocationId,
  ToolInvocationStatus,
  ToolName,
} from "@caelush/protocol";

import type { ToolCallRequest } from "../call/tool-call-preparer.js";
import type { AgentBudgetBlock } from "../../loop/ports/model-request-admission.js";

/**
 * The Tool budget admission boundary.
 *
 * ```ts
 * export interface ToolBudgetAdmissionPort {
 *   preflight(runId, requests): Promise<AgentBudgetBlock | null>;
 *   admit(input: { runId, invocationId, toolName }): Promise<AgentBudgetBlock | null>;
 *   start(input: { runId, invocationId, startedAt }): Promise<void>;
 *   settle(input: { runId, invocationId, status, finishedAt }): Promise<void>;
 * }
 * ```
 *
 * ## Why the Agent Tool Layer can state this port
 *
 * `AgentBudgetBlock` is the Agent layer's own frozen budget vocabulary, so an admission boundary that
 * answers with it needs no Core type, no `Run` object, no `BudgetManager`, no SQLite ledger and no
 * `RunLimits`. The implementation reaches all of those; the contract names none of them.
 *
 * ## `null` versus `UNAVAILABLE`
 *
 * ```text
 * null            admitted; there is room for this work
 * EXCEEDED        a budget ran out, with the accounting that says so
 * UNAVAILABLE     enforcement could not be established at all
 * ```
 *
 * The third case is deliberately not the second: a host that cannot price a model or estimate tokens
 * has not spent anything, and reporting it as exhaustion would be a false accounting statement. Both
 * are blocks as far as the Tool Layer is concerned — neither may execute a Tool.
 *
 * ## The four phases
 *
 * ```text
 * preflight   may this whole segment fit? Asked before the first handler of a batch runs.
 * admit       may this one invocation run? Called after the invocation exists durably, so the
 *             reservation can be owned by the invocation's identity.
 * start       the handler is about to run. Moves the matching reservation to IN_FLIGHT.
 * settle      the invocation reached a terminal state. Finishes the matching entry.
 * ```
 *
 * `start` and `settle` carry the **caller's** durable lifecycle timestamps rather than reading a clock
 * of their own. The invocation's `startedAt` and `finishedAt` are the durable facts; a second
 * `Date.now()` inside the ledger would invent a second, disagreeing answer to "when did this happen".
 *
 * ## `start` after an atomic start
 *
 * Production moves the reservation to `IN_FLIGHT` *inside* the same SQLite transaction that commits
 * the `RUNNING` invocation, so a crash can never leave a `RUNNING` invocation with an un-started
 * reservation. `start` therefore remains callable afterwards and must be **idempotent**: an entry that
 * is already `IN_FLIGHT`, `SETTLED` or `CONSERVATIVE` is left exactly as it is.
 */
export interface ToolBudgetAdmissionPort {
  preflight(runId: RunId, requests: readonly ToolCallRequest[]): Promise<AgentBudgetBlock | null>;

  admit(input: {
    readonly runId: RunId;
    readonly invocationId: ToolInvocationId;
    readonly toolName: ToolName;
  }): Promise<AgentBudgetBlock | null>;

  start(input: {
    readonly runId: RunId;
    readonly invocationId: ToolInvocationId;
    readonly startedAt: TimestampMs;
  }): Promise<void>;

  settle(input: {
    readonly runId: RunId;
    readonly invocationId: ToolInvocationId;
    readonly status: ToolInvocationStatus;
    readonly finishedAt: TimestampMs;
  }): Promise<void>;
}

/** A budget port that admits everything, for a host that enforces no Tool budget at all. */
export const UNBOUNDED_TOOL_BUDGET_ADMISSION: ToolBudgetAdmissionPort = Object.freeze({
  async preflight(): Promise<AgentBudgetBlock | null> {
    return null;
  },
  async admit(): Promise<AgentBudgetBlock | null> {
    return null;
  },
  async start(): Promise<void> {},
  async settle(): Promise<void> {},
});
