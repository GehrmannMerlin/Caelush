import type { ContextPolicy } from "./context-policy.js";
import {
  createDeterministicMinimalCheckpoint,
  createStructuredCheckpoint,
  type CheckpointSourceRange,
  type StructuredCheckpoint,
} from "./checkpoint.js";
import { selectSafeExecutionUnits, type ExecutionUnit } from "./execution-unit.js";

export type ContextPressureState =
  "NORMAL" | "PROACTIVE" | "EMERGENCY" | "RECOVERING_OVERFLOW" | "EXHAUSTED";

export class ContextPressureStateMachine {
  private currentState: ContextPressureState = "NORMAL";
  private readonly postCompactionTargetTokens: number;

  constructor(private readonly policy: ContextPolicy) {
    this.postCompactionTargetTokens = Math.floor(
      policy.effectiveInputLimit * policy.postCompactionTargetRatio,
    );
  }

  get state(): ContextPressureState {
    return this.currentState;
  }

  observe(estimatedInputTokens: number): ContextPressureState {
    if (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0) {
      throw new RangeError("estimatedInputTokens must be a non-negative safe integer");
    }
    const ratio = estimatedInputTokens / this.policy.effectiveInputLimit;
    if (ratio >= this.policy.emergencyCompactionRatio) this.currentState = "EMERGENCY";
    else if (
      ratio >= this.policy.proactiveCompactionRatio ||
      ((this.currentState === "PROACTIVE" || this.currentState === "EMERGENCY") &&
        estimatedInputTokens > this.postCompactionTargetTokens)
    ) {
      this.currentState = "PROACTIVE";
    } else if (this.currentState !== "RECOVERING_OVERFLOW" && this.currentState !== "EXHAUSTED") {
      this.currentState = "NORMAL";
    }
    return this.currentState;
  }

  markRecovering(): void {
    this.currentState = "RECOVERING_OVERFLOW";
  }

  markRecovered(estimatedInputTokens: number): void {
    this.observe(estimatedInputTokens);
    if (estimatedInputTokens <= this.postCompactionTargetTokens) {
      this.currentState = "NORMAL";
    }
  }

  markExhausted(): void {
    this.currentState = "EXHAUSTED";
  }
}

export interface ContextCompactionModelInput {
  readonly goal: string;
  readonly units: readonly ExecutionUnit[];
  readonly sourceRange: CheckpointSourceRange;
  readonly changedFiles: readonly string[];
  readonly recentErrors: readonly string[];
  readonly verificationState: string;
}

export type ContextCompactionModel = (
  input: ContextCompactionModelInput,
) => Promise<StructuredCheckpoint>;

export interface ContextCompactionInput extends ContextCompactionModelInput {
  readonly runId: string;
  readonly estimatedInputTokens: number;
  readonly units: readonly ExecutionUnit[];
  readonly compactor?: ContextCompactionModel;
}

export interface ContextCompactionResult {
  readonly runId: string;
  readonly checkpoint: StructuredCheckpoint;
  readonly selectedUnits: readonly ExecutionUnit[];
  readonly openUnits: readonly ExecutionUnit[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly compactionCount: number;
  readonly degraded: boolean;
}

export interface ContextPressureControllerOptions {
  readonly policy: ContextPolicy;
  readonly maxCompactionRetries?: number;
}

export class ContextPressureController {
  private compactionCount = 0;
  readonly postCompactionTargetRatio: number;
  readonly postCompactionTargetTokens: number;
  private readonly maxCompactionRetries: number;

  constructor(private readonly options: ContextPressureControllerOptions) {
    this.postCompactionTargetRatio = options.policy.postCompactionTargetRatio;
    this.postCompactionTargetTokens = Math.floor(
      options.policy.effectiveInputLimit * this.postCompactionTargetRatio,
    );
    this.maxCompactionRetries = options.maxCompactionRetries ?? 1;
  }

  get count(): number {
    return this.compactionCount;
  }

  shouldCompact(estimatedInputTokens: number): boolean {
    return estimatedInputTokens >= this.options.policy.proactiveCompactionTokens;
  }

  async compact(input: ContextCompactionInput): Promise<ContextCompactionResult> {
    if (!Number.isSafeInteger(input.estimatedInputTokens) || input.estimatedInputTokens < 0) {
      throw new RangeError("estimatedInputTokens must be a non-negative safe integer");
    }
    const selectedUnits = selectSafeExecutionUnits(input.units, Number.MAX_SAFE_INTEGER);
    const openUnits = input.units.filter((unit) => unit.status === "OPEN");
    let checkpoint: StructuredCheckpoint | undefined;
    let degraded = false;
    if (input.compactor !== undefined) {
      for (let attempt = 0; attempt <= this.maxCompactionRetries; attempt += 1) {
        try {
          checkpoint = await input.compactor({
            goal: input.goal,
            units: selectedUnits,
            sourceRange: input.sourceRange,
            changedFiles: input.changedFiles,
            recentErrors: input.recentErrors,
            verificationState: input.verificationState,
          });
          break;
        } catch {
          if (attempt === this.maxCompactionRetries) degraded = true;
        }
      }
    }
    if (checkpoint === undefined) {
      checkpoint = createDeterministicMinimalCheckpoint({
        goal: input.goal,
        changedFiles: input.changedFiles,
        recentErrors: input.recentErrors,
        verificationState: input.verificationState,
        sourceRange: input.sourceRange,
      });
      degraded = input.compactor !== undefined;
    }
    this.compactionCount += 1;
    return {
      runId: input.runId,
      checkpoint,
      selectedUnits,
      openUnits,
      tokensBefore: input.estimatedInputTokens,
      tokensAfter: Math.min(input.estimatedInputTokens, this.postCompactionTargetTokens),
      compactionCount: this.compactionCount,
      degraded,
    };
  }
}

export { createStructuredCheckpoint };
