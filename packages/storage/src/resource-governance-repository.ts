import {
  RunIdSchema,
  TimestampMsSchema,
  type RunId,
  type RunResourcePolicy,
  type TimestampMs,
} from "@caelush/protocol";
import type { CaelushDatabase } from "./database.js";
import { StorageConflictError, StorageDecodeError, StorageError } from "./errors.js";

export interface ResourceGovernanceState {
  readonly runId: RunId;
  readonly policyVersion: string;
  readonly mode: "ADAPTIVE" | "LEGACY_FIXED";
  readonly leaseEpoch: number;
  readonly leaseStartAgentTurns: number;
  readonly leaseStartToolCalls: number;
  readonly agentTurnsConsumed: number;
  readonly toolOperationsConsumed: number;
  readonly lastProgressAt?: TimestampMs;
  readonly consecutiveNoProgressTurns: number;
  readonly replanCount: number;
  readonly resourceGuardState: "NONE" | "NUDGE" | "REPLAN_REQUIRED" | "WAITING_RESOURCE";
  readonly recentFingerprints: readonly ResourceFingerprint[];
  readonly revision: number;
  readonly createdAt: TimestampMs;
  readonly updatedAt: TimestampMs;
}

export interface ResourceFingerprint {
  readonly request: string;
  readonly result: string;
}

export const ResourceGovernanceStateSchema = {
  parse(value: unknown): ResourceGovernanceState {
    if (!isRecord(value)) throw new TypeError("resource governance state must be an object");
    const state: ResourceGovernanceState = {
      runId: RunIdSchema.parse(value.runId),
      policyVersion: boundedString(value.policyVersion, "policyVersion", 32),
      mode: enumValue(value.mode, ["ADAPTIVE", "LEGACY_FIXED"]),
      leaseEpoch: positiveInteger(value.leaseEpoch, "leaseEpoch"),
      leaseStartAgentTurns: nonNegativeInteger(value.leaseStartAgentTurns, "leaseStartAgentTurns"),
      leaseStartToolCalls: nonNegativeInteger(value.leaseStartToolCalls, "leaseStartToolCalls"),
      agentTurnsConsumed: nonNegativeInteger(value.agentTurnsConsumed, "agentTurnsConsumed"),
      toolOperationsConsumed: nonNegativeInteger(
        value.toolOperationsConsumed,
        "toolOperationsConsumed",
      ),
      ...(value.lastProgressAt === undefined
        ? {}
        : { lastProgressAt: TimestampMsSchema.parse(value.lastProgressAt) }),
      consecutiveNoProgressTurns: nonNegativeInteger(
        value.consecutiveNoProgressTurns,
        "consecutiveNoProgressTurns",
      ),
      replanCount: nonNegativeInteger(value.replanCount, "replanCount"),
      resourceGuardState: enumValue(value.resourceGuardState, [
        "NONE",
        "NUDGE",
        "REPLAN_REQUIRED",
        "WAITING_RESOURCE",
      ]),
      recentFingerprints: fingerprints(value.recentFingerprints),
      revision: nonNegativeInteger(value.revision, "revision"),
      createdAt: TimestampMsSchema.parse(value.createdAt),
      updatedAt: TimestampMsSchema.parse(value.updatedAt),
    };
    if (Object.keys(value).some((key) => !stateKeys.has(key))) {
      throw new TypeError("resource governance state contains an unknown field");
    }
    return state;
  },
};

export class ResourceGovernanceConflictError extends StorageConflictError {
  constructor(runId: RunId) {
    super(`Resource governance state for Run ${runId} is stale.`);
    this.name = "ResourceGovernanceConflictError";
  }
}

export interface ResourceGovernanceRepository {
  get(runId: RunId): Promise<ResourceGovernanceState | null>;
  createOrGet(
    runId: RunId,
    input: {
      readonly policyVersion: string;
      readonly mode: RunResourcePolicy["mode"];
      readonly now: TimestampMs;
    },
  ): Promise<ResourceGovernanceState>;
  compareAndSwap(
    runId: RunId,
    expectedRevision: number,
    next: ResourceGovernanceState,
  ): Promise<ResourceGovernanceState>;
}

interface ResourceRow {
  run_id: string;
  policy_version: string;
  mode: string;
  lease_epoch: number;
  lease_start_agent_turns: number;
  lease_start_tool_calls: number;
  agent_turns_consumed: number;
  tool_operations_consumed: number;
  last_progress_at_ms: number | null;
  consecutive_no_progress_turns: number;
  replan_count: number;
  resource_guard_state: string;
  revision: number;
  recent_fingerprints_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export class SqliteResourceGovernanceRepository implements ResourceGovernanceRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async get(runId: RunId): Promise<ResourceGovernanceState | null> {
    const row = this.database.client
      .prepare("SELECT * FROM run_resource_states WHERE run_id = ?")
      .get(runId) as ResourceRow | undefined;
    return row === undefined ? null : decodeRow(row);
  }

