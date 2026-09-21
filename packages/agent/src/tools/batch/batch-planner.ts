import type { JsonObject } from "@caelush/ai";
import type { ToolName } from "@caelush/protocol";

import type { AgentTool } from "../types/agent-tool.js";
import type { ToolExecutionMode } from "../types/execution-mode.js";

/**
 * The batch planner.
 *
 * ```text
 * a batch's calls  ->  the order they may execute in
 * ```
 *
 * ## Why this exists at all when there is only one plan
 *
 * The plan is the *only* place that decides whether a batch may run concurrently. Isolating that
 * decision here means the frozen first implementation — "always sequential, whatever a Tool declares"
 * — is a property of a planner rather than an implicit property of the execution loop, so a later
 * round can add a parallel plan without rewriting the coordinator's control flow.
 *
 * It is deliberately **private**: no root export, no public contract, no configuration surface. A
 * public planner port would invite hosts to supply their own scheduling, which is exactly the
 * authority this round is consolidating into `@caelush/agent`.
 */

/**
 * What one batch's scheduling decision is.
 *
 * `executionMode` is recorded rather than acted on, and that is the frozen behaviour: a Tool may
 * declare `PARALLEL_SAFE`, and the first implementation still runs it in order. The field exists so a
 * host can observe *why* a batch could not have run concurrently, and so the invariant test can prove
 * that no call site branches on it to enable `Promise.all`.
 */
export interface ToolBatchExecutionPlan {
  readonly kind: "SEQUENTIAL";
  /**
   * The declared execution modes of the calls in plan order.
   *
   * Purely diagnostic. It is never read to decide whether to run anything concurrently.
   */
  readonly declaredModes: readonly ToolExecutionMode[];
}

/** The minimal Tool facts a plan is made from. */
export interface PlannableToolCall {
  readonly toolName: ToolName;
  readonly args: JsonObject;
  readonly resolved: { readonly tool: AgentTool };
}

/**
 * Plan a batch for execution.
 *
 * ```text
 * V2 first implementation = sequential scheduler
 * ```
 *
 * Every call is planned in its original order, and there is no branch that could produce any other
 * plan. A Tool's declared `executionMode` is read only to report it.
 */
export function planSequentialToolBatch(
  calls: readonly PlannableToolCall[],
): ToolBatchExecutionPlan {
  return Object.freeze({
    kind: "SEQUENTIAL",
    declaredModes: Object.freeze(calls.map((call) => call.resolved.tool.executionMode)),
  });
}
