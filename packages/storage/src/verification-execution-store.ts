import {
  VerificationCheckSchema,
  VerificationEvidenceSchema,
  VerificationPlanSchema,
  createEventId,
  type EventId,
  type VerificationCheck,
  type VerificationEvidence,
  type VerificationPlan,
} from "@caelush/protocol";
import type { DurableAgentEvent, DurableEventDraft } from "@caelush/events";
import type {
  VerificationCommittedEvent,
  VerificationExecutionRecoveryStorePort,
  VerificationExecutionSnapshot,
  VerificationSettlementCommit,
  VerificationSettlementCommitResult,
  VerificationStartCommit,
  VerificationStartCommitResult,
} from "@caelush/verification";
import { assertVerificationCheckTransition } from "@caelush/verification";
import type { CaelushDatabase } from "./database.js";
import { encodeProtocol } from "./codec.js";
import { StorageConflictError, StorageError, StorageNotFoundError } from "./errors.js";
import { appendDurableEventsInTransaction } from "./events/sqlite-durable-event-store.js";
import { loadVerificationPlanInTransaction } from "./repositories/verification-repository.js";

export interface SqliteVerificationExecutionStoreOptions {
  readonly eventIdFactory?: () => EventId;
}

export class SqliteVerificationExecutionStore implements VerificationExecutionRecoveryStorePort {
  private readonly eventIdFactory: () => EventId;

  constructor(
    private readonly database: CaelushDatabase,
    options: SqliteVerificationExecutionStoreOptions = {},
  ) {
    this.eventIdFactory = options.eventIdFactory ?? createEventId;
  }

  async startCheck(input: VerificationStartCommit): Promise<VerificationStartCommitResult> {
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      assertVerificationBoundary(client, input.runId, input.sessionId);
      const plan = requirePlan(client, input.check.planId);
      if (plan.runId !== input.runId)
        throw new StorageConflictError("verification Run identity mismatch");
      const current = requireCheck(plan, input.check.id);
      if (current.status === "RUNNING" && sameCheck(current, input.check)) {
        client.exec("COMMIT");
        return { check: current, events: [] };
      }
      if (current.status !== "PENDING") {
        throw new StorageConflictError("Verification check is not pending.");
      }
      if (input.check.status !== "RUNNING" || input.check.startedAt === undefined) {
        throw new StorageConflictError("Verification check start must transition to RUNNING.");
      }
      assertVerificationCheckTransition(current, input.check);
      const discovery = VerificationEvidenceSchema.parse(input.discoveryEvidence);
      assertEvidenceBelongsTo(discovery, plan, current);
      const event = startEvent(this.eventIdFactory(), input);
      persistCheckAndEvidence(client, plan, input.check, [discovery]);
      const [committed] = appendDurableEventsInTransaction(client, [event]);
      if (committed === undefined)
        throw new StorageError("Unable to append verification start event.");
      client.exec("COMMIT");
      return { check: input.check, events: asVerificationEvents([committed]) };
    } catch (error) {
      client.exec("ROLLBACK");
      if (error instanceof StorageError) throw error;
      throw new StorageError("Unable to persist verification check start.", { cause: error });
    }
  }

  async settleCheck(
    input: VerificationSettlementCommit,
  ): Promise<VerificationSettlementCommitResult> {
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      assertVerificationBoundary(client, input.runId, input.sessionId);
      const plan = requirePlan(client, input.check.planId);
      if (plan.runId !== input.runId)
        throw new StorageConflictError("verification Run identity mismatch");
      const current = requireCheck(plan, input.check.id);
      if (isTerminal(current.status) && sameCheck(current, input.check)) {
        client.exec("COMMIT");
        return { check: current, events: [] };
      }
      if (!isTerminal(input.check.status)) {
        throw new StorageConflictError("Verification check settlement must be terminal.");
      }
      assertVerificationCheckTransition(current, input.check);
      const evidence = input.evidence.map((item) => VerificationEvidenceSchema.parse(item));
      for (const item of evidence) assertEvidenceBelongsTo(item, plan, current);
      const event = completedEvent(this.eventIdFactory(), input);
      persistCheckAndEvidence(client, plan, input.check, evidence);
      const [committed] = appendDurableEventsInTransaction(client, [event]);
      if (committed === undefined)
        throw new StorageError("Unable to append verification completion event.");
      client.exec("COMMIT");
      return { check: input.check, events: asVerificationEvents([committed]) };
    } catch (error) {
      client.exec("ROLLBACK");
      if (error instanceof StorageError) throw error;
      throw new StorageError("Unable to persist verification check settlement.", { cause: error });
    }
  }

  async getPlanExecutionSnapshot(
    planId: VerificationPlan["id"],
  ): Promise<VerificationExecutionSnapshot | null> {
    const plan = loadVerificationPlanInTransaction(this.database.client, planId);
    if (plan === null) return null;
    const rows = this.database.client
      .prepare(
        `SELECT id, plan_id, check_id, kind, captured_at_ms, data_json
         FROM verification_evidence WHERE plan_id = ? ORDER BY captured_at_ms ASC, id ASC`,
      )
      .all(planId) as Array<{
      id: string;
      plan_id: string;
      check_id: string;
      kind: string;
      captured_at_ms: number;
      data_json: string;
    }>;
    const evidence = rows.map(
      (row) => VerificationEvidenceSchema.parse(JSON.parse(row.data_json)) as VerificationEvidence,
    );
    return { plan, evidence };
  }

  async countPlans(runId: VerificationPlan["runId"]): Promise<number> {
    const row = this.database.client
      .prepare("SELECT COUNT(*) AS count FROM verification_plans WHERE run_id = ?")
      .get(runId) as { count: number };
    return row.count;
  }
}

