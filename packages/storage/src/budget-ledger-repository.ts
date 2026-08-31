import type { RunId, TimestampMs } from "@caelush/protocol";
import type { CaelushDatabase } from "./database.js";
import { StorageConflictError, StorageError } from "./errors.js";

export type BudgetEntryKind = "LLM_ATTEMPT" | "TOOL_INVOCATION";
export type BudgetEntryState = "RESERVED" | "IN_FLIGHT" | "SETTLED" | "CONSERVATIVE" | "RELEASED";

export interface BudgetLedgerEntry {
  readonly id: string;
  readonly runId: RunId;
  readonly kind: BudgetEntryKind;
  readonly ownerId: string;
  readonly state: BudgetEntryState;
  readonly reservedToolCalls: number;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly actualInputTokens?: number;
  readonly actualOutputTokens?: number;
  readonly reservedCostMicros: number;
  readonly actualCostMicros?: number;
  readonly modelProvider?: string;
  readonly modelId?: string;
  readonly pricingSnapshotId?: string;
  readonly inputRateMicrosPerMillion?: number;
  readonly outputRateMicrosPerMillion?: number;
  readonly createdAt: TimestampMs;
  readonly startedAt?: TimestampMs;
  readonly settledAt?: TimestampMs;
}

export type NewBudgetLedgerEntry = Omit<
  BudgetLedgerEntry,
  | "state"
  | "reservedToolCalls"
  | "reservedInputTokens"
  | "reservedOutputTokens"
  | "reservedCostMicros"
  | "actualInputTokens"
  | "actualOutputTokens"
  | "actualCostMicros"
  | "startedAt"
  | "settledAt"
> & {
  readonly reservedToolCalls?: number;
  readonly reservedInputTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly reservedCostMicros?: number;
};

export interface BudgetLedgerSnapshot {
  readonly toolCallsConsumed: number;
  readonly toolCallsReserved: number;
  readonly inputTokensConsumed: number;
  readonly inputTokensReserved: number;
  readonly outputTokensConsumed: number;
  readonly outputTokensReserved: number;
  readonly tokensConsumed: number;
  readonly tokensReserved: number;
  readonly costMicrosConsumed: number;
  readonly costMicrosReserved: number;
}

interface BudgetRow {
  id: string;
  run_id: string;
  kind: string;
  owner_id: string;
  state: string;
  reserved_tool_calls: number;
  reserved_input_tokens: number;
  reserved_output_tokens: number;
  actual_input_tokens: number | null;
  actual_output_tokens: number | null;
  reserved_cost_micros: number;
  actual_cost_micros: number | null;
  model_provider: string | null;
  model_id: string | null;
  pricing_snapshot_id: string | null;
  input_rate_micros_per_million: number | null;
  output_rate_micros_per_million: number | null;
  created_at_ms: number;
  started_at_ms: number | null;
  settled_at_ms: number | null;
}

export class BudgetLedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetLedgerInvariantError";
  }
}

export class SqliteBudgetLedgerRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async get(
    runId: RunId,
    kind: BudgetEntryKind,
    ownerId: string,
  ): Promise<BudgetLedgerEntry | null> {
    const row = this.database.client
      .prepare("SELECT * FROM run_budget_entries WHERE run_id = ? AND kind = ? AND owner_id = ?")
      .get(runId, kind, ownerId) as BudgetRow | undefined;
    return row === undefined ? null : decode(row);
  }

  async reserve(input: NewBudgetLedgerEntry | BudgetLedgerEntry): Promise<BudgetLedgerEntry> {
    const existing = await this.get(input.runId, input.kind, input.ownerId);
    if (existing !== null) {
      if (!sameReservation(existing, input)) {
        throw new StorageConflictError("Budget reservation owner already has different amounts.");
      }
      return existing;
    }
    try {
      this.database.client
        .prepare(
          `INSERT INTO run_budget_entries
           (id, run_id, kind, owner_id, state, reserved_tool_calls, reserved_input_tokens,
            reserved_output_tokens, actual_input_tokens, actual_output_tokens, reserved_cost_micros,
            actual_cost_micros, model_provider, model_id, pricing_snapshot_id,
            input_rate_micros_per_million, output_rate_micros_per_million, created_at_ms,
            started_at_ms, settled_at_ms)
           VALUES (?, ?, ?, ?, 'RESERVED', ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          input.id,
          input.runId,
          input.kind,
          input.ownerId,
          input.reservedToolCalls ?? 0,
          input.reservedInputTokens ?? 0,
          input.reservedOutputTokens ?? 0,
          input.reservedCostMicros ?? 0,
          input.modelProvider ?? null,
          input.modelId ?? null,
          input.pricingSnapshotId ?? null,
          input.inputRateMicrosPerMillion ?? null,
          input.outputRateMicrosPerMillion ?? null,
          input.createdAt,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        throw new StorageConflictError("Budget reservation conflicts.", { cause: error });
      throw new StorageError("Unable to persist budget reservation.", { cause: error });
    }
    return (await this.get(input.runId, input.kind, input.ownerId))!;
  }

  async markInFlight(
    runId: RunId,
    kind: BudgetEntryKind,
    ownerId: string,
    startedAt: TimestampMs,
  ): Promise<void> {
    this.transition(runId, kind, ownerId, "RESERVED", "IN_FLIGHT", startedAt, undefined);
  }

  async settle(
    runId: RunId,
    kind: BudgetEntryKind,
    ownerId: string,
    input: {
      readonly actualInputTokens: number;
      readonly actualOutputTokens: number;
      readonly actualCostMicros: number;
      readonly settledAt: TimestampMs;
    },
  ): Promise<void> {
    const result = this.database.client
      .prepare(
        `UPDATE run_budget_entries SET state = 'SETTLED', actual_input_tokens = ?, actual_output_tokens = ?,
         actual_cost_micros = ?, settled_at_ms = ? WHERE run_id = ? AND kind = ? AND owner_id = ? AND state = 'IN_FLIGHT'`,
      )
      .run(
        input.actualInputTokens,
        input.actualOutputTokens,
        input.actualCostMicros,
        input.settledAt,
        runId,
        kind,
        ownerId,
      );
    if (result.changes !== 1)
      throw new BudgetLedgerInvariantError("Only an IN_FLIGHT budget entry can settle.");
  }

  async markConservative(
    runId: RunId,
    kind: BudgetEntryKind,
    ownerId: string,
    settledAt?: TimestampMs,
  ): Promise<void> {
    this.transition(runId, kind, ownerId, "IN_FLIGHT", "CONSERVATIVE", undefined, settledAt);
  }

  async release(runId: RunId, kind: BudgetEntryKind, ownerId: string): Promise<void> {
    this.transition(runId, kind, ownerId, "RESERVED", "RELEASED", undefined, undefined);
  }

  async recoverInFlight(runId: RunId, settledAt?: TimestampMs): Promise<void> {
    this.database.client
      .prepare(
        "UPDATE run_budget_entries SET state = 'CONSERVATIVE', settled_at_ms = ? WHERE run_id = ? AND state = 'IN_FLIGHT'",
      )
      .run(settledAt ?? null, runId);
  }

  async snapshot(runId: RunId): Promise<BudgetLedgerSnapshot> {
    const rows = this.database.client
      .prepare("SELECT * FROM run_budget_entries WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as unknown as BudgetRow[];
    const total = {
      toolCallsConsumed: 0,
      toolCallsReserved: 0,
      inputTokensConsumed: 0,
      inputTokensReserved: 0,
      outputTokensConsumed: 0,
      outputTokensReserved: 0,
      tokensConsumed: 0,
      tokensReserved: 0,
      costMicrosConsumed: 0,
      costMicrosReserved: 0,
    };
    for (const row of rows) {
      const entry = decode(row);
      const pending = entry.state === "RESERVED" || entry.state === "IN_FLIGHT";
      if (pending) {
        total.toolCallsReserved += entry.reservedToolCalls;
        total.inputTokensReserved += entry.reservedInputTokens;
        total.outputTokensReserved += entry.reservedOutputTokens;
        total.tokensReserved += entry.reservedInputTokens + entry.reservedOutputTokens;
        total.costMicrosReserved += entry.reservedCostMicros;
      } else if (entry.state === "SETTLED" || entry.state === "CONSERVATIVE") {
        total.toolCallsConsumed += entry.reservedToolCalls;
        total.inputTokensConsumed +=
          entry.state === "SETTLED" ? entry.actualInputTokens! : entry.reservedInputTokens;
        total.outputTokensConsumed +=
          entry.state === "SETTLED" ? entry.actualOutputTokens! : entry.reservedOutputTokens;
        total.tokensConsumed +=
          entry.state === "SETTLED"
            ? entry.actualInputTokens! + entry.actualOutputTokens!
            : entry.reservedInputTokens + entry.reservedOutputTokens;
        total.costMicrosConsumed +=
          entry.state === "SETTLED" ? entry.actualCostMicros! : entry.reservedCostMicros;
      }
    }
    return total;
  }

  private transition(
    runId: RunId,
    kind: BudgetEntryKind,
    ownerId: string,
    from: BudgetEntryState,
    to: BudgetEntryState,
    startedAt: TimestampMs | undefined,
    settledAt: TimestampMs | undefined,
  ): void {
    const result = this.database.client
      .prepare(
        `UPDATE run_budget_entries SET state = ?, started_at_ms = COALESCE(?, started_at_ms), settled_at_ms = COALESCE(?, settled_at_ms) WHERE run_id = ? AND kind = ? AND owner_id = ? AND state = ?`,
      )
      .run(to, startedAt ?? null, settledAt ?? null, runId, kind, ownerId, from);
    if (result.changes !== 1)
      throw new BudgetLedgerInvariantError(`Budget entry must be ${from} before ${to}.`);
  }
}

function sameReservation(
  existing: BudgetLedgerEntry,
  input: NewBudgetLedgerEntry | BudgetLedgerEntry,
): boolean {
  return (
    existing.id === input.id &&
    existing.reservedToolCalls === (input.reservedToolCalls ?? 0) &&
    existing.reservedInputTokens === (input.reservedInputTokens ?? 0) &&
    existing.reservedOutputTokens === (input.reservedOutputTokens ?? 0) &&
    existing.reservedCostMicros === (input.reservedCostMicros ?? 0)
  );
}

function decode(row: BudgetRow): BudgetLedgerEntry {
  if (!isKind(row.kind) || !isState(row.state))
    throw new BudgetLedgerInvariantError("Budget ledger row has an invalid lifecycle value.");
  return {
    id: row.id,
    runId: row.run_id as RunId,
    kind: row.kind,
    ownerId: row.owner_id,
    state: row.state,
    reservedToolCalls: row.reserved_tool_calls,
    reservedInputTokens: row.reserved_input_tokens,
    reservedOutputTokens: row.reserved_output_tokens,
    ...(row.actual_input_tokens === null ? {} : { actualInputTokens: row.actual_input_tokens }),
    ...(row.actual_output_tokens === null ? {} : { actualOutputTokens: row.actual_output_tokens }),
    reservedCostMicros: row.reserved_cost_micros,
    ...(row.actual_cost_micros === null ? {} : { actualCostMicros: row.actual_cost_micros }),
    ...(row.model_provider === null ? {} : { modelProvider: row.model_provider }),
    ...(row.model_id === null ? {} : { modelId: row.model_id }),
    ...(row.pricing_snapshot_id === null ? {} : { pricingSnapshotId: row.pricing_snapshot_id }),
    ...(row.input_rate_micros_per_million === null
      ? {}
      : { inputRateMicrosPerMillion: row.input_rate_micros_per_million }),
    ...(row.output_rate_micros_per_million === null
      ? {}
      : { outputRateMicrosPerMillion: row.output_rate_micros_per_million }),
    createdAt: row.created_at_ms as TimestampMs,
    ...(row.started_at_ms === null ? {} : { startedAt: row.started_at_ms as TimestampMs }),
    ...(row.settled_at_ms === null ? {} : { settledAt: row.settled_at_ms as TimestampMs }),
  };
}

function isKind(value: string): value is BudgetEntryKind {
  return value === "LLM_ATTEMPT" || value === "TOOL_INVOCATION";
}
function isState(value: string): value is BudgetEntryState {
  return ["RESERVED", "IN_FLIGHT", "SETTLED", "CONSERVATIVE", "RELEASED"].includes(value);
}
