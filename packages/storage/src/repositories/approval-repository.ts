import {
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  createEventId,
  type ApprovalRequest,
  type ApprovalRequestId,
  type ApprovalResolution,
  type RunId,
  type SessionId,
  type StepId,
  type TimestampMs,
  type ToolInvocationId,
} from "@caelush/protocol";
import {
  createApprovalResolvedEvent,
  type ToolApprovalStorePort,
  type DurableToolEventDraft,
  ToolExecutionConflictError,
} from "@caelush/tools";
import { appendDurableEventsInTransaction } from "../events/sqlite-durable-event-store.js";
import { decodeProtocol, encodeProtocol } from "../codec.js";
import type { CaelushDatabase } from "../database.js";
import { StorageConflictError, StorageDecodeError, StorageError } from "../errors.js";

export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

export interface ApprovalClock {
  now(): TimestampMs;
}

export interface ApprovalEventIdFactory {
  create(): import("@caelush/protocol").EventId;
}

export interface ApprovalRepository extends ToolApprovalStorePort {
  getById(id: ApprovalRequestId): Promise<ApprovalRequest | null>;
  listPendingByRun(runId: RunId): Promise<readonly ApprovalRequest[]>;
  resolve(id: ApprovalRequestId, resolution: ApprovalResolution): Promise<ApprovalRequest>;
  cancelPendingByRun(runId: RunId): Promise<readonly ApprovalRequest[]>;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  tool_invocation_id: string;
  approval_key: string;
  status: string;
  scope: string;
  granted_scope: string | null;
  risk_level: string;
  protocol_version: number;
  created_at_ms: number;
  expires_at_ms: number | null;
  resolved_at_ms: number | null;
  data_json: string;
}

function optionalMatch(value: number | undefined, stored: number | null): boolean {
  return value === undefined ? stored === null : value === stored;
}

export function decodeApprovalRow(row: ApprovalRow): ApprovalRequest {
  const approval = decodeProtocol(ApprovalRequestSchema, row.data_json, {
    entityType: "ApprovalRequest",
    entityId: row.id,
    table: "approval_requests",
  });
  if (
    approval.id !== row.id ||
    approval.runId !== row.run_id ||
    approval.toolInvocationId !== row.tool_invocation_id ||
    approval.status !== row.status ||
    approval.scope !== row.scope ||
    (approval.grantedScope ?? null) !== row.granted_scope ||
    approval.riskLevel !== row.risk_level ||
    approval.createdAt !== row.created_at_ms ||
    !optionalMatch(approval.expiresAt, row.expires_at_ms) ||
    !optionalMatch(approval.resolvedAt, row.resolved_at_ms) ||
    row.protocol_version !== 1
  ) {
    throw new StorageDecodeError("ApprovalRequest", row.id, "approval_requests");
  }
  return approval;
}

function selectRow(
  client: CaelushDatabase["client"],
  query: string,
  ...params: Array<string | number>
): ApprovalRow | undefined {
  return client.prepare(query).get(...params) as ApprovalRow | undefined;
}

function selectById(client: CaelushDatabase["client"], id: string): ApprovalRow | undefined {
  return selectRow(
    client,
    `SELECT id, run_id, tool_invocation_id, approval_key, status, scope, granted_scope,
            risk_level, protocol_version, created_at_ms, expires_at_ms, resolved_at_ms, data_json
     FROM approval_requests WHERE id = ?`,
    id,
  );
}

export function writeApprovalInTransaction(
  client: CaelushDatabase["client"],
  approval: ApprovalRequest,
  approvalKey: string,
): void {
  const parsed = ApprovalRequestSchema.parse(approval);
  const dataJson = encodeProtocol(ApprovalRequestSchema, parsed, {
    entityType: "ApprovalRequest",
    entityId: parsed.id,
    table: "approval_requests",
  });
  client
    .prepare(
      `INSERT INTO approval_requests
       (id, run_id, tool_invocation_id, approval_key, status, scope, granted_scope, risk_level,
        protocol_version, created_at_ms, expires_at_ms, resolved_at_ms, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tool_invocation_id) DO UPDATE SET
         id = id`,
    )
    .run(
      parsed.id,
      parsed.runId,
      parsed.toolInvocationId,
      approvalKey,
      parsed.status,
      parsed.scope,
      parsed.grantedScope ?? null,
      parsed.riskLevel,
      1,
      parsed.createdAt,
      parsed.expiresAt ?? null,
      parsed.resolvedAt ?? null,
      dataJson,
    );
  const row = selectById(client, parsed.id);
  if (row !== undefined) {
    if (row.approval_key === approvalKey && row.data_json === dataJson) return;
    throw new ToolExecutionConflictError("ApprovalRequest identity conflicts with durable data.");
  }
  const existing = selectRow(
    client,
    `SELECT id, run_id, tool_invocation_id, approval_key, status, scope, granted_scope,
            risk_level, protocol_version, created_at_ms, expires_at_ms, resolved_at_ms, data_json
     FROM approval_requests WHERE tool_invocation_id = ?`,
    parsed.toolInvocationId,
  );
  if (existing?.approval_key === approvalKey && existing.id === parsed.id) return;
  if (existing !== undefined) {
    throw new ToolExecutionConflictError(
      "Tool invocation already has a different ApprovalRequest.",
    );
  }
  throw new StorageError("ApprovalRequest was not available after atomic creation.");
}

