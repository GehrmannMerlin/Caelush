import {
  RunCancellationIntentSchema,
  type RunCancellationIntent,
  type RunId,
} from "@caelush/protocol";
import type { CaelushDatabase } from "./database.js";
import { StorageConflictError, StorageDecodeError, StorageError } from "./errors.js";

export interface CancellationRepository {
  get(runId: RunId): Promise<RunCancellationIntent | null>;
  request(intent: RunCancellationIntent): Promise<RunCancellationIntent>;
}

interface CancellationRow {
  run_id: string;
  cause: string;
  requested_at_ms: number;
}

function decode(row: CancellationRow): RunCancellationIntent {
  const parsed = RunCancellationIntentSchema.safeParse({
    runId: row.run_id,
    cause: row.cause,
    requestedAt: row.requested_at_ms,
  });
  if (!parsed.success) {
    throw new StorageDecodeError("RunCancellationIntent", row.run_id, "run_cancellation_requests");
  }
  return parsed.data;
}

function load(client: CaelushDatabase["client"], runId: RunId): RunCancellationIntent | null {
  const row = client
    .prepare(
      "SELECT run_id, cause, requested_at_ms FROM run_cancellation_requests WHERE run_id = ?",
    )
    .get(runId) as CancellationRow | undefined;
  return row === undefined ? null : decode(row);
}

export class SqliteCancellationRepository implements CancellationRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async get(runId: RunId): Promise<RunCancellationIntent | null> {
    return load(this.database.client, runId);
  }

  async request(intent: RunCancellationIntent): Promise<RunCancellationIntent> {
    const parsed = RunCancellationIntentSchema.parse(intent);
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      const existing = load(client, parsed.runId);
      if (existing !== null) {
        client.exec("COMMIT");
        return existing;
      }
      const run = client
        .prepare("SELECT status FROM agent_runs WHERE id = ?")
        .get(parsed.runId) as { status: string } | undefined;
      if (run === undefined) throw new StorageError(`AgentRun ${parsed.runId} was not found`);
      if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "MAX_STEPS_REACHED", "BUDGET_EXCEEDED"].includes(run.status)) {
        throw new StorageConflictError("terminal Run cannot accept a cancellation intent");
      }
      client
        .prepare(
          "INSERT INTO run_cancellation_requests (run_id, cause, requested_at_ms) VALUES (?, ?, ?)",
        )
        .run(parsed.runId, parsed.cause, parsed.requestedAt);
      const inserted = load(client, parsed.runId);
      if (inserted === null)
        throw new StorageError("Cancellation intent disappeared after insert.");
      client.exec("COMMIT");
      return inserted;
    } catch (error) {
      client.exec("ROLLBACK");
      if (error instanceof StorageError || error instanceof StorageConflictError) throw error;
      throw new StorageError("Unable to persist Run cancellation intent.", { cause: error });
    }
  }
}
