import {
  VerificationCheckSchema,
  VerificationEvidenceSchema,
  VerificationPlanSchema,
  type RunId,
  type StepId,
  type VerificationCheck,
  type VerificationEvidence,
  type VerificationPlan,
  type VerificationPlanId,
  type VerificationCheckId,
} from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { decodeProtocol, encodeProtocol } from "../codec.js";
import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
  StorageNotFoundError,
} from "../errors.js";

interface VerificationPlanRow {
  id: string;
  run_id: string;
  source_step_id: string;
  planner_version: string;
  plan_hash: string;
  created_at_ms: number;
  data_json: string;
}

interface VerificationCheckRow {
  id: string;
  plan_id: string;
  ordinal: number;
  stage: string;
  requirement: string;
  status: string;
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  skip_reason: string | null;
  data_json: string;
}

interface VerificationEvidenceRow {
  id: string;
  plan_id: string;
  check_id: string;
  kind: string;
  captured_at_ms: number;
  data_json: string;
}

export interface VerificationRepository {
  createPlan(plan: VerificationPlan): Promise<VerificationPlan>;
  getPlan(id: VerificationPlanId): Promise<VerificationPlan | null>;
  getPlanForRun(runId: RunId, sourceStepId: StepId): Promise<VerificationPlan | null>;
  listPlans(runId: RunId): Promise<readonly VerificationPlan[]>;
  getLatestPlan(runId: RunId): Promise<VerificationPlan | null>;
  countPlans(runId: RunId): Promise<number>;
  listChecks(planId: VerificationPlanId): Promise<readonly VerificationCheck[]>;
  addEvidence(evidence: VerificationEvidence): Promise<VerificationEvidence>;
  getEvidence(id: VerificationEvidence["id"]): Promise<VerificationEvidence | null>;
  listEvidence(
    planId: VerificationPlanId,
    checkId?: VerificationCheckId,
  ): Promise<readonly VerificationEvidence[]>;
}

function optionalTimestampMatches(value: number | undefined, stored: number | null): boolean {
  return value === undefined ? stored === null : value === stored;
}

function decodePlan(row: VerificationPlanRow): VerificationPlan {
  const plan = decodeProtocol(VerificationPlanSchema, row.data_json, {
    entityType: "VerificationPlan",
    entityId: row.id,
    table: "verification_plans",
  });
  if (
    plan.id !== row.id ||
    plan.runId !== row.run_id ||
    plan.sourceStepId !== row.source_step_id ||
    plan.plannerVersion !== row.planner_version ||
    plan.planHash !== row.plan_hash ||
    plan.createdAt !== row.created_at_ms
  ) {
    throw new StorageDecodeError("VerificationPlan", row.id, "verification_plans");
  }
  return plan;
}

function decodeCheck(row: VerificationCheckRow): VerificationCheck {
  const check = decodeProtocol(VerificationCheckSchema, row.data_json, {
    entityType: "VerificationCheck",
    entityId: row.id,
    table: "verification_checks",
  });
  if (
    check.id !== row.id ||
    check.planId !== row.plan_id ||
    check.ordinal !== row.ordinal ||
    check.stage !== row.stage ||
    check.requirement !== row.requirement ||
    check.status !== row.status ||
    check.createdAt !== row.created_at_ms ||
    !optionalTimestampMatches(check.startedAt, row.started_at_ms) ||
    !optionalTimestampMatches(check.finishedAt, row.finished_at_ms) ||
    (check.skipReason ?? null) !== row.skip_reason
  ) {
    throw new StorageDecodeError("VerificationCheck", row.id, "verification_checks");
  }
  return check;
}

function decodeEvidence(row: VerificationEvidenceRow): VerificationEvidence {
  const evidence = decodeProtocol(VerificationEvidenceSchema, row.data_json, {
    entityType: "VerificationEvidence",
    entityId: row.id,
    table: "verification_evidence",
  });
  if (
    evidence.id !== row.id ||
    evidence.planId !== row.plan_id ||
    evidence.checkId !== row.check_id ||
    evidence.kind !== row.kind ||
    evidence.capturedAt !== row.captured_at_ms
  ) {
    throw new StorageDecodeError("VerificationEvidence", row.id, "verification_evidence");
  }
  return evidence;
}

