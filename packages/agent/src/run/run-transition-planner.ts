import type {
  RunExecutionContinuationKind,
  RunExecutionFinalization,
  RunExecutionStatus,
} from "./directive.js";
import type { RunExecutionEffectResult } from "./effect-result.js";
import type { RunExecutionFacts } from "./snapshot.js";

/**
 * The Run transition planner.
 *
 * ```text
 * RunTransitionPlanner = effect -> commit draft
 * ```
 *
 * It is **pure**: it derives what the durable state *should become* from the effect that was just
 * executed, and it writes nothing. The RunController takes the plan and commits it, which is what
 * keeps "who decides the transition" and "who makes it durable" as two different questions.
 *
 * The draft is deliberately declarative. It names the next status, the Step settlement, the
 * continuation change, the events and the state patch — and it carries no storage row, no SQL, no
 * repository and no `AgentRun` object. A planner that could write would be a second lifecycle
 * authority next to the RunController.
 */
export interface RunTransitionPlanner {
  plan(input: RunTransitionPlanInput): RunTransitionDraft;
}

/** What a transition is planned from. */
export interface RunTransitionPlanInput {
  readonly facts: RunExecutionFacts;
  readonly effect: RunExecutionEffectResult;
  /** The caller's `now`, passed in rather than read, so a plan is reproducible. */
  readonly now: number;
}

/**
 * The declarative description of one durable transition.
 *
 * Every field is optional because a transition changes only what it changes. An empty draft is a
 * legitimate answer: executing an effect that changed nothing must not invent a write.
 */
export interface RunTransitionDraft {
  /** The Run status this transition settles into, when it changes one. */
  readonly status?: RunExecutionStatus;
  /** The continuation the Run holds after this transition. `null` clears it. */
  readonly continuation?: RunExecutionContinuationKind | null;
  /** How the active Step settles, when this transition settles one. */
  readonly stepSettlement?: RunStepSettlement;
  /** The messages this transition appends to durable conversation. */
  readonly messageAppend?: "EFFECT_MESSAGES" | "NONE" | "CLEAR_TOOL_RESULTS";
  /** Whether the Run owns no remaining active Step after this transition. */
  readonly clearActiveStep?: boolean;
  /** A terminal finalization, when this transition ends the Run. */
  readonly finalization?: RunExecutionFinalization;
  /** Durable event kinds this transition emits, in order. */
  readonly events: readonly string[];
  /** A safe, bounded summary for the durable event payload. */
  readonly summary?: string;
}

/** How a durable Step settles. */
export type RunStepSettlement = "COMPLETED" | "FAILED" | "CANCELLED";

/**
 * The frozen transition rule table.
 *
 * It is a pure function of the effect, so every rule is testable without a database:
 *
 * ```text
 * AGENT DECIDED final candidate   → VERIFYING boundary, Step completed
 * AGENT DECIDED tool requests     → WAITING_TOOL_RESULTS, Step completed
 * AGENT FAILED before the boundary→ stay in the current status, no Step settlement
 * AGENT FAILED at the model       → Step failed, RUNNING, retry metadata reported
 * AGENT CANCELLED                 → CANCELLED finalization, Step cancelled
 * TOOLS COMPLETED                 → WAITING_TOOL_RESULTS with accepted results
 * TOOLS WAITING_APPROVAL          → WAITING_APPROVAL suspension
 * TOOLS BUDGET_EXCEEDED           → BUDGET_EXCEEDED finalization
 * TOOLS RESOURCE_WAIT             → WAITING_RESOURCE suspension
 * TOOLS REPLAN                    → WAITING_TOOL_RESULTS with synthetic results
 * COMPLETION ACCEPT               → COMPLETED finalization
 * COMPLETION REPAIR               → WAITING_VERIFICATION_REPAIR on the same Run
 * COMPLETION REJECT               → FAILED finalization
 * COMPLETION ERROR                → stay recoverable, report the error
 * NONE                            → no write at all
 * ```
 */
export function createRunTransitionPlanner(): RunTransitionPlanner {
  return {
    plan(input: RunTransitionPlanInput): RunTransitionDraft {
      return planRunTransition(input);
    },
  };
}

/** The transition rule table, as a pure function. */
export function planRunTransition(input: RunTransitionPlanInput): RunTransitionDraft {
  const { effect } = input;
  switch (effect.kind) {
    case "NONE":
      // An effect that changed nothing must not invent a durable write.
      return { events: [] };
    case "AGENT":
      return planAgentTransition(effect);
    case "TOOLS":
      return planToolsTransition(effect);
    case "COMPLETION":
      return planCompletionTransition(effect);
  }
}

