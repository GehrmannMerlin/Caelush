import type {
  AgentRun,
  AgentState,
  AgentStep,
  RunId,
  StepId,
  TimestampMs,
} from "@caelush/protocol";
import { AgentRunSchema, AgentStateSchema } from "@caelush/protocol";
import {
  BudgetManager,
  createDefaultLLMTokenEstimator,
  costMicrosForTokens,
  normalizeLLMUsageForBudget,
  usdToCostMicros,
  type LLMTokenEstimator,
  type ModelPricingSnapshot,
  type PricingResolver,
  type LLMBudgetAdmissionInput,
  type ModelUsage as BudgetModelUsage,
  type RunBudgetPort,
} from "@caelush/core";
import type { ToolBudgetAdmission, ToolBudgetAdmissionPort } from "@caelush/tools";
import { SqliteBudgetLedgerRepository } from "./budget-ledger-repository.js";
import type { CaelushDatabase } from "./database.js";
import { decodeProtocol } from "./codec.js";

export interface SqliteRunBudgetPortOptions {
  readonly tokenEstimator?: LLMTokenEstimator;
  readonly pricing?: PricingResolver;
  readonly clock?: { now(): TimestampMs };
}

/** Durable adapter shared by RunController and ToolDispatcher. */
export class SqliteRunBudgetPort implements RunBudgetPort, ToolBudgetAdmissionPort {
  private readonly manager = new BudgetManager();
  private readonly tokenEstimator: LLMTokenEstimator;
  private readonly clock: { now(): TimestampMs };
  private readonly ledger: SqliteBudgetLedgerRepository;

  constructor(
    private readonly database: CaelushDatabase,
    private readonly options: SqliteRunBudgetPortOptions = {},
  ) {
    this.ledger = new SqliteBudgetLedgerRepository(database);
    this.clock = options.clock ?? { now: () => Date.now() as TimestampMs };
    this.tokenEstimator = options.tokenEstimator ?? createDefaultLLMTokenEstimator();
  }

  async admit(input: {
    readonly runId: RunId;
    readonly requested: number;
    readonly invocationId?: string;
  }): Promise<ToolBudgetAdmission> {
    const snapshot = await this.ledger.snapshot(input.runId);
    const run = await this.loadRun(input.runId);
    const result = this.manager.admitToolCalls({
      limits: run.limits,
      ...(run.resourcePolicy === undefined ? {} : { policy: run.resourcePolicy }),
      snapshot,
      requested: input.requested,
    });
    if (result.kind === "EXCEEDED") return result;
    if (input.invocationId !== undefined) {
      await this.ledger.reserve({
        id: `tool:${input.invocationId}`,
        runId: input.runId,
        kind: "TOOL_INVOCATION",
        ownerId: input.invocationId,
        reservedToolCalls: 1,
        createdAt: this.clock.now(),
      });
    }
    return { kind: "ALLOWED" };
  }

  async admitBatch(input: {
    readonly runId: RunId;
    readonly requested: number;
  }): Promise<ToolBudgetAdmission> {
    const snapshot = await this.ledger.snapshot(input.runId);
    const run = await this.loadRun(input.runId);
    const result = this.manager.admitToolCalls({
      limits: run.limits,
      ...(run.resourcePolicy === undefined ? {} : { policy: run.resourcePolicy }),
      snapshot,
      requested: input.requested,
    });
    return result.kind === "EXCEEDED" ? result : { kind: "ALLOWED" };
  }

  async start(input: { readonly runId: RunId; readonly invocationId: string }): Promise<void> {
    const entry = await this.ledger.get(input.runId, "TOOL_INVOCATION", input.invocationId);
    if (
      entry?.state === "IN_FLIGHT" ||
      entry?.state === "SETTLED" ||
      entry?.state === "CONSERVATIVE"
    )
      return;
    if (entry === null) throw new Error("Tool budget reservation is missing.");
    await this.ledger.markInFlight(
      input.runId,
      "TOOL_INVOCATION",
      input.invocationId,
      this.clock.now(),
    );
  }

  async settle(input: { readonly runId: RunId; readonly invocationId: string }): Promise<void> {
    const entry = await this.ledger.get(input.runId, "TOOL_INVOCATION", input.invocationId);
    if (entry === null || entry.state === "SETTLED" || entry.state === "RELEASED") return;
    if (entry.state === "IN_FLIGHT") {
      await this.ledger.settle(input.runId, "TOOL_INVOCATION", input.invocationId, {
        actualInputTokens: 0,
        actualOutputTokens: 0,
        actualCostMicros: 0,
        settledAt: this.clock.now(),
      });
    }
  }

