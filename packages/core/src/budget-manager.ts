import type { RunLimits } from "@caelush/protocol";
import {
  addCostMicros,
  costMicrosForTokens,
  usdToCostMicros,
  type CostMicros,
} from "./cost-micros.js";

export interface RunBudgetSnapshot {
  readonly toolCallsConsumed: number;
  readonly toolCallsReserved: number;
  readonly tokensConsumed: number;
  readonly tokensReserved: number;
  readonly costMicrosConsumed: number;
  readonly costMicrosReserved: number;
}

export interface ModelPricingSnapshot {
  readonly id: string;
  readonly currency: "USD";
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
}

export interface ToolBudgetAdmissionInput {
  readonly limits: RunLimits;
  readonly snapshot: RunBudgetSnapshot;
  readonly requested: number;
}

export interface LLMBudgetAdmissionInput {
  readonly limits: RunLimits;
  readonly snapshot: RunBudgetSnapshot;
  readonly estimatedInputTokens: number;
  readonly configuredMaxOutputTokens?: number;
  readonly pricing?: ModelPricingSnapshot;
}

export type ToolBudgetAdmission =
  | { readonly kind: "ALLOWED"; readonly reservedToolCalls: number }
  | {
      readonly kind: "EXCEEDED";
      readonly dimension: "TOOL_CALLS";
      readonly accounted: number;
      readonly limit: number;
    };

export type LLMBudgetAdmission =
  | {
      readonly kind: "ALLOWED";
      readonly effectiveMaxOutputTokens?: number;
      readonly reservedInputTokens: number;
      readonly reservedOutputTokens: number;
      readonly reservedCostMicros: CostMicros | 0;
      readonly pricing?: ModelPricingSnapshot;
    }
  | {
      readonly kind: "EXCEEDED";
      readonly dimension: "TOKENS" | "COST";
      readonly accounted: number;
      readonly limit: number;
    }
  | { readonly kind: "UNAVAILABLE"; readonly reason: "PRICING" | "TOKEN_ESTIMATE" };

export class BudgetManager {
  admitToolCalls(input: ToolBudgetAdmissionInput): ToolBudgetAdmission {
    assertSafeNonNegative(input.requested, "requested Tool calls");
    const accounted = safeAdd(
      input.snapshot.toolCallsConsumed,
      input.snapshot.toolCallsReserved,
      "Tool call accounting",
    );
    if (accounted > input.limits.maxToolCalls - input.requested) {
      return {
        kind: "EXCEEDED",
        dimension: "TOOL_CALLS",
        accounted,
        limit: input.limits.maxToolCalls,
      };
    }
    return { kind: "ALLOWED", reservedToolCalls: input.requested };
  }

  admitLLM(input: LLMBudgetAdmissionInput): LLMBudgetAdmission {
    if (!Number.isSafeInteger(input.estimatedInputTokens) || input.estimatedInputTokens < 0) {
      return { kind: "UNAVAILABLE", reason: "TOKEN_ESTIMATE" };
    }
    if (input.limits.maxCost !== undefined && input.pricing === undefined) {
      return { kind: "UNAVAILABLE", reason: "PRICING" };
    }
    if (input.pricing !== undefined) {
      assertSafeNonNegative(input.pricing.inputMicrosPerMillionTokens, "input pricing rate");
      assertSafeNonNegative(input.pricing.outputMicrosPerMillionTokens, "output pricing rate");
    }
    const tokenAllowance = this.tokenAllowance(input);
    if (tokenAllowance.kind !== "ALLOWED") return tokenAllowance;
    const costAllowance = this.costAllowance(input);
    if (costAllowance.kind !== "ALLOWED") return costAllowance;
    const configured = input.configuredMaxOutputTokens ?? Number.MAX_SAFE_INTEGER;
    const effectiveMaxOutputTokens = Math.min(
      configured,
      tokenAllowance.output,
      costAllowance.output,
    );
    const budgetEnabled =
      input.limits.maxTokens !== undefined || input.limits.maxCost !== undefined;
    if (budgetEnabled && effectiveMaxOutputTokens < 1) {
      return {
        kind: "EXCEEDED",
        dimension: costAllowance.limited ? "COST" : "TOKENS",
        accounted: costAllowance.limited ? costAllowance.accounted : tokenAllowance.accounted,
        limit: costAllowance.limited ? costAllowance.limit : tokenAllowance.limit,
      };
    }
    const reservedCostMicros =
      input.pricing === undefined
        ? 0
        : addCostMicros(
            costMicrosForTokens(
              input.estimatedInputTokens,
              input.pricing.inputMicrosPerMillionTokens,
            ),
            costMicrosForTokens(
              effectiveMaxOutputTokens,
              input.pricing.outputMicrosPerMillionTokens,
            ),
          );
    return {
      kind: "ALLOWED",
      ...(effectiveMaxOutputTokens === Number.MAX_SAFE_INTEGER ? {} : { effectiveMaxOutputTokens }),
      reservedInputTokens: input.estimatedInputTokens,
      reservedOutputTokens:
        effectiveMaxOutputTokens === Number.MAX_SAFE_INTEGER ? 0 : effectiveMaxOutputTokens,
      reservedCostMicros,
      ...(input.pricing === undefined ? {} : { pricing: input.pricing }),
    };
  }

