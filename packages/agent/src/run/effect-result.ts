import type { AgentLoopAdvanceResult } from "../loop/types.js";
import type { CompletionGateDecision } from "./ports/completion-gate.js";
import type { ToolTurnResult } from "./ports/tool-turn.js";

/**
 * What one executed effect produced.
 *
 * ```text
 * AGENT       the frozen AgentLoop's own result, unchanged
 * TOOLS       one Tool batch turn
 * COMPLETION  one completion gate decision
 * NONE        the effect produced no state change
 * ```
 *
 * Each variant wraps the canonical type of the subsystem that produced it. There is deliberately
 * no second vocabulary here: an `AGENT` effect *is* an `AgentLoopAdvanceResult`, so a Run Layer
 * that wanted to re-describe a decision would have to do it explicitly rather than having a
 * parallel type to drift into.
 *
 * A driver may not report a Run status, a Step settlement or a durable commit. Those belong to
 * the RunController, and a driver that could report them would be a second lifecycle authority.
 */
export type RunExecutionEffectResult =
  | {
      readonly kind: "AGENT";
      readonly result: AgentLoopAdvanceResult;
    }
  | {
      readonly kind: "TOOLS";
      readonly result: ToolTurnResult;
    }
  | {
      readonly kind: "COMPLETION";
      readonly result: CompletionGateDecision;
    }
  | {
      readonly kind: "NONE";
    };

/** Every effect discriminant, in canonical order. */
export const RUN_EXECUTION_EFFECT_KINDS = [
  "AGENT",
  "TOOLS",
  "COMPLETION",
  "NONE",
] as const satisfies readonly RunExecutionEffectResult["kind"][];

export type { AgentLoopAdvanceResult, CompletionGateDecision, ToolTurnResult };
