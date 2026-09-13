/**
 * The legacy Core decision facade.
 *
 * Phase 3A moved every agent decision contract into `@caelush/agent`, where it is written
 * in `@caelush/ai` and `@caelush/protocol` types. This module is a compatibility re-export
 * so existing Core call sites keep their import path while the migration continues. It
 * declares nothing of its own except the Run Layer outcome below, which is not an agent
 * decision at all.
 *
 * The general Agent Kernel deliberately owns no shape for structural step exhaustion: the
 * `maxSteps` gate is a Run Layer gate, and the agent loop must not know what `maxSteps` is.
 */
export type {
  AgentDecision,
  AgentFinalCandidateDecision,
  AgentModelTurn,
  AgentToolCallsDecision,
  AgentToolRequest,
} from "@caelush/agent";

/** A Run that stopped because the structural step budget ran out. */
export interface AgentMaxStepsReachedOutcome {
  readonly type: "MAX_STEPS_REACHED";
  readonly stepsCompleted: number;
  readonly maxSteps: number;
}

/**
 * What one AgentLoop call produced, in the Run Layer's vocabulary.
 *
 * `MAX_STEPS_REACHED` is a Run Layer outcome rather than a model decision: the model did
 * not decide to stop, the loop gate did.
 */
export type AgentLoopOutcome = import("@caelush/agent").AgentDecision | AgentMaxStepsReachedOutcome;