  async createOrGet(
    runId: RunId,
    input: {
      readonly policyVersion: string;
      readonly mode: RunResourcePolicy["mode"];
      readonly now: TimestampMs;
    },
  ): Promise<ResourceGovernanceState> {
    const existing = await this.get(runId);
    if (existing !== null) return existing;
    const state = ResourceGovernanceStateSchema.parse({
      runId,
      policyVersion: input.policyVersion,
      mode: input.mode,
      leaseEpoch: 1,
      leaseStartAgentTurns: 0,
      leaseStartToolCalls: 0,
      agentTurnsConsumed: 0,
      toolOperationsConsumed: 0,
      consecutiveNoProgressTurns: 0,
      replanCount: 0,
      resourceGuardState: "NONE",
      recentFingerprints: [],
      revision: 0,
      createdAt: input.now,
      updatedAt: input.now,
    });
    try {
      this.database.client
        .prepare(
          `INSERT INTO run_resource_states
            (run_id, policy_version, mode, lease_epoch, lease_start_agent_turns,
             lease_start_tool_calls, agent_turns_consumed, tool_operations_consumed,
             last_progress_at_ms, consecutive_no_progress_turns, replan_count,
             resource_guard_state, revision, recent_fingerprints_json, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          state.runId,
          state.policyVersion,
          state.mode,
          state.leaseEpoch,
          state.leaseStartAgentTurns,
          state.leaseStartToolCalls,
          state.agentTurnsConsumed,
          state.toolOperationsConsumed,
          null,
          state.consecutiveNoProgressTurns,
          state.replanCount,
          state.resourceGuardState,
          state.revision,
          JSON.stringify(state.recentFingerprints),
          state.createdAt,
          state.updatedAt,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE") || String(error).includes("PRIMARY KEY")) {
        const raced = await this.get(runId);
        if (raced !== null) return raced;
      }
      throw new StorageError("Unable to create resource governance state.", { cause: error });
    }
    return state;
  }

  async compareAndSwap(
    runId: RunId,
    expectedRevision: number,
    next: ResourceGovernanceState,
  ): Promise<ResourceGovernanceState> {
    const parsed = ResourceGovernanceStateSchema.parse(next);
    if (parsed.runId !== runId || parsed.revision !== expectedRevision + 1) {
      throw new ResourceGovernanceConflictError(runId);
    }
    const result = this.database.client
      .prepare(
        `UPDATE run_resource_states SET policy_version = ?, mode = ?, lease_epoch = ?,
          lease_start_agent_turns = ?, lease_start_tool_calls = ?, agent_turns_consumed = ?,
          tool_operations_consumed = ?, last_progress_at_ms = ?, consecutive_no_progress_turns = ?,
          replan_count = ?, resource_guard_state = ?, revision = ?, recent_fingerprints_json = ?,
          created_at_ms = ?, updated_at_ms = ? WHERE run_id = ? AND revision = ?`,
      )
      .run(
        parsed.policyVersion,
        parsed.mode,
        parsed.leaseEpoch,
        parsed.leaseStartAgentTurns,
        parsed.leaseStartToolCalls,
        parsed.agentTurnsConsumed,
        parsed.toolOperationsConsumed,
        parsed.lastProgressAt ?? null,
        parsed.consecutiveNoProgressTurns,
        parsed.replanCount,
        parsed.resourceGuardState,
        parsed.revision,
        JSON.stringify(parsed.recentFingerprints),
        parsed.createdAt,
        parsed.updatedAt,
        runId,
        expectedRevision,
      );
    if (result.changes !== 1) throw new ResourceGovernanceConflictError(runId);
    return parsed;
  }
}

function decodeRow(row: ResourceRow): ResourceGovernanceState {
  let recentFingerprints: unknown;
  try {
    recentFingerprints = JSON.parse(row.recent_fingerprints_json);
  } catch (error) {
    throw new StorageDecodeError("ResourceGovernanceState", row.run_id, "run_resource_states", {
      cause: error,
    });
  }
  try {
    return ResourceGovernanceStateSchema.parse({
      runId: row.run_id,
      policyVersion: row.policy_version,
      mode: row.mode,
      leaseEpoch: row.lease_epoch,
      leaseStartAgentTurns: row.lease_start_agent_turns,
      leaseStartToolCalls: row.lease_start_tool_calls,
      agentTurnsConsumed: row.agent_turns_consumed,
      toolOperationsConsumed: row.tool_operations_consumed,
      ...(row.last_progress_at_ms === null ? {} : { lastProgressAt: row.last_progress_at_ms }),
      consecutiveNoProgressTurns: row.consecutive_no_progress_turns,
      replanCount: row.replan_count,
      resourceGuardState: row.resource_guard_state,
      recentFingerprints,
      revision: row.revision,
      createdAt: row.created_at_ms,
      updatedAt: row.updated_at_ms,
    });
  } catch (error) {
    throw new StorageDecodeError("ResourceGovernanceState", row.run_id, "run_resource_states", {
      cause: error,
    });
  }
}

const stateKeys = new Set([
  "runId",
  "policyVersion",
  "mode",
  "leaseEpoch",
  "leaseStartAgentTurns",
  "leaseStartToolCalls",
  "agentTurnsConsumed",
  "toolOperationsConsumed",
  "lastProgressAt",
  "consecutiveNoProgressTurns",
  "replanCount",
  "resourceGuardState",
  "recentFingerprints",
  "revision",
  "createdAt",
  "updatedAt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new TypeError(`${label} is invalid`);
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${label} is invalid`);
  return value as number;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new TypeError("enum value is invalid");
  return value as T;
}

function fingerprints(value: unknown): readonly ResourceFingerprint[] {
  if (!Array.isArray(value) || value.length > 64) throw new TypeError("fingerprints are invalid");
  return value.map((entry) => {
    if (!isRecord(entry)) throw new TypeError("fingerprint is invalid");
    return {
      request: boundedString(entry.request, "fingerprint request", 128),
      result: boundedString(entry.result, "fingerprint result", 128),
    };
  });
}