function planRow(client: CaelushDatabase["client"], id: string): VerificationPlanRow | undefined {
  return client
    .prepare(
      `SELECT id, run_id, source_step_id, planner_version, plan_hash, created_at_ms, data_json
       FROM verification_plans WHERE id = ?`,
    )
    .get(id) as VerificationPlanRow | undefined;
}

function checkRows(client: CaelushDatabase["client"], planId: string): VerificationCheckRow[] {
  return client
    .prepare(
      `SELECT id, plan_id, ordinal, stage, requirement, status, created_at_ms,
              started_at_ms, finished_at_ms, skip_reason, data_json
       FROM verification_checks WHERE plan_id = ? ORDER BY ordinal ASC`,
    )
    .all(planId) as unknown as VerificationCheckRow[];
}

function evidenceRows(
  client: CaelushDatabase["client"],
  planId: string,
  checkId?: string,
): VerificationEvidenceRow[] {
  const query =
    checkId === undefined
      ? `SELECT id, plan_id, check_id, kind, captured_at_ms, data_json
       FROM verification_evidence WHERE plan_id = ? ORDER BY captured_at_ms ASC, id ASC`
      : `SELECT id, plan_id, check_id, kind, captured_at_ms, data_json
       FROM verification_evidence WHERE plan_id = ? AND check_id = ?
       ORDER BY captured_at_ms ASC, id ASC`;
  return (checkId === undefined
    ? client.prepare(query).all(planId)
    : client.prepare(query).all(planId, checkId)) as unknown as VerificationEvidenceRow[];
}

function loadPlanInTransaction(
  client: CaelushDatabase["client"],
  id: string,
): VerificationPlan | null {
  const row = planRow(client, id);
  if (row === undefined) return null;
  const plan = decodePlan(row);
  const checks = checkRows(client, id).map(decodeCheck);
  if (JSON.stringify(checks) !== JSON.stringify(plan.checks)) {
    throw new StorageDecodeError("VerificationPlan", id, "verification_plans");
  }
  return plan;
}

