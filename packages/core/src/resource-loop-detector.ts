export type ResourceLoopLevel =
  "HEALTHY" | "OBSERVE" | "NUDGE" | "FORCED_REPLAN" | "WAITING_RESOURCE";

export interface ResourceLoopDetectorPolicy {
  readonly windowTurns: number;
  readonly identicalCallNudgeThreshold: number;
  readonly noProgressTurnsBeforeReplan: number;
  readonly replansBeforePause: number;
}

export interface ResourceLoopEvaluationInput {
  readonly exactRepeatCount: number;
  readonly noProgressTurns: number;
  readonly replanCount: number;
  /**
   * A repeated semantic pattern, when one is active.
   *
   * The counter-based rules below stay exactly as they were; this is an additional, narrower
   * signal. `WAITING_RESOURCE` here means the same pattern survived the configured number of
   * re-plans, not that the Run has been running for a long time.
   */
  readonly semanticLevel?: "NUDGE" | "FORCED_REPLAN" | "WAITING_RESOURCE" | undefined;
}

export class ResourceLoopDetector {
  constructor(private readonly policy: ResourceLoopDetectorPolicy) {}

  evaluate(input: ResourceLoopEvaluationInput): ResourceLoopLevel {
    if (input.semanticLevel === "WAITING_RESOURCE") return "WAITING_RESOURCE";
    if (input.semanticLevel === "FORCED_REPLAN") return "FORCED_REPLAN";
    if (input.replanCount >= this.policy.replansBeforePause) {
      if (input.noProgressTurns >= this.policy.noProgressTurnsBeforeReplan) {
        return "WAITING_RESOURCE";
      }
    }
    if (input.noProgressTurns >= this.policy.noProgressTurnsBeforeReplan) {
      return "FORCED_REPLAN";
    }
    if (input.semanticLevel === "NUDGE") return "NUDGE";
    if (input.exactRepeatCount >= this.policy.identicalCallNudgeThreshold) {
      return "NUDGE";
    }
    if (input.exactRepeatCount > 0 || input.noProgressTurns > 0) return "OBSERVE";
    return "HEALTHY";
  }
}
