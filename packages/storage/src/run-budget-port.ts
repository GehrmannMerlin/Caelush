import type {
  AgentRun,
  AgentState,
  AgentStep,
  RunId,
  StepId,
  TimestampMs,
  ToolInvocationId,
  ToolName,
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
  type RunLLMBudgetAdmissionInput,
  type LLMRecoveryBudgetAdmissionInput,
  type ModelUsage as BudgetModelUsage,
  type RunBudgetPort,
} from "@caelush/core";
import type { AgentBudgetBlock, ToolBudgetAdmissionPort } from "@caelush/agent";
import { SqliteBudgetLedgerRepository } from "./budget-ledger-repository.js";
import {
  SqliteProviderInvocationUsageStore,
  type ProviderInvocationUsageRecord,
} from "./provider-invocation-usage-store.js";
import type { CaelushDatabase } from "./database.js";
import { decodeProtocol } from "./codec.js";

export interface SqliteRunBudgetPortOptions {
  readonly tokenEstimator?: LLMTokenEstimator;
  readonly pricing?: PricingResolver;
  readonly clock?: { now(): TimestampMs };
}

/**
 * The legacy Tool budget answer.
 *
 * ```text
 * ALLOWED    there is room
 * EXCEEDED   a budget ran out, with the accounting that says so
 * ```
 *
 * `ToolDispatcher` and the legacy `@caelush/tools` package were removed in Phase 4F. This legacy
 * `ALLOWED | EXCEEDED` answer is retained only because the durable budget ledger's own legacy `admit`
 * and `admitBatch` entry points still answer in it, while the canonical Tool budget view is
 * `createSqliteToolBudgetAdmission(...)`, answering `AgentBudgetBlock | null` over the same ledger.
 * {@link SqliteRunBudgetPort.preflight} and {@link SqliteRunBudgetPort.admitToolInvocation} produce
 * that canonical answer from the same ledger calls. One ledger, two vocabularies, no second
 * accounting.
 */
export type ToolBudgetAdmissionLegacy =
  | { readonly kind: "ALLOWED" }
  | {
      readonly kind: "EXCEEDED";
      readonly dimension: "TOOL_CALLS";
      readonly accounted: number;
      readonly limit: number;
    };

/**
 * Durable budget adapter shared by RunController, the canonical Tool admission layer and the legacy
 * Tool facade.
 *
 * ```text
 * RunBudgetPort             the Run's own LLM, verification and recovery budget
 * legacy    Tool budget     admit, admitBatch, start, settle     → ALLOWED | EXCEEDED
 * canonical Tool budget     createSqliteToolBudgetAdmission(...) → AgentBudgetBlock | null
 * ```
 *
 * Phase 4C does not migrate the Run budget system. It adds a canonical Tool admission view over the
 * same ledger calls — {@link createSqliteToolBudgetAdmission} — and it makes the Tool half of the two
 * lifecycle transitions atomic with the durable Tool commit rather than merely adjacent to it.
 *
 * The two views cannot be one `admit` method: the legacy signature takes a `requested` count and
 * answers `ALLOWED | EXCEEDED`, while the canonical one names the Tool and answers an
 * `AgentBudgetBlock | null`. They are two questions over one ledger, so they are two entry points over
 * one implementation rather than one overloaded method whose two arms disagree about what it returned.
 *
 * ## Timestamps
 *
 * `start` and `settle` are the **idempotent second statement** of a fact the production store already
 * moved inside the `RUNNING` and terminal commits. Neither invents a second answer to "when did this
 * happen"; the invocation's own durable `startedAt`/`finishedAt` are the facts, and the canonical port
 * carries them.
 */
export class SqliteRunBudgetPort implements RunBudgetPort {
  private readonly manager = new BudgetManager();
  private readonly tokenEstimator: LLMTokenEstimator;
  private readonly clock: { now(): TimestampMs };
  private readonly ledger: SqliteBudgetLedgerRepository;
  private readonly providerUsage: SqliteProviderInvocationUsageStore;
  private readonly recoveryAdmissions = new Set<string>();