  async admitLLM(input: {
    readonly run: AgentRun;
    readonly step: AgentStep;
    readonly admission: LLMBudgetAdmissionInput;
  }): Promise<import("@caelush/core").RunLLMBudgetAdmission> {
    return this.admitLLMForOwner({ ...input, ownerId: input.step.id, kind: "LLM_ATTEMPT" });
  }

  async admitVerificationLLM(input: {
    readonly run: AgentRun;
    readonly ownerId: string;
    readonly admission: LLMBudgetAdmissionInput;
  }): Promise<import("@caelush/core").RunLLMBudgetAdmission> {
    return this.admitLLMForOwner({ ...input, kind: "VERIFICATION_LLM" });
  }

  private async admitLLMForOwner(input: {
    readonly run: AgentRun;
    readonly ownerId: string;
    readonly admission: LLMBudgetAdmissionInput;
    readonly kind: "LLM_ATTEMPT" | "VERIFICATION_LLM";
  }): Promise<import("@caelush/core").RunLLMBudgetAdmission> {
    const estimatedInputTokens = input.admission.estimatedInputTokens;
    if (estimatedInputTokens === undefined) {
      if (input.run.limits.maxTokens !== undefined || input.run.limits.maxCost !== undefined) {
        return { kind: "UNAVAILABLE", reason: "TOKEN_ESTIMATE" };
      }
    }
    const pricing = this.options.pricing?.resolve(input.run.model);
    const decision = this.manager.admitLLM({
      limits: input.run.limits,
      snapshot: await this.ledger.snapshot(input.run.id),
      estimatedInputTokens: estimatedInputTokens ?? 0,
      ...(input.admission.configuredMaxOutputTokens === undefined
        ? {}
        : { configuredMaxOutputTokens: input.admission.configuredMaxOutputTokens }),
      ...(pricing === undefined ? {} : { pricing }),
    });
    if (decision.kind === "EXCEEDED" || decision.kind === "UNAVAILABLE") return decision;
    const createdAt = this.clock.now();
    await this.ledger.reserve({
      id: `${input.kind.toLowerCase()}:${input.ownerId}`,
      runId: input.run.id,
      kind: input.kind,
      ownerId: input.ownerId,
      reservedInputTokens: decision.reservedInputTokens,
      reservedOutputTokens: decision.reservedOutputTokens,
      reservedCostMicros: decision.reservedCostMicros,
      modelProvider: input.run.model.provider,
      modelId: input.run.model.model,
      ...(decision.pricing === undefined ? {} : pricingColumns(decision.pricing)),
      createdAt,
    });
    await this.ledger.markInFlight(input.run.id, input.kind, input.ownerId, createdAt);
    // The durable port returns the admitted ceiling as a number; the caller applies
    // it to its own request, so this package never handles a model request object.
    return {
      kind: "ALLOWED",
      ...(decision.effectiveMaxOutputTokens === undefined
        ? {}
        : { effectiveMaxOutputTokens: decision.effectiveMaxOutputTokens }),
    };
  }

  async settleLLM(input: {
    readonly runId: RunId;
    readonly stepId: StepId;
    readonly usage?: BudgetModelUsage;
    readonly settledAt: TimestampMs;
  }): Promise<import("@caelush/core").RunBudgetSettlement | void> {
    return this.settleLLMForOwner({ ...input, ownerId: input.stepId, kind: "LLM_ATTEMPT" });
  }

  async settleVerificationLLM(input: {
    readonly runId: RunId;
    readonly ownerId: string;
    readonly usage?: BudgetModelUsage;
    readonly settledAt: TimestampMs;
  }): Promise<import("@caelush/core").RunBudgetSettlement | void> {
    return this.settleLLMForOwner({ ...input, kind: "VERIFICATION_LLM" });
  }

