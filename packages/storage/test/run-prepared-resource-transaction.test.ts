import { createRunEventFactory, type DurableRunEventDraft } from "@caelush/agent";
import {
  AttachmentSha256Schema,
  createEventId,
  SubmissionIdSchema,
  type AgentRun,
  type RunId,
  type RunWorkflowExecutionProfileV1,
  type SubmissionId,
  type WorkflowResourceBindingDraftV1,
  type WorkflowResourceBindingV1,
} from "@caelush/protocol";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { StorageConflictError, StorageError } from "../src/errors.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteDurableEventStore } from "../src/events/sqlite-durable-event-store.js";
import { SqliteRunRepository } from "../src/repositories/run-repository.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { SqliteSubmissionRepository } from "../src/submission-repository.js";
import { makeRun, makeSession } from "./support/fixtures.js";

const PAYLOAD_HASH = AttachmentSha256Schema.parse("c".repeat(64));

interface PreparedResourceRunRepository {
  insertRunWithPreparedResources?(input: {
    readonly run: AgentRun;
    readonly workflowProfile?: RunWorkflowExecutionProfileV1;
    readonly resourcesInOrder: readonly WorkflowResourceBindingDraftV1[];
    readonly events: readonly DurableRunEventDraft[];
    readonly submissionIdentity?: {
      readonly submissionId: SubmissionId;
      readonly payloadHash: string;
    };
  }): Promise<readonly unknown[]>;
  readPreparedResources?(runId: RunId): Promise<readonly WorkflowResourceBindingV1[]>;
  readWorkflowProfile?(runId: RunId): Promise<RunWorkflowExecutionProfileV1 | null>;
}

function profile(runId: RunId): RunWorkflowExecutionProfileV1 {
  return {
    runId,
    profileVersion: 1,
    workflowRendererVersion: "workflow-renderer@1",
    catalogSnapshotRef: {
      catalogRevision: "catalog-revision-1",
      artifactRef: "catalog_" + runId,
      manifestFingerprint: "d".repeat(64),
    },
  };
}

function resource(
  runId: RunId,
  resourceId: string,
  resourceRevision = "revision-1",
): WorkflowResourceBindingDraftV1 {
  return {
    runId,
    resourceKind: "WORKFLOW_INSTRUCTION",
    resourceId,
    resourceRevision,
    artifactRef: "bundle_" + resourceId + "_" + resourceRevision,
    sourceFingerprint: "e".repeat(64),
    utf8Bytes: 256,
    tokenEstimate: 64,
  };
}

function eventFor(run: AgentRun): DurableRunEventDraft {
  if (run.securityPolicy === undefined) throw new Error("Run fixture has no security policy.");
  return createRunEventFactory().runSecurityPolicyBound(
    run,
    run.securityPolicy,
    createEventId(),
    run.createdAt,
  );
}

async function prepare(
  runs: SqliteRunRepository,
  input: {
    readonly run: AgentRun;
    readonly workflowProfile?: RunWorkflowExecutionProfileV1;
    readonly resourcesInOrder?: readonly WorkflowResourceBindingDraftV1[];
    readonly events?: readonly DurableRunEventDraft[];
    readonly submissionIdentity?: {
      readonly submissionId: SubmissionId;
      readonly payloadHash: string;
    };
  },
): Promise<boolean> {
  const repository = runs as unknown as PreparedResourceRunRepository;
  if (repository.insertRunWithPreparedResources === undefined) {
    expect(
      repository.insertRunWithPreparedResources,
      "RunRepository must provide the atomic prepared-resource insert",
    ).toBeTypeOf("function");
    return false;
  }
  await repository.insertRunWithPreparedResources.call(runs, {
    run: input.run,
    ...(input.workflowProfile === undefined ? {} : { workflowProfile: input.workflowProfile }),
    resourcesInOrder: input.resourcesInOrder ?? [],
    events: input.events ?? [],
    ...(input.submissionIdentity === undefined
      ? {}
      : { submissionIdentity: input.submissionIdentity }),
  });
  return true;
}

