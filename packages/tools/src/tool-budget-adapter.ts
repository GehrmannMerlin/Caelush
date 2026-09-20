import type { RunId, TimestampMs, ToolInvocationId, ToolName } from "@caelush/protocol";
import type { AgentBudgetBlock, ToolBudgetAdmissionPort, ToolCallRequest } from "@caelush/agent";

import type { ToolBudgetAdmission, ToolBudgetPorts } from "./dispatcher-ports.js";

/**
 * Adapt the legacy Tool budget boundary onto the canonical admission port.
 *
 * ```text
 * canonical  admit({ runId, invocationId, toolName })  → AgentBudgetBlock | null
 * legacy     admit({ runId, requested, invocationId }) → ALLOWED | EXCEEDED
 * ```
 *
 * The production ledger adapter is `SqliteRunBudgetPort`, which is a `RunBudgetPort` for the Run's LLM
 * budget and a Tool budget adapter for Tool calls. Phase 4C does not migrate the Run budget system: it
 * makes that adapter answerable through the canonical Tool port, with the Tool semantics it already
 * has.
 *
 * ## The legacy call keeps its exact shape
 *
 * `requested` is not carried on the canonical port, because a Tool call reserves exactly one Tool call
 * — the number is a constant, not a parameter, and a caller that could ask for ten would be describing
 * a batch admission the canonical gate does not perform. The adapter supplies `1`, which is the value
 * every production caller already passed.
 *
 * ## `preflight` is a real preflight, not a re-ask
 *
 * The canonical `preflight(runId, requests)` asks whether a whole segment fits. The legacy port has
 * `admitBatch` for exactly that question, so the adapter forwards to it and answers the canonical
 * block shape. A host without `admitBatch` answers `null` — "no segment-level objection" — which is the
 * same meaning the legacy `undefined` had.
 *
 * ## Timestamps come from the caller
 *
 * `start` and `settle` carry the durable lifecycle timestamps. The underlying adapter owns its own
 * clock for *reservation* bookkeeping, but the start and settlement of an invocation are facts the
 * invocation already states, and re-reading a clock here would invent a second, disagreeing answer.
 */
export function toCanonicalToolBudgetPort(budget: ToolBudgetPorts): ToolBudgetAdmissionPort {
  return {
    async preflight(
      runId: RunId,
      requests: readonly ToolCallRequest[],
    ): Promise<AgentBudgetBlock | null> {
      if (budget.admitBatch === undefined) return null;
      const admission = await budget.admitBatch({ runId, requested: requests.length });
      return toCanonicalBlock(admission);
    },

    async admit(input: {
      readonly runId: RunId;
      readonly invocationId: ToolInvocationId;
      readonly toolName: ToolName;
    }): Promise<AgentBudgetBlock | null> {
      const admission = await budget.admit({
        runId: input.runId,
        requested: 1,
        invocationId: input.invocationId,
      });
      return toCanonicalBlock(admission);
    },

    async start(input: {
      readonly runId: RunId;
      readonly invocationId: ToolInvocationId;
      readonly startedAt: TimestampMs;
    }): Promise<void> {
      // The atomic start already happened inside the RUNNING commit on the production path, so this is
      // the idempotent second statement the frozen port requires. The `startedAt` the caller supplies is
      // the invocation's durable `startedAt`; the ledger adapter is expected to be a no-op when the
      // entry is already `IN_FLIGHT`.
      void input.startedAt;
      // A declared-but-absent half is a no-op, not an error: the port's phases are independent, and a
      // host that moves the reservation atomically with its own commit has nothing to do here.
      await budget.start?.({ runId: input.runId, invocationId: input.invocationId });
    },

    async settle(input: {
      readonly runId: RunId;
      readonly invocationId: ToolInvocationId;
      readonly status: import("@caelush/protocol").ToolInvocationStatus;
      readonly finishedAt: TimestampMs;
    }): Promise<void> {
      // Same shape: the terminal commit owns the atomic transition, and this is the idempotent second
      // statement. `status` and `finishedAt` are the invocation's durable terminal facts.
      void input.status;
      void input.finishedAt;
      await budget.settle?.({ runId: input.runId, invocationId: input.invocationId });
    },
  };
}

function toCanonicalBlock(admission: ToolBudgetAdmission): AgentBudgetBlock | null {
  if (admission.kind === "ALLOWED") return null;
  return Object.freeze({
    kind: "EXCEEDED",
    dimension: "TOOL_CALLS",
    accounted: admission.accounted,
    limit: admission.limit,
  });
}