function loadApprovalWithKey(
  client: CaelushDatabase["client"],
  id: string,
): { approval: ApprovalRequest; approvalKey: string } | undefined {
  const row = selectById(client, id);
  return row === undefined
    ? undefined
    : { approval: decodeApprovalRow(row), approvalKey: row.approval_key };
}

export class SqliteApprovalRepository implements ApprovalRepository {
  private readonly clock: ApprovalClock;
  private readonly eventIdFactory: ApprovalEventIdFactory;

  constructor(
    private readonly database: CaelushDatabase,
    options: {
      readonly clock?: ApprovalClock;
      readonly eventIdFactory?: ApprovalEventIdFactory;
    } = {},
  ) {
    this.clock = options.clock ?? { now: () => Date.now() as TimestampMs };
    this.eventIdFactory = options.eventIdFactory ?? { create: () => createEventId() };
  }

  async getById(id: ApprovalRequestId): Promise<ApprovalRequest | null> {
    return this.loadAndExpire(id);
  }

  async getByInvocation(toolInvocationId: ToolInvocationId): Promise<ApprovalRequest | null> {
    const row = this.database.client
      .prepare(
        `SELECT id, run_id, tool_invocation_id, approval_key, status, scope, granted_scope,
                risk_level, protocol_version, created_at_ms, expires_at_ms, resolved_at_ms, data_json
         FROM approval_requests WHERE tool_invocation_id = ?`,
      )
      .get(toolInvocationId) as ApprovalRow | undefined;
    if (row === undefined) return null;
    return this.loadAndExpire(row.id as ApprovalRequestId);
  }

  async getApprovalKeyByInvocation(toolInvocationId: ToolInvocationId): Promise<string | null> {
    const row = selectRow(
      this.database.client,
      `SELECT id, run_id, tool_invocation_id, approval_key, status, scope, granted_scope,
              risk_level, protocol_version, created_at_ms, expires_at_ms, resolved_at_ms, data_json
       FROM approval_requests WHERE tool_invocation_id = ?`,
      toolInvocationId,
    );
    return row?.approval_key ?? null;
  }

  async listPendingByRun(runId: RunId): Promise<readonly ApprovalRequest[]> {
    const rows = this.database.client
      .prepare(
        `SELECT id, run_id, tool_invocation_id, approval_key, status, scope, granted_scope,
                risk_level, protocol_version, created_at_ms, expires_at_ms, resolved_at_ms, data_json
         FROM approval_requests WHERE run_id = ? AND status = 'PENDING'
         ORDER BY created_at_ms ASC, id ASC`,
      )
      .all(runId) as unknown as ApprovalRow[];
    const approvals: ApprovalRequest[] = [];
    for (const row of rows) {
      const approval = await this.loadAndExpire(row.id as ApprovalRequestId);
      if (approval?.status === "PENDING") approvals.push(approval);
    }
    return approvals;
  }

  async findApplicableRunGrant(input: {
    readonly runId: RunId;
    readonly approvalKey: string;
  }): Promise<ApprovalRequest | null> {
    const rows = this.database.client
      .prepare(
        `SELECT id, run_id, tool_invocation_id, approval_key, status, scope, granted_scope,
                risk_level, protocol_version, created_at_ms, expires_at_ms, resolved_at_ms, data_json
         FROM approval_requests
         WHERE run_id = ? AND approval_key = ? AND status = 'APPROVED' AND granted_scope = 'RUN'
         ORDER BY resolved_at_ms DESC, id DESC LIMIT 1`,
      )
      .all(input.runId, input.approvalKey) as unknown as ApprovalRow[];
    return rows[0] === undefined ? null : decodeApprovalRow(rows[0]);
  }

