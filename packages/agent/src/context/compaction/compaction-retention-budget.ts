import type { CompactionTargetStatus } from "./context-checkpoint-v3.js";

export interface CompactionRetentionBudget {
  /** Non-history content in the prepared input. */
  readonly fixedTokens: number;
  /** Preferred recent-history allowance; this is a soft target. */
  readonly recentTokens: number;
  /** Recent history that cannot be removed while preserving a legal continuation. */
  readonly protectedRecentTokens: number;
  readonly checkpointMaxTokens: number;
  readonly boundaryTokens: number;
  /** Sum of soft retention goals, before checking the actual rebuilt input. */
  readonly targetInputTokens: number;
  /** Hard input ceiling after request reserves and next-turn growth have been removed. */
  readonly availableInputTokens: number;
  /** Necessary prepared input floor, excluding the replaceable summary upper bound. */
  readonly protectedFloorInputTokens: number;
}

export interface CompactionRetentionBudgetInput {
  readonly fixedTokens: number;
  readonly recentTokens: number;
  readonly protectedRecentTokens?: number;
  readonly checkpointMaxTokens: number;
  readonly boundaryTokens: number;
  readonly availableInputTokens: number;
}

export interface CompactionCandidateEvaluation {
  readonly accepted: boolean;
  readonly status?: Extract<CompactionTargetStatus, "PREFERRED" | "ELASTIC" | "FLOOR_LIMITED">;
  readonly reason?: "REQUEST_TOO_LARGE" | "INSUFFICIENT_REDUCTION" | "PROTECTED_CONTENT_MISSING";
  readonly actualFreedTokens: number;
  readonly minimumReleaseTokens: number;
}

export interface CompactionRetentionDiagnostics {
  readonly status: Extract<CompactionTargetStatus, "PREFERRED" | "ELASTIC" | "FLOOR_LIMITED">;
  readonly preferredInputTokens: number;
  readonly protectedFloorInputTokens: number;
  readonly hardInputLimitTokens: number;
  readonly compressibleTokens: number;
  readonly minimumReleaseRatio: number;
  readonly minimumReleaseTokens: number;
  readonly actualFreedTokens: number;
}

