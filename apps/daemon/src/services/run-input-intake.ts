import type {
  AgentRun,
  RunInputErrorReason,
  RunInputListQuery,
  RunInputListResponse,
  RunInputReceipt,
  RunId,
  SubmitRunInputRequest,
  TimestampMs,
} from "@caelush/protocol";
import {
  RunInputListQuerySchema,
  RunInputListResponseSchema,
  RunInputReceiptSchema,
  SubmitRunInputRequestSchema,
} from "@caelush/protocol";
import type { RunEventFactory } from "@caelush/agent";
import type { EventIdFactory } from "@caelush/core";
import {
  StorageArchiveConflictError,
  StorageNotFoundError,
  type ArchiveStore,
  type RunInputRecord,
  type RunRepository,
  type SqliteRunInputStore,
} from "@caelush/storage";
import { requireUnarchivedTarget } from "./archive-access.js";

/**
 * The daemon's Run input intake service.
 *
 * ```text
 * route          request schema, identity, Run existence
 * this service   archived target, receipt projection, structured refusal
 * storage        the short authoritative transaction that actually decides
 * ```
 *
 * It holds no execution authority. Accepting an input never starts, recovers, cancels, resumes or
 * approves anything; a paused Run stays paused and an active driver reads the row at its next safe
 * boundary.
 */
export class RunInputRejectionError extends Error {
  constructor(
    readonly reason: RunInputErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "RunInputRejectionError";
  }
}

export interface RunInputServiceDependencies {
  readonly runs: Pick<RunRepository, "get">;
  readonly archives?: Pick<ArchiveStore, "getState"> | undefined;
  readonly store: SqliteRunInputStore;
  readonly events: Pick<RunEventFactory, "runInputAccepted">;
  readonly eventIds: EventIdFactory;
  readonly clock: { now(): TimestampMs };
}

export class RunInputService {
  constructor(private readonly dependencies: RunInputServiceDependencies) {}

  async submit(runId: RunId, request: SubmitRunInputRequest): Promise<RunInputReceipt> {
    const parsed = SubmitRunInputRequestSchema.parse(request);
    const run = await this.requireRun(runId);
    await requireUnarchivedTarget(this.dependencies.archives, {
      type: "SESSION",
      sessionId: run.sessionId,
    });
    const now = this.dependencies.clock.now();
    const result = await this.dependencies.store.accept({
      runId,
      inputId: parsed.inputId,
      text: parsed.text,
      now,
      buildEvent: (acceptedSequence) =>
        this.dependencies.events.runInputAccepted(
          run,
          { inputId: parsed.inputId, acceptedSequence },
          this.dependencies.eventIds.create(),
          now,
        ),
    });
    switch (result.kind) {
      case "ACCEPTED":
      case "EXISTING":
        return toReceipt(runId, result.record);
      case "REJECTED":
        throw new RunInputRejectionError(result.reason, rejectionMessage(result.reason));
    }
  }

  async list(runId: RunId, query: RunInputListQuery): Promise<RunInputListResponse> {
    const parsed = RunInputListQuerySchema.parse(query);
    await this.requireRun(runId);
    const page = await this.dependencies.store.list(runId, {
      ...(parsed.after === undefined ? {} : { after: parsed.after }),
      limit: parsed.limit,
    });
    return RunInputListResponseSchema.parse({
      items: page.items.map((record) => toReceipt(runId, record)),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  }

  private async requireRun(runId: RunId): Promise<AgentRun> {
    const run = await this.dependencies.runs.get(runId);
    if (run === null) throw new StorageNotFoundError("AgentRun", runId);
    return run;
  }
}

function toReceipt(runId: RunId, record: RunInputRecord): RunInputReceipt {
  return RunInputReceiptSchema.parse({
    inputId: record.inputId,
    runId,
    acceptedSequence: record.acceptedSequence,
    stage: record.stage,
    acceptedAt: record.acceptedAt,
    ...(record.messageId === undefined ? {} : { messageId: record.messageId }),
    ...(record.firstStepId === undefined ? {} : { firstStepId: record.firstStepId }),
  });
}

/**
 * One fixed, safe sentence per reason.
 *
 * The client switches on `reason`; these strings exist so an operator reading a log or a raw
 * response still gets a correct explanation. They never quote the input text.
 */
function rejectionMessage(reason: RunInputErrorReason): string {
  switch (reason) {
    case "NOT_SUPPORTED":
      return "This Run does not support mid-Run input.";
    case "RUN_NOT_READY":
      return "The Run is not at a point where it can accept input.";
    case "RUN_TERMINAL":
      return "The Run has ended and cannot accept new input.";
    case "TARGET_MISMATCH":
      return "The Run input target does not exist.";
    case "IDEMPOTENCY_CONFLICT":
      return "The input identity was already used with different text.";
    case "QUEUE_FULL":
      return "This Run already holds the maximum number of unapplied inputs.";
    case "TEXT_TOO_LARGE":
      return "The input text is empty or exceeds the size limit.";
    case "STORE_UNAVAILABLE":
      return "Run input storage is unavailable.";
  }
}

/** Re-exported so the route can recognise the archived-target refusal it already maps. */
export { StorageArchiveConflictError };