  private async settleLLMForOwner(input: {
    readonly runId: RunId;
    readonly ownerId: string;
    readonly usage?: BudgetModelUsage;
    readonly settledAt: TimestampMs;
    readonly kind: "LLM_ATTEMPT" | "VERIFICATION_LLM";
  }): Promise<import("@caelush/core").RunBudgetSettlement | void> {
    const entry = await this.ledger.get(input.runId, input.kind, input.ownerId);
    if (entry === null || entry.state === "SETTLED" || entry.state === "CONSERVATIVE") {
      return this.checkPostSettlementBudget(input.runId);
    }
    const normalized = normalizeLLMUsageForBudget(input.usage, {
      reservedTotalTokens: entry.reservedInputTokens + entry.reservedOutputTokens,
    });
    if (
      normalized.confidence !== "EXACT" ||
      normalized.inputTokens === undefined ||
      normalized.outputTokens === undefined
    ) {
      await this.ledger.markConservative(input.runId, input.kind, input.ownerId, input.settledAt);
      return this.checkPostSettlementBudget(input.runId);
    }
    const actualCostMicros =
      entry.inputRateMicrosPerMillion === undefined ||
      entry.outputRateMicrosPerMillion === undefined
        ? 0
        : costMicrosForTokens(normalized.inputTokens, entry.inputRateMicrosPerMillion) +
          costMicrosForTokens(normalized.outputTokens, entry.outputRateMicrosPerMillion);
    await this.ledger.settle(input.runId, input.kind, input.ownerId, {
      actualInputTokens: normalized.inputTokens,
      actualOutputTokens: normalized.outputTokens,
      actualCostMicros,
      settledAt: input.settledAt,
    });
    return this.checkPostSettlementBudget(input.runId);
  }

  async markLLMConservative(input: {
    readonly runId: RunId;
    readonly stepId: StepId;
    readonly settledAt: TimestampMs;
  }): Promise<void> {
    await this.markLLMConservativeForOwner({
      ...input,
      ownerId: input.stepId,
      kind: "LLM_ATTEMPT",
    });
  }

  async markVerificationLLMConservative(input: {
    readonly runId: RunId;
    readonly ownerId: string;
    readonly settledAt: TimestampMs;
  }): Promise<void> {
    await this.markLLMConservativeForOwner({ ...input, kind: "VERIFICATION_LLM" });
  }

  private async markLLMConservativeForOwner(input: {
    readonly runId: RunId;
    readonly ownerId: string;
    readonly settledAt: TimestampMs;
    readonly kind: "LLM_ATTEMPT" | "VERIFICATION_LLM";
  }): Promise<void> {
    const entry = await this.ledger.get(input.runId, input.kind, input.ownerId);
    if (entry?.state === "IN_FLIGHT") {
      await this.ledger.markConservative(input.runId, input.kind, input.ownerId, input.settledAt);
    }
  }

  async recover(runId: RunId, settledAt: TimestampMs): Promise<void> {
    await this.ledger.recoverInFlight(runId, settledAt);
  }

  async reconcileState(state: AgentState): Promise<AgentState> {
    const snapshot = await this.ledger.snapshot(state.runId);
    const cost =
      snapshot.costMicrosConsumed === 0 ? {} : { cost: snapshot.costMicrosConsumed / 1_000_000 };
    return AgentStateSchema.parse({
      ...state,
      usage: {
        ...state.usage,
        toolCalls: snapshot.toolCallsConsumed,
        inputTokens: snapshot.inputTokensConsumed,
        outputTokens: snapshot.outputTokensConsumed,
        ...cost,
      },
    });
  }

  private async loadRun(runId: RunId): Promise<AgentRun> {
    const row = this.database.client
      .prepare("SELECT data_json FROM agent_runs WHERE id = ?")
      .get(runId) as { data_json: string } | undefined;
    if (row === undefined) throw new Error("Run does not exist.");
    return decodeProtocol(AgentRunSchema, row.data_json, {
      entityType: "AgentRun",
      entityId: runId,
      table: "agent_runs",
    });
  }

  private async loadLimits(runId: RunId): Promise<AgentRun["limits"]> {
    return (await this.loadRun(runId)).limits;
  }

  private async checkPostSettlementBudget(
    runId: RunId,
  ): Promise<import("@caelush/core").RunBudgetSettlement | undefined> {
    const limits = await this.loadLimits(runId);
    const snapshot = await this.ledger.snapshot(runId);
    if (limits.maxTokens !== undefined && snapshot.tokensConsumed > limits.maxTokens) {
      return {
        kind: "EXCEEDED",
        dimension: "TOKENS",
        accounted: snapshot.tokensConsumed,
        limit: limits.maxTokens,
      };
    }
    if (
      limits.maxCost !== undefined &&
      snapshot.costMicrosConsumed > usdToCostMicros(limits.maxCost)
    ) {
      return {
        kind: "EXCEEDED",
        dimension: "COST",
        accounted: snapshot.costMicrosConsumed,
        limit: usdToCostMicros(limits.maxCost),
      };
    }
    return { kind: "SETTLED" };
  }
}

function pricingColumns(pricing: ModelPricingSnapshot) {
  return {
    pricingSnapshotId: pricing.id,
    inputRateMicrosPerMillion: pricing.inputMicrosPerMillionTokens,
    outputRateMicrosPerMillion: pricing.outputMicrosPerMillionTokens,
  } as const;
}