/** Resolve separate preferred, protected, and hard input budgets. */
export function resolveCompactionRetentionBudget(
  input: CompactionRetentionBudgetInput,
): CompactionRetentionBudget {
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer.`);
    }
  }
  if (input.availableInputTokens < 1) {
    throw new RangeError("availableInputTokens must be positive.");
  }

  const protectedRecentTokens = input.protectedRecentTokens ?? 0;
  const recentTokens = Math.max(input.recentTokens, protectedRecentTokens);
  const targetInputTokens =
    input.fixedTokens + recentTokens + input.checkpointMaxTokens + input.boundaryTokens;
  const protectedFloorInputTokens = input.fixedTokens + protectedRecentTokens;
  if (
    !Number.isSafeInteger(targetInputTokens) ||
    !Number.isSafeInteger(protectedFloorInputTokens)
  ) {
    throw new RangeError("Compaction retention target exceeds safe integer range.");
  }

  return Object.freeze({
    fixedTokens: input.fixedTokens,
    recentTokens,
    protectedRecentTokens,
    checkpointMaxTokens: input.checkpointMaxTokens,
    boundaryTokens: input.boundaryTokens,
    targetInputTokens,
    availableInputTokens: input.availableInputTokens,
    protectedFloorInputTokens,
  });
}

/** Evaluate the rebuilt, complete input against the soft target, protected floor, and hard limit. */
export function evaluateCompactionCandidate(input: {
  readonly inputTokens: number;
  readonly inputTokensBefore: number;
  readonly compressibleTokens: number;
  readonly minimumReleaseRatio: number;
  readonly minimumReleaseTokens?: number;
  readonly minimumLegalCut: boolean;
  readonly budget: CompactionRetentionBudget;
}): CompactionCandidateEvaluation {
  const compressibleTokens = assertPositiveSafeInteger(
    input.compressibleTokens,
    "compressibleTokens",
  );
  const minimumReleaseRatio = assertRatio(input.minimumReleaseRatio, "minimumReleaseRatio");
  if (!Number.isSafeInteger(input.inputTokensBefore) || input.inputTokensBefore < 0) {
    throw new RangeError("inputTokensBefore must be a non-negative safe integer.");
  }
  const minimumReleaseTokens =
    input.minimumReleaseTokens ?? Math.ceil(compressibleTokens * minimumReleaseRatio);
  assertPositiveSafeInteger(minimumReleaseTokens, "minimumReleaseTokens");
  if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0) {
    return rejected("INSUFFICIENT_REDUCTION", 0, minimumReleaseTokens);
  }
  if (input.inputTokens > input.budget.availableInputTokens) {
    return rejected(
      "REQUEST_TOO_LARGE",
      input.inputTokensBefore - input.inputTokens,
      minimumReleaseTokens,
    );
  }
  if (input.inputTokens < input.budget.protectedFloorInputTokens) {
    return rejected("PROTECTED_CONTENT_MISSING", 0, minimumReleaseTokens);
  }
  const actualFreedTokens = input.inputTokensBefore - input.inputTokens;
  if (actualFreedTokens <= 0) {
    return rejected("INSUFFICIENT_REDUCTION", actualFreedTokens, minimumReleaseTokens);
  }
  if (actualFreedTokens >= minimumReleaseTokens) {
    return Object.freeze({
      accepted: true,
      status: input.inputTokens <= input.budget.targetInputTokens ? "PREFERRED" : "ELASTIC",
      actualFreedTokens,
      minimumReleaseTokens,
    });
  }
  // A minimum cut alone does not prove that required raw content limits the result: the summary
  // may itself be oversized. The protected history plus bounded summary and boundary must explain
  // the complete rebuilt input before the minimum-release exception can apply.
  const maximumFloorInputTokens =
    input.budget.protectedFloorInputTokens +
    input.budget.checkpointMaxTokens +
    input.budget.boundaryTokens;
  if (
    input.minimumLegalCut &&
    input.inputTokens >= input.budget.protectedFloorInputTokens &&
    input.inputTokens <= maximumFloorInputTokens
  ) {
    return Object.freeze({
      accepted: true,
      status: "FLOOR_LIMITED",
      actualFreedTokens,
      minimumReleaseTokens,
    });
  }
  return rejected("INSUFFICIENT_REDUCTION", actualFreedTokens, minimumReleaseTokens);
}

/** Compatibility helper for callers that only know the historic target and hard ceiling. */
export function acceptCompactionCandidate(input: {
  readonly inputTokens: number;
  readonly budget: CompactionRetentionBudget;
  readonly inputTokensBefore?: number;
  readonly compressibleTokens?: number;
  readonly minimumReleaseRatio?: number;
  readonly minimumReleaseTokens?: number;
  readonly minimumLegalCut?: boolean;
}): boolean {
  if (
    input.inputTokensBefore === undefined ||
    input.compressibleTokens === undefined ||
    input.minimumReleaseRatio === undefined ||
    input.minimumLegalCut === undefined
  ) {
    return (
      Number.isSafeInteger(input.inputTokens) &&
      input.inputTokens >= 0 &&
      input.inputTokens <= input.budget.targetInputTokens &&
      input.inputTokens <= input.budget.availableInputTokens
    );
  }
  return evaluateCompactionCandidate({
    inputTokens: input.inputTokens,
    inputTokensBefore: input.inputTokensBefore,
    compressibleTokens: input.compressibleTokens,
    minimumReleaseRatio: input.minimumReleaseRatio,
    ...(input.minimumReleaseTokens === undefined
      ? {}
      : { minimumReleaseTokens: input.minimumReleaseTokens }),
    minimumLegalCut: input.minimumLegalCut,
    budget: input.budget,
  }).accepted;
}

function rejected(
  reason: "REQUEST_TOO_LARGE" | "INSUFFICIENT_REDUCTION" | "PROTECTED_CONTENT_MISSING",
  actualFreedTokens: number,
  minimumReleaseTokens: number,
): CompactionCandidateEvaluation {
  return Object.freeze({
    accepted: false,
    reason,
    actualFreedTokens,
    minimumReleaseTokens,
  });
}

function assertPositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function assertRatio(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new RangeError(`${name} must be a finite ratio between zero and one.`);
  }
  return value;
}
