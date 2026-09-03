import type { ContextPolicy } from "./context-policy.js";
import {
  createDeterministicMinimalCheckpoint,
  createStructuredCheckpoint,
  type CheckpointSourceRange,
  type StructuredCheckpoint,
} from "./checkpoint.js";
import { selectSafeExecutionUnits, type ExecutionUnit } from "./execution-unit.js";

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
  readonly postCompactionTargetTokens: number;
  private readonly maxCompactionRetries: number;

  constructor(private readonly options: ContextPressureControllerOptions) {
    this.postCompactionTargetTokens = Math.floor(options.policy.proactiveCompactionTokens * 0.8);
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