async function createSessionAndSubmission(
  database: Awaited<ReturnType<typeof openCaelushDatabase>>,
) {
  const sessions = new SqliteSessionRepository(database);
  const submissions = new SqliteSubmissionRepository(database);
  const session = makeSession();
  const submissionId = SubmissionIdSchema.parse(randomUUID());
  await sessions.insert(session);
  await submissions.reserve(submissionId, PAYLOAD_HASH);
  await submissions.bindSession(submissionId, session.id);
  return { session, submissionId, submissions };
}

function count(database: Awaited<ReturnType<typeof openCaelushDatabase>>, table: string): number {
  const row = database.client.prepare("SELECT COUNT(*) AS count FROM " + table).get() as {
    count: number;
  };
  return row.count;
}

describe("Run prepared-resource creation transaction", () => {
  it("commits Run, profile, ordered bindings, submission identity, and durable events together", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    try {
      await migrateCaelushDatabase(database);
      const { session, submissionId, submissions } = await createSessionAndSubmission(database);
      const runs = new SqliteRunRepository(database);
      const run = makeRun(session.id, { submissionId });
      const preparedProfile = profile(run.id);

      if (
        !(await prepare(runs, {
          run,
          workflowProfile: preparedProfile,
          resourcesInOrder: [resource(run.id, "alpha"), resource(run.id, "beta", "revision-2")],
          events: [eventFor(run)],
          submissionIdentity: { submissionId, payloadHash: PAYLOAD_HASH },
        }))
      )
        return;

      const repository = runs as unknown as PreparedResourceRunRepository;
      const committedEvents = await new SqliteDurableEventStore(database).replay(run.id);
      expect(await runs.get(run.id)).toEqual(run);
      expect(await repository.readWorkflowProfile?.(run.id)).toEqual(preparedProfile);
      expect(
        (await repository.readPreparedResources?.(run.id))?.map(
          ({ resourceId, activationOrdinal }) => [resourceId, activationOrdinal],
        ),
      ).toEqual([
        ["alpha", 0],
        ["beta", 1],
      ]);
      expect(committedEvents).toHaveLength(1);
      expect((await submissions.get(submissionId))?.runId).toBe(run.id);
    } finally {
      await database.close();
    }
  });

  it("rolls back every fact when the second binding insert fails", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    try {
      await migrateCaelushDatabase(database);
      const { session, submissionId, submissions } = await createSessionAndSubmission(database);
      const runs = new SqliteRunRepository(database);
      const run = makeRun(session.id, { submissionId });
      if (runs.insertRunWithPreparedResources === undefined) {
        if (!(await prepare(runs, { run }))) return;
      }
      database.client.exec(
        "CREATE TRIGGER fail_second_prepared_resource BEFORE INSERT ON run_prepared_resources " +
          "WHEN NEW.activation_ordinal = 1 BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
      );

      await expect(
        prepare(runs, {
          run,
          workflowProfile: profile(run.id),
          resourcesInOrder: [resource(run.id, "alpha"), resource(run.id, "beta", "revision-2")],
          events: [eventFor(run)],
          submissionIdentity: { submissionId, payloadHash: PAYLOAD_HASH },
        }),
      ).rejects.toBeInstanceOf(StorageError);
      expect(await runs.get(run.id)).toBeNull();
      expect(count(database, "run_workflow_profiles")).toBe(0);
      expect(count(database, "run_prepared_resources")).toBe(0);
      expect(count(database, "agent_events")).toBe(0);
      expect(count(database, "event_sequences")).toBe(0);
      expect((await submissions.get(submissionId))?.runId).toBeUndefined();
    } finally {
      await database.close();
    }
  });

  it("rolls back every fact when durable-event persistence fails", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    try {
      await migrateCaelushDatabase(database);
      const { session, submissionId, submissions } = await createSessionAndSubmission(database);
      const runs = new SqliteRunRepository(database);
      const run = makeRun(session.id, { submissionId });
      if (runs.insertRunWithPreparedResources === undefined) {
        if (!(await prepare(runs, { run }))) return;
      }
      database.client.exec(
        "CREATE TRIGGER fail_run_event BEFORE INSERT ON agent_events " +
          "BEGIN SELECT RAISE(ABORT, 'injected event failure'); END",
      );

      await expect(
        prepare(runs, {
          run,
          workflowProfile: profile(run.id),
          resourcesInOrder: [resource(run.id, "alpha")],
          events: [eventFor(run)],
          submissionIdentity: { submissionId, payloadHash: PAYLOAD_HASH },
        }),
      ).rejects.toBeInstanceOf(StorageError);
      expect(await runs.get(run.id)).toBeNull();
      expect(count(database, "run_workflow_profiles")).toBe(0);
      expect(count(database, "run_prepared_resources")).toBe(0);
      expect(count(database, "agent_events")).toBe(0);
      expect(count(database, "event_sequences")).toBe(0);
      expect((await submissions.get(submissionId))?.runId).toBeUndefined();
    } finally {
      await database.close();
    }
  });

  it("allows only one concurrent Run to claim a submission identity", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    try {
      await migrateCaelushDatabase(database);
      const { session, submissionId, submissions } = await createSessionAndSubmission(database);
      const runs = new SqliteRunRepository(database);
      const first = makeRun(session.id, { submissionId });
      const second = makeRun(session.id, { submissionId });
      const attempts = await Promise.allSettled([
        prepare(runs, {
          run: first,
          workflowProfile: profile(first.id),
          resourcesInOrder: [resource(first.id, "alpha")],
          events: [eventFor(first)],
          submissionIdentity: { submissionId, payloadHash: PAYLOAD_HASH },
        }),
        prepare(runs, {
          run: second,
          workflowProfile: profile(second.id),
          resourcesInOrder: [resource(second.id, "alpha")],
          events: [eventFor(second)],
          submissionIdentity: { submissionId, payloadHash: PAYLOAD_HASH },
        }),
      ]);

      expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
      const winner = (await submissions.get(submissionId))?.runId;
      expect([first.id, second.id]).toContain(winner);
      expect(await runs.get(first.id)).toEqual(winner === first.id ? first : null);
      expect(await runs.get(second.id)).toEqual(winner === second.id ? second : null);
      expect(count(database, "run_workflow_profiles")).toBe(1);
      expect(count(database, "run_prepared_resources")).toBe(1);
      expect(count(database, "agent_events")).toBe(1);
    } finally {
      await database.close();
    }
  });

  it("rejects resources for a different Run and duplicate resource versions atomically", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    try {
      await migrateCaelushDatabase(database);
      const { session } = await createSessionAndSubmission(database);
      const runs = new SqliteRunRepository(database);
      const wrongRun = makeRun(session.id);
      const otherRunId = makeRun(session.id).id;
      await expect(
        prepare(runs, {
          run: wrongRun,
          workflowProfile: profile(wrongRun.id),
          resourcesInOrder: [resource(otherRunId, "alpha")],
        }),
      ).rejects.toBeInstanceOf(StorageError);
      expect(await runs.get(wrongRun.id)).toBeNull();

      const duplicateRun = makeRun(session.id);
      await expect(
        prepare(runs, {
          run: duplicateRun,
          workflowProfile: profile(duplicateRun.id),
          resourcesInOrder: [
            resource(duplicateRun.id, "alpha", "same-revision"),
            resource(duplicateRun.id, "alpha", "same-revision"),
          ],
        }),
      ).rejects.toBeInstanceOf(StorageConflictError);
      expect(await runs.get(duplicateRun.id)).toBeNull();
      expect(count(database, "run_workflow_profiles")).toBe(0);
      expect(count(database, "run_prepared_resources")).toBe(0);
    } finally {
      await database.close();
    }
  });

  it("rejects a submission identity that does not match the Run", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    try {
      await migrateCaelushDatabase(database);
      const { session, submissionId } = await createSessionAndSubmission(database);
      const runs = new SqliteRunRepository(database);
      const run = makeRun(session.id, { submissionId });
      const differentSubmissionId = SubmissionIdSchema.parse(randomUUID());
      await expect(
        prepare(runs, {
          run,
          workflowProfile: profile(run.id),
          submissionIdentity: {
            submissionId: differentSubmissionId,
            payloadHash: PAYLOAD_HASH,
          },
        }),
      ).rejects.toBeInstanceOf(StorageConflictError);
      expect(await runs.get(run.id)).toBeNull();
    } finally {
      await database.close();
    }
  });
});