  async resolve(id: ApprovalRequestId, resolution: ApprovalResolution): Promise<ApprovalRequest> {
    const parsedResolution = ApprovalResolutionSchema.parse(resolution);
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      const loaded = loadApprovalWithKey(client, id);
      if (loaded === undefined) throw new StorageError(`ApprovalRequest ${id} was not found.`);
      const current = loaded.approval;
      const now = this.clock.now();
      if (
        current.status === "PENDING" &&
        current.expiresAt !== undefined &&
        now >= current.expiresAt
      ) {
        const expired = this.resolveInTransaction(client, current, "EXPIRED", undefined, now);
        client.exec("COMMIT");
        return expired;
      }
      if (current.status !== "PENDING") {
        if (
          (parsedResolution.action === "REJECT" && current.status === "REJECTED") ||
          (parsedResolution.action === "APPROVE" &&
            current.status === "APPROVED" &&
            current.grantedScope === parsedResolution.scope)
        ) {
          client.exec("COMMIT");
          return current;
        }
        if (current.status === "EXPIRED") {
          throw new StorageConflictError("Expired ApprovalRequest cannot be approved.");
        }
        throw new StorageConflictError("ApprovalRequest has already been resolved differently.");
      }
      if (parsedResolution.action === "APPROVE") {
        if (current.scope === "ONCE" && parsedResolution.scope === "RUN") {
          throw new StorageConflictError("Approval resolution scope exceeds the request scope.");
        }
        const approved = this.resolveInTransaction(
          client,
          current,
          "APPROVED",
          parsedResolution.scope,
          now,
        );
        client.exec("COMMIT");
        return approved;
      }
      const rejected = this.resolveInTransaction(client, current, "REJECTED", undefined, now);
      client.exec("COMMIT");
      return rejected;
    } catch (error) {
      client.exec("ROLLBACK");
      if (error instanceof StorageError) throw error;
      throw new StorageError("Unable to resolve ApprovalRequest.", { cause: error });
    }
  }

  async cancelPendingByRun(runId: RunId): Promise<readonly ApprovalRequest[]> {
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      const rows = client
        .prepare(
          `SELECT id, run_id, tool_invocation_id, approval_key, status, scope, granted_scope,
                  risk_level, protocol_version, created_at_ms, expires_at_ms, resolved_at_ms, data_json
           FROM approval_requests WHERE run_id = ? AND status = 'PENDING'
           ORDER BY created_at_ms ASC, id ASC`,
        )
        .all(runId) as unknown as ApprovalRow[];
      const cancelled: ApprovalRequest[] = [];
      const now = this.clock.now();
      for (const row of rows) {
        const loaded = decodeApprovalRow(row);
        if (loaded.status === "PENDING") {
          cancelled.push(this.resolveInTransaction(client, loaded, "CANCELLED", undefined, now));
        }
      }
      client.exec("COMMIT");
      return cancelled;
    } catch (error) {
      client.exec("ROLLBACK");
      if (error instanceof StorageError) throw error;
      throw new StorageError("Unable to cancel pending ApprovalRequests.", { cause: error });
    }
  }

  private async loadAndExpire(id: ApprovalRequestId): Promise<ApprovalRequest | null> {
    const row = selectById(this.database.client, id);
    if (row === undefined) return null;
    const approval = decodeApprovalRow(row);
    if (
      approval.status !== "PENDING" ||
      approval.expiresAt === undefined ||
      this.clock.now() < approval.expiresAt
    ) {
      return approval;
    }
    return this.resolve(id, { action: "REJECT" });
  }

  private resolveInTransaction(
    client: CaelushDatabase["client"],
    current: ApprovalRequest,
    status: "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED",
    grantedScope: ApprovalRequest["grantedScope"],
    resolvedAt: TimestampMs,
  ): ApprovalRequest {
    const candidate = ApprovalRequestSchema.parse({
      ...current,
      status,
      ...(grantedScope === undefined ? {} : { grantedScope }),
      resolvedAt,
    });
    client
      .prepare(
        `UPDATE approval_requests
         SET status = ?, granted_scope = ?, resolved_at_ms = ?, data_json = ? WHERE id = ?`,
      )
      .run(
        candidate.status,
        candidate.grantedScope ?? null,
        candidate.resolvedAt!,
        encodeProtocol(ApprovalRequestSchema, candidate, {
          entityType: "ApprovalRequest",
          entityId: candidate.id,
          table: "approval_requests",
        }),
        candidate.id,
      );
    const invocation = client
      .prepare(
        `SELECT agent_runs.session_id, tool_invocations.step_id
         FROM tool_invocations JOIN agent_runs ON agent_runs.id = tool_invocations.run_id
         WHERE tool_invocations.id = ?`,
      )
      .get(candidate.toolInvocationId) as { session_id: string; step_id: string } | undefined;
    if (invocation === undefined) throw new StorageError("Approval ToolInvocation disappeared.");
    const event = createApprovalResolvedEvent({
      eventId: this.eventIdFactory.create(),
      sessionId: invocation.session_id as SessionId,
      runId: candidate.runId,
      stepId: invocation.step_id as StepId,
      timestamp: resolvedAt,
      approvalId: candidate.id,
      status: candidate.status,
      ...(candidate.grantedScope === undefined ? {} : { grantedScope: candidate.grantedScope }),
    });
    appendDurableEventsInTransaction(client, [event as unknown as DurableToolEventDraft]);
    return candidate;
  }
}
