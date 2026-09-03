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
}

export class ResourceLoopDetector {
  constructor(private readonly policy: ResourceLoopDetectorPolicy) {}

  evaluate(input: ResourceLoopEvaluationInput): ResourceLoopLevel {
    if (input.replanCount >= this.policy.replansBeforePause) {
      if (input.noProgressTurns >= this.policy.noProgressTurnsBeforeReplan) {
        return "WAITING_RESOURCE";
      }
    }
    if (input.noProgressTurns >= this.policy.noProgressTurnsBeforeReplan) {
      return "FORCED_REPLAN";
    }
    if (input.exactRepeatCount >= this.policy.identicalCallNudgeThreshold) {
      return "NUDGE";
    }
    if (input.exactRepeatCount > 0 || input.noProgressTurns > 0) return "OBSERVE";
    return "HEALTHY";
  }
}