function assertVerificationBoundary(
  client: CaelushDatabase["client"],
  runId: VerificationStartCommit["runId"],
  sessionId: VerificationStartCommit["sessionId"],
): void {
  const run = client
    .prepare("SELECT status, session_id FROM agent_runs WHERE id = ?")
    .get(runId) as { status: string; session_id: string } | undefined;
  const continuation = client
    .prepare("SELECT kind FROM agent_run_continuations WHERE run_id = ?")
    .get(runId) as { kind: string } | undefined;
  if (
    run === undefined ||
    run.session_id !== sessionId ||
    [
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMEOUT",
      "MAX_STEPS_REACHED",
      "BUDGET_EXCEEDED",
    ].includes(run.status) ||
    (run.status === "VERIFYING" &&
      continuation !== undefined &&
      continuation.kind !== "AWAITING_VERIFICATION")
  ) {
    throw new StorageConflictError("verification write arrived after its Run boundary closed");
  }
}

function requirePlan(
  client: CaelushDatabase["client"],
  planId: VerificationPlan["id"],
): VerificationPlan {
  const plan = loadVerificationPlanInTransaction(client, planId);
  if (plan === null) throw new StorageNotFoundError("VerificationPlan", planId);
  return plan;
}

function requireCheck(plan: VerificationPlan, checkId: VerificationCheck["id"]): VerificationCheck {
  const check = plan.checks.find((item) => item.id === checkId);
  if (check === undefined) throw new StorageNotFoundError("VerificationCheck", checkId);
  return check;
}

function sameCheck(left: VerificationCheck, right: VerificationCheck): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isTerminal(status: VerificationCheck["status"]): boolean {
  return (
    status === "PASSED" ||
    status === "FAILED" ||
    status === "ERROR" ||
    status === "SKIPPED" ||
    status === "CANCELLED"
  );
}

function assertEvidenceBelongsTo(
  evidence: VerificationEvidence,
  plan: VerificationPlan,
  check: VerificationCheck,
): void {
  if (evidence.planId !== plan.id || evidence.checkId !== check.id) {
    throw new StorageConflictError("Verification evidence does not belong to the selected check.");
  }
}

function persistCheckAndEvidence(
  client: CaelushDatabase["client"],
  plan: VerificationPlan,
  check: VerificationCheck,
  evidence: readonly VerificationEvidence[],
): void {
  const updatedPlan = VerificationPlanSchema.parse({
    ...plan,
    checks: plan.checks.map((item) => (item.id === check.id ? check : item)),
  });
  const checkDataJson = encodeProtocol(VerificationCheckSchema, check, {
    entityType: "VerificationCheck",
    entityId: check.id,
    table: "verification_checks",
  });
  const planDataJson = encodeProtocol(VerificationPlanSchema, updatedPlan, {
    entityType: "VerificationPlan",
    entityId: plan.id,
    table: "verification_plans",
  });
  client
    .prepare(
      `UPDATE verification_checks
       SET status = ?, started_at_ms = ?, finished_at_ms = ?, skip_reason = ?, data_json = ?
       WHERE id = ? AND plan_id = ?`,
    )
    .run(
      check.status,
      check.startedAt ?? null,
      check.finishedAt ?? null,
      check.skipReason ?? null,
      checkDataJson,
      check.id,
      plan.id,
    );
  client
    .prepare("UPDATE verification_plans SET data_json = ? WHERE id = ?")
    .run(planDataJson, plan.id);
  for (const item of evidence) {
    const dataJson = encodeProtocol(VerificationEvidenceSchema, item, {
      entityType: "VerificationEvidence",
      entityId: item.id,
      table: "verification_evidence",
    });
    client
      .prepare(
        `INSERT INTO verification_evidence
         (id, plan_id, check_id, kind, captured_at_ms, data_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(item.id, item.planId, item.checkId, item.kind, item.capturedAt, dataJson);
  }
}

function startEvent(eventId: EventId, input: VerificationStartCommit): DurableEventDraft {
  return {
    eventId,
    schemaVersion: 1,
    runId: input.runId,
    sessionId: input.sessionId,
    timestamp: input.discoveryEvidence.capturedAt,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1 },
    type: "verification.check.started",
    payload: {
      planId: input.check.planId,
      checkId: input.check.id,
      ordinal: input.check.ordinal,
      kind: input.check.spec.kind,
      purpose: input.check.spec.purpose,
      stage: input.check.stage,
    },
  } as DurableEventDraft;
}

function completedEvent(eventId: EventId, input: VerificationSettlementCommit): DurableEventDraft {
  const capturedAt = input.evidence[0]?.capturedAt ?? input.check.finishedAt!;
  return {
    eventId,
    schemaVersion: 1,
    runId: input.runId,
    sessionId: input.sessionId,
    timestamp: capturedAt,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1 },
    type: "verification.check.completed",
    payload: {
      planId: input.check.planId,
      checkId: input.check.id,
      status: input.check.status,
      evidenceIds: input.evidence.map((item) => item.id),
      durationMs:
        input.check.startedAt === undefined || input.check.finishedAt === undefined
          ? undefined
          : input.check.finishedAt - input.check.startedAt,
    },
  } as DurableEventDraft;
}

function asVerificationEvents(
  events: readonly DurableAgentEvent[],
): readonly VerificationCommittedEvent[] {
  return events as readonly VerificationCommittedEvent[];
}