export function writeVerificationPlanInTransaction(
  client: CaelushDatabase["client"],
  plan: VerificationPlan,
): VerificationPlan {
  const parsed = VerificationPlanSchema.parse(plan);
  const existingForBoundary = client
    .prepare(
      "SELECT id, plan_hash, data_json FROM verification_plans WHERE run_id = ? AND source_step_id = ?",
    )
    .get(parsed.runId, parsed.sourceStepId) as
    { id: string; plan_hash: string; data_json: string } | undefined;
  if (existingForBoundary !== undefined) {
    if (existingForBoundary.plan_hash === parsed.planHash) {
      return loadPlanInTransaction(client, existingForBoundary.id)!;
    }
    throw new StorageConflictError(
      "A different VerificationPlan already exists for the Run boundary.",
    );
  }

  const dataJson = encodeProtocol(VerificationPlanSchema, parsed, {
    entityType: "VerificationPlan",
    entityId: parsed.id,
    table: "verification_plans",
  });
  try {
    client
      .prepare(
        `INSERT INTO verification_plans
         (id, run_id, source_step_id, planner_version, plan_hash, created_at_ms, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.runId,
        parsed.sourceStepId,
        parsed.plannerVersion,
        parsed.planHash,
        parsed.createdAt,
        dataJson,
      );
    for (const check of parsed.checks) {
      const checkDataJson = encodeProtocol(VerificationCheckSchema, check, {
        entityType: "VerificationCheck",
        entityId: check.id,
        table: "verification_checks",
      });
      client
        .prepare(
          `INSERT INTO verification_checks
           (id, plan_id, ordinal, stage, requirement, status, created_at_ms,
            started_at_ms, finished_at_ms, skip_reason, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          check.id,
          check.planId,
          check.ordinal,
          check.stage,
          check.requirement,
          check.status,
          check.createdAt,
          check.startedAt ?? null,
          check.finishedAt ?? null,
          check.skipReason ?? null,
          checkDataJson,
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
      throw new StorageConflictError("VerificationPlan conflicts with durable data.", {
        cause: error,
      });
    }
    throw error;
  }
  return parsed;
}

export function loadVerificationPlanInTransaction(
  client: CaelushDatabase["client"],
  id: VerificationPlanId,
): VerificationPlan | null {
  return loadPlanInTransaction(client, id);
}

export class SqliteVerificationRepository implements VerificationRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async createPlan(plan: VerificationPlan): Promise<VerificationPlan> {
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      const result = writeVerificationPlanInTransaction(client, plan);
      client.exec("COMMIT");
      return result;
    } catch (error) {
      client.exec("ROLLBACK");
      if (error instanceof StorageError) throw error;
      throw new StorageError("Unable to create VerificationPlan.", { cause: error });
    }
  }

  async getPlan(id: VerificationPlanId): Promise<VerificationPlan | null> {
    return loadPlanInTransaction(this.database.client, id);
  }

  async getPlanForRun(runId: RunId, sourceStepId: StepId): Promise<VerificationPlan | null> {
    const row = this.database.client
      .prepare(
        `SELECT id, run_id, source_step_id, planner_version, plan_hash, created_at_ms, data_json
         FROM verification_plans WHERE run_id = ? AND source_step_id = ?`,
      )
      .get(runId, sourceStepId) as VerificationPlanRow | undefined;
    return row === undefined ? null : loadPlanInTransaction(this.database.client, row.id);
  }

  async listPlans(runId: RunId): Promise<readonly VerificationPlan[]> {
    const rows = this.database.client
      .prepare(
        `SELECT id, run_id, source_step_id, planner_version, plan_hash, created_at_ms, data_json
         FROM verification_plans WHERE run_id = ? ORDER BY created_at_ms ASC, id ASC`,
      )
      .all(runId) as unknown as VerificationPlanRow[];
    return rows.map((row) => loadPlanInTransaction(this.database.client, row.id)!);
  }

  async getLatestPlan(runId: RunId): Promise<VerificationPlan | null> {
    const row = this.database.client
      .prepare(
        `SELECT id, run_id, source_step_id, planner_version, plan_hash, created_at_ms, data_json
         FROM verification_plans WHERE run_id = ? ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
      )
      .get(runId) as VerificationPlanRow | undefined;
    return row === undefined ? null : loadPlanInTransaction(this.database.client, row.id);
  }

  async countPlans(runId: RunId): Promise<number> {
    const row = this.database.client
      .prepare("SELECT COUNT(*) AS count FROM verification_plans WHERE run_id = ?")
      .get(runId) as { count: number };
    return row.count;
  }

  async listChecks(planId: VerificationPlanId): Promise<readonly VerificationCheck[]> {
    return checkRows(this.database.client, planId).map(decodeCheck);
  }

  async addEvidence(evidence: VerificationEvidence): Promise<VerificationEvidence> {
    const parsed = VerificationEvidenceSchema.parse(evidence);
    const plan = loadPlanInTransaction(this.database.client, parsed.planId);
    if (plan === null) throw new StorageNotFoundError("VerificationPlan", parsed.planId);
    if (!plan.checks.some((check) => check.id === parsed.checkId)) {
      throw new StorageNotFoundError("VerificationCheck", parsed.checkId);
    }
    const dataJson = encodeProtocol(VerificationEvidenceSchema, parsed, {
      entityType: "VerificationEvidence",
      entityId: parsed.id,
      table: "verification_evidence",
    });
    try {
      this.database.client
        .prepare(
          `INSERT INTO verification_evidence
           (id, plan_id, check_id, kind, captured_at_ms, data_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(parsed.id, parsed.planId, parsed.checkId, parsed.kind, parsed.capturedAt, dataJson);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
        throw new StorageConflictError("VerificationEvidence conflicts with durable data.", {
          cause: error,
        });
      }
      throw new StorageError("Unable to create VerificationEvidence.", { cause: error });
    }
    return parsed;
  }

  async getEvidence(id: VerificationEvidence["id"]): Promise<VerificationEvidence | null> {
    const row = this.database.client
      .prepare(
        `SELECT id, plan_id, check_id, kind, captured_at_ms, data_json
         FROM verification_evidence WHERE id = ?`,
      )
      .get(id) as VerificationEvidenceRow | undefined;
    return row === undefined ? null : decodeEvidence(row);
  }

  async listEvidence(
    planId: VerificationPlanId,
    checkId?: VerificationCheckId,
  ): Promise<readonly VerificationEvidence[]> {
    return evidenceRows(this.database.client, planId, checkId).map(decodeEvidence);
  }
}