/* ------------------------------------------------------------------ rules */

function planAgentTransition(
  effect: Extract<RunExecutionEffectResult, { kind: "AGENT" }>,
): RunTransitionDraft {
  const outcome = effect.outcome;
  switch (outcome.status) {
    case "DECIDED":
      return outcome.decision.type === "FINAL_CANDIDATE"
        ? {
            // A final candidate moves toward verification. It is never a completion.
            status: "VERIFYING",
            continuation: "AWAITING_VERIFICATION",
            stepSettlement: "COMPLETED",
            clearActiveStep: true,
            messageAppend: "EFFECT_MESSAGES",
            events: ["llm.completed", "step.completed", "status.changed"],
            summary: "Final candidate produced; verification is required.",
          }
        : {
            continuation: "WAITING_TOOL_RESULTS",
            stepSettlement: "COMPLETED",
            clearActiveStep: true,
            messageAppend: "EFFECT_MESSAGES",
            events: ["llm.completed", "step.completed"],
            summary: "Tool calls requested.",
          };
    case "CANCELLED":
      return {
        finalization: { reason: "CANCELLED" },
        stepSettlement: "CANCELLED",
        clearActiveStep: true,
        events: ["step.cancelled", "status.changed"],
        summary: "The model turn was cancelled.",
      };
    case "FAILED":
      return outcome.stage === "MODEL"
        ? {
            // The provider really was attempted, so the Step settles as failed. Retry metadata is
            // reported, never acted on: the Run Retry layer decides what a retryable failure means.
            stepSettlement: "FAILED",
            clearActiveStep: true,
            events: ["llm.failed", "step.failed"],
            summary: "The model turn failed.",
          }
        : {
            // A failure before the durable boundary created no Step attempt and must settle none.
            events: [],
            summary: "The turn failed before the durable boundary.",
          };
  }
}

function planToolsTransition(
  effect: Extract<RunExecutionEffectResult, { kind: "TOOLS" }>,
): RunTransitionDraft {
  switch (effect.result.kind) {
    case "COMPLETED":
      return {
        continuation: "WAITING_TOOL_RESULTS",
        messageAppend: "EFFECT_MESSAGES",
        events: ["tool.batch.completed"],
        summary: "A Tool batch settled with complete results.",
      };
    case "WAITING_APPROVAL":
      return {
        status: "WAITING_APPROVAL",
        continuation: "WAITING_TOOL_RESULTS",
        events: ["approval.requested", "status.changed"],
        summary: "A Tool requires approval.",
      };
    case "BUDGET_EXCEEDED":
      return {
        finalization: { reason: "BUDGET_EXCEEDED", block: effect.result.block },
        events: ["budget.exceeded", "status.changed"],
        summary: "The Run budget was exceeded.",
      };
    case "RESOURCE_WAIT":
      return {
        status: "WAITING_RESOURCE",
        continuation: "WAITING_RESOURCE",
        events: ["resource.waiting", "status.changed"],
        summary: "Execution is waiting for a resource decision.",
      };
    case "REPLAN":
      return {
        continuation: "WAITING_TOOL_RESULTS",
        messageAppend: "EFFECT_MESSAGES",
        events: ["resource.replan"],
        summary: "A synthetic Tool result asks the model to replan.",
      };
  }
}

function planCompletionTransition(
  effect: Extract<RunExecutionEffectResult, { kind: "COMPLETION" }>,
): RunTransitionDraft {
  switch (effect.decision.outcome) {
    case "ACCEPT":
      return {
        status: "COMPLETED",
        continuation: null,
        clearActiveStep: true,
        events: ["verification.finalized", "status.changed", "run.completed"],
        summary: "The completion gate accepted the candidate.",
      };
    case "REPAIR":
      return {
        // The same Run opens a new loop epoch. A repair is never a new Run.
        continuation: "WAITING_VERIFICATION_REPAIR",
        events: ["verification.repair.started"],
        summary: "The completion gate asked for a repair in this Run.",
      };
    case "REJECT":
      return {
        finalization: {
          reason: "FAILED",
          error: { code: "VERIFICATION_FAILED", message: effect.decision.reason, retryable: false },
        },
        events: ["verification.finalized", "error", "status.changed", "run.failed"],
        summary: "The completion gate rejected the candidate.",
      };
    case "ERROR":
      // An infrastructure error leaves the Run where it was so recovery can retry the boundary.
      return {
        events: [],
        summary: "The completion gate could not reach a decision.",
      };
  }
}