  constructor(
    private readonly database: CaelushDatabase,
    private readonly options: SqliteRunBudgetPortOptions = {},
  ) {
    this.ledger = new SqliteBudgetLedgerRepository(database);
    this.providerUsage = new SqliteProviderInvocationUsageStore(database);
    this.clock = options.clock ?? { now: () => Date.now() as TimestampMs };
    this.tokenEstimator = options.tokenEstimator ?? createDefaultLLMTokenEstimator();
  }

  async admit(input: {
    readonly runId: RunId;
    readonly requested: number;
    readonly invocationId?: string;
  }): Promise<ToolBudgetAdmissionLegacy> {
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

  /** The legacy whole-segment question, kept for the batch preflight until 4D rewires it. */
  async admitBatch(input: {
    readonly runId: RunId;
    readonly requested: number;
  }): Promise<ToolBudgetAdmissionLegacy> {
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
    if (entry === null) return;
    if (
      entry.state === "IN_FLIGHT" ||
      entry.state === "SETTLED" ||
      entry.state === "CONSERVATIVE" ||
      entry.state === "RELEASED"
    ) {
      return;
    }
    await this.ledger.markInFlight(
      input.runId,
      "TOOL_INVOCATION",
      input.invocationId,
      this.clock.now(),
    );
  }

  async settle(input: { readonly runId: RunId; readonly invocationId: string }): Promise<void> {
    const entry = await this.ledger.get(input.runId, "TOOL_INVOCATION", input.invocationId);
    if (entry === null || entry.state === "SETTLED" || entry.state === "CONSERVATIVE") return;
    if (entry.state === "IN_FLIGHT") {
      await this.ledger.settle(input.runId, "TOOL_INVOCATION", input.invocationId, {
        actualInputTokens: 0,
        actualOutputTokens: 0,
        actualCostMicros: 0,
        settledAt: this.clock.now(),
      });
      return;
    }
    if (entry.state === "RESERVED") {
      await this.ledger.release(input.runId, "TOOL_INVOCATION", input.invocationId);
    }
  }

  /**
   * The canonical Tool budget admission, on top of the same legacy ledger calls.
   *
   * ```text
   * canonical admit({ runId, invocationId, toolName })  → AgentBudgetBlock | null
   * legacy    admit({ runId, requested, invocationId }) → ALLOWED | EXCEEDED
   * ```
   *
   * A Tool call reserves exactly one Tool call, so `requested` is `1` here rather than a parameter: a
   * caller that could ask for ten would be describing a batch admission this port does not perform. The
   * underlying reservation, its identity and its amounts are unchanged.
   */
  async admitToolInvocation(input: {
    readonly runId: RunId;
    readonly invocationId: ToolInvocationId;
    readonly toolName: ToolName;
  }): Promise<AgentBudgetBlock | null> {
    const admission = await this.admit({
      runId: input.runId,
      requested: 1,
      invocationId: input.invocationId,
    });
    return admission.kind === "ALLOWED" ? null : admission;
  }

  /**
   * The canonical whole-segment question.
   *
   * It answers `AgentBudgetBlock | null` and writes nothing: a preflight is a question, and the whole
   * point of asking before the first handler runs is that a segment which does not fit has zero side
   * effects.
   */
  async preflight(
    runId: RunId,
    requests: readonly { readonly externalCallId: string }[],
  ): Promise<AgentBudgetBlock | null> {
    const admission = await this.admitBatch({ runId, requested: requests.length });
    return admission.kind === "ALLOWED" ? null : admission;
  }

  async admitLLM(input: {
    readonly run: AgentRun;
    readonly step: AgentStep;
    readonly admission: RunLLMBudgetAdmissionInput;
  }): Promise<import("@caelush/core").RunLLMBudgetAdmission> {
    return this.admitLLMForOwner({ ...input, ownerId: input.step.id, kind: "LLM_ATTEMPT" });
  }

  async admitLLMRecovery(input: {
    readonly run: AgentRun;
    readonly step: AgentStep;
    readonly admission: RunLLMBudgetAdmissionInput;
    readonly initialOutputCeiling: number;
  }): Promise<import("@caelush/core").RunLLMBudgetAdmission> {
    const ownerKey = `${input.run.id}:${input.step.id}`;
    if (this.recoveryAdmissions.has(ownerKey)) {
      return { kind: "UNAVAILABLE", reason: "TOKEN_ESTIMATE" };
    }
    this.recoveryAdmissions.add(ownerKey);

    const entry = await this.ledger.get(input.run.id, "LLM_ATTEMPT", input.step.id);
    if (entry?.state !== "IN_FLIGHT") return { kind: "UNAVAILABLE", reason: "TOKEN_ESTIMATE" };
    const estimatedInputTokens = input.admission.estimatedInputTokens;
    if (estimatedInputTokens === undefined) {
      if (input.run.limits.maxTokens !== undefined || input.run.limits.maxCost !== undefined) {
        return { kind: "UNAVAILABLE", reason: "TOKEN_ESTIMATE" };
      }
    }

    const stepInvocations = await this.providerUsage.listByRunStep(input.run.id, input.step.id);
    const billing = await this.classifyRecoveryBilling(input.run.id, stepInvocations);
    const hasActiveLimits =
      input.run.limits.maxTokens !== undefined || input.run.limits.maxCost !== undefined;
    if (billing.kind === "UNKNOWN" && hasActiveLimits) {
      return { kind: "UNAVAILABLE", reason: "TOKEN_ESTIMATE" };
    }
    if (stepInvocations.length > 1) return { kind: "UNAVAILABLE", reason: "TOKEN_ESTIMATE" };

    const pricing = pricingFromReservation(entry);
    if (input.run.limits.maxCost !== undefined && pricing === undefined) {
      return { kind: "UNAVAILABLE", reason: "PRICING" };
    }
    const knownInputTokens = billing.kind === "KNOWN" ? billing.inputTokens : 0;
    const knownOutputTokens = billing.kind === "KNOWN" ? billing.outputTokens : 0;
    const knownCostMicros =
      billing.kind !== "KNOWN" || pricing === undefined
        ? 0
        : safeAdd(
            costMicrosForTokens(knownInputTokens, pricing.inputMicrosPerMillionTokens),
            costMicrosForTokens(knownOutputTokens, pricing.outputMicrosPerMillionTokens),
            "Known recovery cost",
          );
    const snapshot = await this.ledger.snapshot(input.run.id);
    const decisionSnapshot = {
      toolCallsConsumed: snapshot.toolCallsConsumed,
      toolCallsReserved: snapshot.toolCallsReserved,
      tokensConsumed: safeAdd(
        snapshot.tokensConsumed,
        safeAdd(knownInputTokens, knownOutputTokens, "Known recovery usage"),
        "Recovery token accounting",
      ),
      tokensReserved: subtractReserved(
        snapshot.tokensReserved,
        entry.reservedInputTokens + entry.reservedOutputTokens,
      ),
      costMicrosConsumed: safeAdd(snapshot.costMicrosConsumed, knownCostMicros, "Recovery cost"),
      costMicrosReserved: subtractReserved(snapshot.costMicrosReserved, entry.reservedCostMicros),
    };
    const decision = this.manager.admitLLMRecovery({
      limits: input.run.limits,
      snapshot: decisionSnapshot,
      estimatedInputTokens: estimatedInputTokens ?? 0,
      initialOutputCeiling: input.initialOutputCeiling,
      ...(input.admission.configuredMaxOutputTokens === undefined
        ? {}
        : { configuredMaxOutputTokens: input.admission.configuredMaxOutputTokens }),
      ...(pricing === undefined ? {} : { pricing }),
    } satisfies LLMRecoveryBudgetAdmissionInput);
    if (decision.kind === "EXCEEDED" || decision.kind === "UNAVAILABLE") return decision;

    const conservativeUnknown = billing.kind === "UNKNOWN";
    const priorReservedInput = conservativeUnknown ? entry.reservedInputTokens : knownInputTokens;
    const priorReservedOutput = conservativeUnknown
      ? entry.reservedOutputTokens
      : knownOutputTokens;
    const priorReservedCost = conservativeUnknown ? entry.reservedCostMicros : knownCostMicros;
    await this.ledger.updateInFlightLLMReservation(input.run.id, input.step.id, {
      reservedInputTokens: safeAdd(
        priorReservedInput,
        decision.reservedInputTokens,
        "Recovery input reservation",
      ),
      reservedOutputTokens: safeAdd(
        priorReservedOutput,
        decision.reservedOutputTokens,
        "Recovery output reservation",
      ),
      reservedCostMicros: safeAdd(
        priorReservedCost,
        decision.reservedCostMicros,
        "Recovery cost reservation",
      ),
    });
    return {
      kind: "ALLOWED",
      ...(decision.effectiveMaxOutputTokens === undefined
        ? {}
        : { effectiveMaxOutputTokens: decision.effectiveMaxOutputTokens }),
    };
  }
  async admitVerificationLLM(input: {
    readonly run: AgentRun;
    readonly ownerId: string;
    readonly admission: RunLLMBudgetAdmissionInput;
  }): Promise<import("@caelush/core").RunLLMBudgetAdmission> {
    return this.admitLLMForOwner({ ...input, kind: "VERIFICATION_LLM" });
  }
  async admitContextCompactionLLM(input: {
    readonly run: AgentRun;
    readonly ownerId: string;
    readonly admission: RunLLMBudgetAdmissionInput;
  }): Promise<import("@caelush/core").RunLLMBudgetAdmission> {
    const existing = await this.ledger.get(input.run.id, "CONTEXT_COMPACTION", input.ownerId);
    if (
      existing !== null &&
      (existing.state === "IN_FLIGHT" ||
        existing.state === "SETTLED" ||
        existing.state === "CONSERVATIVE" ||
        existing.state === "RELEASED")
    ) {
      return { kind: "UNAVAILABLE", reason: "TOKEN_ESTIMATE" };
    }
    return this.admitLLMForOwner({ ...input, kind: "CONTEXT_COMPACTION" });
  }

  private async admitLLMForOwner(input: {
    readonly run: AgentRun;
    readonly ownerId: string;
    readonly admission: RunLLMBudgetAdmissionInput;
    readonly kind: "LLM_ATTEMPT" | "VERIFICATION_LLM" | "CONTEXT_COMPACTION";
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

  private async classifyRecoveryBilling(
    runId: RunId,
    stepInvocations: readonly ProviderInvocationUsageRecord[],
  ): Promise<RecoveryBillingClassification> {
    if (stepInvocations.length === 0) {
      const runInvocations = await this.providerUsage.listByRun(runId);
      const hasUnattributedMainAgentCall = runInvocations.some(
        (invocation) => invocation.purpose === "MAIN_AGENT" && invocation.stepId === undefined,
      );
      return hasUnattributedMainAgentCall ? { kind: "UNKNOWN" } : { kind: "NOT_CHARGED" };
    }
    if (stepInvocations.length !== 1) return { kind: "UNKNOWN" };
    const invocation = stepInvocations[0]!;
    if (
      invocation.status === "OBSERVED" ||
      invocation.inputTokens === undefined ||
      invocation.outputTokens === undefined
    ) {
      return { kind: "UNKNOWN" };
    }
    return {
      kind: "KNOWN",
      inputTokens: invocation.inputTokens,
      outputTokens: invocation.outputTokens,
    };
  }

  async settleLLM(input: {
    readonly runId: RunId;
    readonly stepId: StepId;
    readonly providerCallId?: string;
    readonly usage?: BudgetModelUsage;
    readonly settledAt: TimestampMs;
  }): Promise<import("@caelush/core").RunBudgetSettlement | void> {
    return this.settleLLMForOwner({ ...input, ownerId: input.stepId, kind: "LLM_ATTEMPT" });
  }

  async settleVerificationLLM(input: {
    readonly runId: RunId;
    readonly ownerId: string;
    readonly providerCallId?: string;
    readonly usage?: BudgetModelUsage;
    readonly settledAt: TimestampMs;
  }): Promise<import("@caelush/core").RunBudgetSettlement | void> {
    return this.settleLLMForOwner({ ...input, kind: "VERIFICATION_LLM" });
  }
  async settleContextCompactionLLM(input: {
    readonly runId: RunId;
    readonly ownerId: string;
    readonly providerCallId?: string;
    readonly usage?: BudgetModelUsage;
    readonly settledAt: TimestampMs;
  }): Promise<import("@caelush/core").RunBudgetSettlement | void> {
    return this.settleLLMForOwner({ ...input, kind: "CONTEXT_COMPACTION" });
  }

  private async settleLLMForOwner(input: {
    readonly runId: RunId;
    readonly ownerId: string;
    readonly usage?: BudgetModelUsage;
    readonly providerCallId?: string;
    readonly settledAt: TimestampMs;
    readonly kind: "LLM_ATTEMPT" | "VERIFICATION_LLM" | "CONTEXT_COMPACTION";
  }): Promise<import("@caelush/core").RunBudgetSettlement | void> {
    const entry = await this.ledger.get(input.runId, input.kind, input.ownerId);
    if (entry === null || entry.state === "SETTLED" || entry.state === "CONSERVATIVE") {
      return this.checkPostSettlementBudget(input.runId);
    }
    let usage = input.usage;
    let providerCallId = input.providerCallId;
    if (input.kind === "LLM_ATTEMPT") {
      const invocations = await this.providerUsage.listByRunStep(
        input.runId,
        input.ownerId as StepId,
      );
      if (invocations.length > 0) {
        usage = aggregateKnownInvocationUsage(invocations);
        providerCallId = invocations.length === 1 ? invocations[0]?.callId : undefined;
      }
    }
    const normalized = normalizeLLMUsageForBudget(usage, {
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
      ...(normalized.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: normalized.cachedInputTokens }),
      ...(normalized.cacheMissInputTokens === undefined
        ? {}
        : { cacheMissInputTokens: normalized.cacheMissInputTokens }),
      ...(normalized.cacheWriteInputTokens === undefined
        ? {}
        : { cacheWriteInputTokens: normalized.cacheWriteInputTokens }),
      ...(normalized.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: normalized.reasoningTokens }),
      ...(providerCallId === undefined ? {} : { providerCallId }),
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
  async markContextCompactionLLMConservative(input: {
    readonly runId: RunId;
    readonly ownerId: string;
    readonly settledAt: TimestampMs;
  }): Promise<void> {
    await this.markLLMConservativeForOwner({ ...input, kind: "CONTEXT_COMPACTION" });
  }

  private async markLLMConservativeForOwner(input: {
    readonly runId: RunId;
    readonly ownerId: string;
    readonly settledAt: TimestampMs;
    readonly kind: "LLM_ATTEMPT" | "VERIFICATION_LLM" | "CONTEXT_COMPACTION";
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

type RecoveryBillingClassification =
  | { readonly kind: "NOT_CHARGED" }
  | { readonly kind: "KNOWN"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: "UNKNOWN" };

function pricingFromReservation(
  entry: Awaited<ReturnType<SqliteBudgetLedgerRepository["get"]>>,
): ModelPricingSnapshot | undefined {
  if (
    entry?.pricingSnapshotId === undefined ||
    entry.inputRateMicrosPerMillion === undefined ||
    entry.outputRateMicrosPerMillion === undefined
  ) {
    return undefined;
  }
  return {
    id: entry.pricingSnapshotId,
    currency: "USD",
    inputMicrosPerMillionTokens: entry.inputRateMicrosPerMillion,
    outputMicrosPerMillionTokens: entry.outputRateMicrosPerMillion,
  };
}

function safeAdd(left: number, right: number, label: string): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new RangeError(`${label} is outside the safe integer range.`);
  }
  return left + right;
}

function subtractReserved(total: number, owned: number): number {
  if (owned > total) throw new Error("The Step reservation is missing from the Run snapshot.");
  return total - owned;
}

function aggregateKnownInvocationUsage(
  invocations: readonly ProviderInvocationUsageRecord[],
): BudgetModelUsage | undefined {
  if (
    invocations.some(
      (invocation) =>
        invocation.status === "OBSERVED" ||
        invocation.inputTokens === undefined ||
        invocation.outputTokens === undefined,
    )
  ) {
    return undefined;
  }
  try {
    const inputTokens = invocations.reduce(
      (sum, invocation) => safeAdd(sum, invocation.inputTokens!, "Provider input usage"),
      0,
    );
    const outputTokens = invocations.reduce(
      (sum, invocation) => safeAdd(sum, invocation.outputTokens!, "Provider output usage"),
      0,
    );
    const totalTokens = safeAdd(inputTokens, outputTokens, "Provider total usage");
    const aggregateOptional = (
      key:
        | "cacheHitInputTokens"
        | "cacheMissInputTokens"
        | "cacheWriteInputTokens"
        | "reasoningTokens",
    ): number | undefined => {
      if (invocations.some((invocation) => invocation[key] === undefined)) return undefined;
      return invocations.reduce(
        (sum, invocation) => safeAdd(sum, invocation[key]!, `Provider ${key}`),
        0,
      );
    };
    const cachedInputTokens = aggregateOptional("cacheHitInputTokens");
    const cacheMissInputTokens = aggregateOptional("cacheMissInputTokens");
    const cacheWriteInputTokens = aggregateOptional("cacheWriteInputTokens");
    const reasoningTokens = aggregateOptional("reasoningTokens");
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(cacheMissInputTokens === undefined ? {} : { cacheMissInputTokens }),
      ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    };
  } catch {
    return undefined;
  }
}

/**
 * The canonical Tool budget admission view over the durable ledger.
 *
 * ```text
 * preflight(runId, requests)                  may this whole segment fit?  no write
 * admit({ runId, invocationId, toolName })    may this one invocation run? reserves one Tool call
 * start({ runId, invocationId, startedAt })   idempotent after the atomic RUNNING commit
 * settle({ runId, invocationId, status, ...}) idempotent after the atomic terminal commit
 * ```
 *
 * It is a separate factory rather than a method on {@link SqliteRunBudgetPort} because the two Tool
 * budget vocabularies genuinely differ: the legacy one takes a `requested` count and answers
 * `ALLOWED | EXCEEDED`, and the canonical one names the Tool and answers `AgentBudgetBlock | null`.
 * One ledger, one implementation of each transition, two entry points — never two accountings.
 *
 * `startedAt` and `finishedAt` are accepted and deliberately not used as ledger timestamps on this
 * path: the production store has already moved the matching entry inside the `RUNNING` and terminal
 * commits, so this call is a no-op restatement of a fact that is durable. A host that commits without
 * an atomic budget transition still gets the invocation's own timestamps honoured by its own store.
 */
export function createSqliteToolBudgetAdmission(
  budget: SqliteRunBudgetPort,
): ToolBudgetAdmissionPort {
  return {
    preflight: async (runId, requests) => await budget.preflight(runId, requests),
    admit: async (input) => await budget.admitToolInvocation(input),
    start: async (input) => {
      await budget.start({ runId: input.runId, invocationId: input.invocationId });
    },
    settle: async (input) => {
      await budget.settle({ runId: input.runId, invocationId: input.invocationId });
    },
  };
}
