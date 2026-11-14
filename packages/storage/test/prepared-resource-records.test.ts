import {
  type AgentRun,
  type RunId,
  type RunWorkflowExecutionProfileV1,
  type WorkflowResourceBindingDraftV1,
  type WorkflowResourceBindingV1,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteRunRepository } from "../src/repositories/run-repository.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { makeRun, makeSession } from "./support/fixtures.js";

interface PreparedResourceRunRepository {
  insertRunWithPreparedResources?(input: {
    readonly run: AgentRun;
    readonly workflowProfile?: RunWorkflowExecutionProfileV1;
    readonly resourcesInOrder: readonly WorkflowResourceBindingDraftV1[];
    readonly events: readonly [];
  }): Promise<unknown>;
  readPreparedResources?(runId: RunId): Promise<readonly WorkflowResourceBindingV1[]>;
  readWorkflowProfile?(runId: RunId): Promise<RunWorkflowExecutionProfileV1 | null>;
}

function makeProfile(runId: RunId): RunWorkflowExecutionProfileV1 {
  return {
    runId,
    profileVersion: 1,
    workflowRendererVersion: "workflow-renderer@1",
    catalogSnapshotRef: {
      catalogRevision: "catalog-revision-1",
      artifactRef: "catalog_" + runId,
      manifestFingerprint: "a".repeat(64),
    },
  };
}

function makeResource(
  runId: RunId,
  resourceId: string,
  resourceRevision: string,
): WorkflowResourceBindingDraftV1 {
  return {
    runId,
    resourceKind: "WORKFLOW_INSTRUCTION",
    resourceId,
    resourceRevision,
    artifactRef: "bundle_" + resourceId + "_" + resourceRevision,
    sourceFingerprint: "b".repeat(64),
    utf8Bytes: 128,
    tokenEstimate: 32,
  };
}

describe("prepared resource records", () => {
  it("round-trips a generic workflow profile and resources in activation order", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    try {
      await migrateCaelushDatabase(database);
      const sessions = new SqliteSessionRepository(database);
      const runs = new SqliteRunRepository(database);
      const session = makeSession();
      const run = makeRun(session.id);
      await sessions.insert(session);

      const repository = runs as unknown as PreparedResourceRunRepository;
      const insert = repository.insertRunWithPreparedResources;
      if (insert === undefined) {
        expect(
          insert,
          "RunRepository must atomically persist generic workflow resources",
        ).toBeTypeOf("function");
        return;
      }

      await insert.call(runs, {
        run,
        workflowProfile: makeProfile(run.id),
        resourcesInOrder: [
          makeResource(run.id, "resource-alpha", "revision-1"),
          makeResource(run.id, "resource-beta", "revision-2"),
        ],
        events: [],
      });

      expect(repository.readWorkflowProfile).toBeTypeOf("function");
      expect(repository.readPreparedResources).toBeTypeOf("function");
      const profile = await repository.readWorkflowProfile?.(run.id);
      const resources = await repository.readPreparedResources?.(run.id);
      expect(profile).toEqual(makeProfile(run.id));
      expect(
        resources?.map(({ resourceId, activationOrdinal }) => [resourceId, activationOrdinal]),
      ).toEqual([
        ["resource-alpha", 0],
        ["resource-beta", 1],
      ]);
      expect(JSON.stringify(resources)).not.toContain("skillName");
    } finally {
      await database.close();
    }
  });

  it("does not invent workflow profiles for legacy Runs", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    try {
      await migrateCaelushDatabase(database);
      const sessions = new SqliteSessionRepository(database);
      const runs = new SqliteRunRepository(database);
      const session = makeSession();
      const run = makeRun(session.id);
      await sessions.insert(session);
      await runs.insert(run);

      const repository = runs as unknown as PreparedResourceRunRepository;
      expect(repository.readWorkflowProfile).toBeTypeOf("function");
      if (repository.readWorkflowProfile === undefined) return;
      await expect(repository.readWorkflowProfile(run.id)).resolves.toBeNull();
      await expect(repository.readPreparedResources?.(run.id)).resolves.toEqual([]);
    } finally {
      await database.close();
    }
  });
});