  private tokenAllowance(input: LLMBudgetAdmissionInput):
    | {
        readonly kind: "ALLOWED";
        readonly output: number;
        readonly accounted: number;
        readonly limit: number;
      }
    | Extract<LLMBudgetAdmission, { kind: "EXCEEDED" }> {
    if (input.limits.maxTokens === undefined) {
      return { kind: "ALLOWED", output: Number.MAX_SAFE_INTEGER, accounted: 0, limit: 0 };
    }
    const accounted = safeAdd(
      input.snapshot.tokensConsumed,
      input.snapshot.tokensReserved,
      "Token accounting",
    );
    const remaining = input.limits.maxTokens - accounted;
    const output = remaining - input.estimatedInputTokens;
    if (output < 1)
      return { kind: "EXCEEDED", dimension: "TOKENS", accounted, limit: input.limits.maxTokens };
    return { kind: "ALLOWED", output, accounted, limit: input.limits.maxTokens };
  }

  private costAllowance(input: LLMBudgetAdmissionInput):
    | {
        readonly kind: "ALLOWED";
        readonly output: number;
        readonly limited: boolean;
        readonly accounted: number;
        readonly limit: number;
      }
    | Extract<LLMBudgetAdmission, { kind: "EXCEEDED" }> {
    if (input.limits.maxCost === undefined) {
      return {
        kind: "ALLOWED",
        output: Number.MAX_SAFE_INTEGER,
        limited: false,
        accounted: 0,
        limit: 0,
      };
    }
    const pricing = input.pricing!;
    const limit = usdToCostMicros(input.limits.maxCost);
    const accounted = safeAdd(
      input.snapshot.costMicrosConsumed,
      input.snapshot.costMicrosReserved,
      "Cost accounting",
    );
    const inputCost = costMicrosForTokens(
      input.estimatedInputTokens,
      pricing.inputMicrosPerMillionTokens,
    );
    const remainingAfterInput = limit - accounted - inputCost;
    const output =
      pricing.outputMicrosPerMillionTokens === 0 || remainingAfterInput < 0
        ? pricing.outputMicrosPerMillionTokens === 0
          ? Number.MAX_SAFE_INTEGER
          : 0
        : Math.min(
            Number.MAX_SAFE_INTEGER,
            Number(
              (BigInt(remainingAfterInput) * 1_000_000n) /
                BigInt(pricing.outputMicrosPerMillionTokens),
            ),
          );
    if (output < 1 && pricing.outputMicrosPerMillionTokens > 0) {
      return { kind: "EXCEEDED", dimension: "COST", accounted, limit };
    }
    return { kind: "ALLOWED", output, limited: true, accounted, limit };
  }
}

function assertSafeNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be safe.`);
}

function safeAdd(left: number, right: number, label: string): number {
  assertSafeNonNegative(left, label);
  assertSafeNonNegative(right, label);
  if (left > Number.MAX_SAFE_INTEGER - right) throw new RangeError(`${label} overflowed.`);
  return left + right;
}
