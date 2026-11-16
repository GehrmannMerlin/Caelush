import {
  createTimestampMs,
  type PreparedInputResourceReceiptV1,
  type PreparedWorkflowResourceRefV1,
  type RunWorkflowExecutionProfileV1,
  type WorkflowResourceBindingDraftV1,
} from "@caelush/protocol";
import { createPromptSurfaceEpoch } from "@caelush/agent";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import type { RunRepository } from "../src/repositories/run-repository.js";
import { makeRun, makeSession, makeState, makeStep } from "./support/fixtures.js";

interface ReceiptRunRepository extends RunRepository {
  readPreparedInputReceipts?(
    runId: Parameters<RunRepository["get"]>[0],
  ): Promise<readonly PreparedInputResourceReceiptV1[]>;
}

const HASH = `sha256:${"a".repeat(64)}`;
const OTHER_HASH = `sha256:${"b".repeat(64)}`;

function workflowProfile(runId: ReturnType<typeof makeRun>["id"]): RunWorkflowExecutionProfileV1 {
  return {
    runId,
    profileVersion: 1,
    workflowRendererVersion: "workflow-resource@1",
    catalogSnapshotRef: {
      catalogRevision: "catalog-revision-1",
      artifactRef: `catalog_${runId}`,
      manifestFingerprint: HASH,
    },
  };
}

function workflowBinding(runId: ReturnType<typeof makeRun>["id"]): WorkflowResourceBindingDraftV1 {
  return {
    runId,
    resourceKind: "WORKFLOW_INSTRUCTION",
    resourceId: "review-helper",
    resourceRevision: "revision-1",
    artifactRef: "bundle_review_helper_revision_1",
    sourceFingerprint: HASH,
    utf8Bytes: 128,
    tokenEstimate: 48,
  };
}

function projectedResource(bindingId: string): PreparedWorkflowResourceRefV1 {
  return {
    bindingId,
    artifactRef: "bundle_review_helper_revision_1",
    projectionFingerprint: HASH,
    rendererVersion: "workflow-resource@1",
    fragmentAnchor: HASH,
    utf8Bytes: 128,
    tokenEstimate: 48,
  };
}

async function fixture() {
  const storage = await openCaelushStorage({ path: ":memory:" });
  const session = makeSession();
  const run = makeRun(session.id);
  const step = makeStep(run.id);
  await storage.sessions.insert(session);
  const insertRunWithPreparedResources = storage.runs.insertRunWithPreparedResources;
  if (insertRunWithPreparedResources === undefined) {
    throw new Error("workflow run persistence is unavailable in the test Storage adapter");
  }
  await insertRunWithPreparedResources.call(storage.runs, {
    run,
    workflowProfile: workflowProfile(run.id),
    resourcesInOrder: [workflowBinding(run.id)],
    events: [],
  });
  await storage.promptSurface.createEpoch(
    createPromptSurfaceEpoch({
      runId: run.id,
      epochId: "surface_1",
      formatVersion: 4,
      modelRef: run.model,
      stableHeadFingerprint: HASH,
      toolSchemaFingerprint: HASH,
      cacheSettingsFingerprint: HASH,
      resetReason: "INITIAL",
      createdStepSequence: 1,
      createdAt: run.createdAt,
    }),
  );
  const binding = (await storage.runs.readPreparedResources?.(run.id))?.[0];
  if (binding === undefined) throw new Error("workflow binding fixture was not created");
  const runningRun = {
    ...run,
    status: "RUNNING" as const,
    startedAt: step.startedAt,
    currentStepId: step.id,
  };
  const state = makeState(runningRun, {
    status: "RUNNING",
    startedAt: step.startedAt,
    currentStepId: step.id,
  });
  return { storage, run, step, binding, runningRun, state };
}

async function commitPreparedStep(
  input: Awaited<ReturnType<typeof fixture>>,
  refs: readonly PreparedWorkflowResourceRefV1[],
  toolCatalogFingerprint = HASH,
) {
  return input.storage.execution.commit({
    run: input.runningRun,
    state: input.state,
    expectedStateRevision: null,
    expectedContinuationRevision: null,
    stepWrites: [{ operation: "INSERT", step: input.step }],
    messagesToAppend: [],
    events: [],
    preparedInput: {
      toolCatalogFingerprint,
      preparedResourceRefs: refs,
    },
  } as never);
}

async function commitStepWithoutPreparedInput(input: Awaited<ReturnType<typeof fixture>>) {
  return input.storage.execution.commit({
    run: input.runningRun,
    state: input.state,
    expectedStateRevision: null,
    expectedContinuationRevision: null,
    stepWrites: [{ operation: "INSERT", step: input.step }],
    messagesToAppend: [],
    events: [],
  });
}

function databaseClient(input: Awaited<ReturnType<typeof fixture>>) {
  return (
    input.storage.execution as unknown as {
      database: {
        client: {
          exec(sql: string): void;
          prepare(sql: string): { get(...args: unknown[]): unknown };
        };
      };
    }
  ).database.client;
}

describe("prepared input resource receipts", () => {
  it("writes one body-free receipt with the opening Step and binds the actual tool catalog", async () => {
    const input = await fixture();
    try {
      await commitPreparedStep(input, [projectedResource(input.binding.bindingId)]);

      const repository = input.storage.runs as ReceiptRunRepository;
      expect(repository.readPreparedInputReceipts).toBeTypeOf("function");
      const receipts = await repository.readPreparedInputReceipts?.(input.run.id);
      expect(receipts).toEqual([
        {
          runId: input.run.id,
          stepId: input.step.id,
          bindingId: input.binding.bindingId,
          projectionFingerprint: HASH,
          rendererVersion: "workflow-resource@1",
        },
      ]);
      expect(await input.storage.runs.readWorkflowProfile?.(input.run.id)).toMatchObject({
        toolCatalogFingerprint: HASH,
      });
      expect(JSON.stringify(receipts)).not.toContain("core body");
    } finally {
      await input.storage.close();
    }
  });

  it("rejects a reference that is not bound to this Run before the Step can commit", async () => {
    const input = await fixture();
    try {
      await expect(
        commitPreparedStep(input, [
          { ...projectedResource(input.binding.bindingId), artifactRef: "another_run_artifact" },
        ]),
      ).rejects.toThrow();
      const stepRow = databaseClient(input)
        .prepare("SELECT 1 AS found FROM agent_steps WHERE id = ?")
        .get(input.step.id);
      expect(stepRow).toBeUndefined();
      const repository = input.storage.runs as ReceiptRunRepository;
      expect(await repository.readPreparedInputReceipts?.(input.run.id)).toEqual([]);
      expect(await input.storage.runs.readWorkflowProfile?.(input.run.id)).not.toMatchObject({
        toolCatalogFingerprint: HASH,
      });
    } finally {
      await input.storage.close();
    }
  });

  it("rejects opening a workflow Run Step without the prepared-input fingerprint", async () => {
    const input = await fixture();
    try {
      await expect(commitStepWithoutPreparedInput(input)).rejects.toThrow();
      const stepRow = databaseClient(input)
        .prepare("SELECT 1 AS found FROM agent_steps WHERE id = ?")
        .get(input.step.id);
      expect(stepRow).toBeUndefined();
      expect(await input.storage.runs.readPreparedInputReceipts?.(input.run.id)).toEqual([]);
    } finally {
      await input.storage.close();
    }
  });

  it("rejects an incomplete workflow projection before the Step can commit", async () => {
    const input = await fixture();
    try {
      await expect(commitPreparedStep(input, [])).rejects.toThrow(/every bound workflow/u);
      const stepRow = databaseClient(input)
        .prepare("SELECT 1 AS found FROM agent_steps WHERE id = ?")
        .get(input.step.id);
      expect(stepRow).toBeUndefined();
      const repository = input.storage.runs as ReceiptRunRepository;
      expect(await repository.readPreparedInputReceipts?.(input.run.id)).toEqual([]);
      expect(await input.storage.runs.readWorkflowProfile?.(input.run.id)).not.toMatchObject({
        toolCatalogFingerprint: HASH,
      });
    } finally {
      await input.storage.close();
    }
  });

  it("rejects a Tool catalog fingerprint that differs from the active Prompt Surface", async () => {
    const input = await fixture();
    try {
      await expect(
        commitPreparedStep(input, [projectedResource(input.binding.bindingId)], OTHER_HASH),
      ).rejects.toThrow();
      const stepRow = databaseClient(input)
        .prepare("SELECT 1 AS found FROM agent_steps WHERE id = ?")
        .get(input.step.id);
      expect(stepRow).toBeUndefined();
      expect(await input.storage.runs.readPreparedInputReceipts?.(input.run.id)).toEqual([]);
      expect(await input.storage.runs.readWorkflowProfile?.(input.run.id)).not.toMatchObject({
        toolCatalogFingerprint: OTHER_HASH,
      });
    } finally {
      await input.storage.close();
    }
  });

  it("keeps the first bound Tool catalog fingerprint immutable across later Steps", async () => {
    const input = await fixture();
    try {
      await commitPreparedStep(input, [projectedResource(input.binding.bindingId)]);
      await input.storage.promptSurface.createEpoch(
        createPromptSurfaceEpoch({
          runId: input.run.id,
          epochId: "surface_2",
          formatVersion: 4,
          modelRef: input.run.model,
          stableHeadFingerprint: HASH,
          toolSchemaFingerprint: OTHER_HASH,
          cacheSettingsFingerprint: HASH,
          resetReason: "TOOL_SCHEMA_CHANGED",
          createdStepSequence: 2,
          createdAt: createTimestampMs(101),
        }),
      );
      const nextStep = makeStep(input.run.id, {
        sequence: 2,
        startedAt: createTimestampMs(101),
      });
      const nextRun = { ...input.runningRun, currentStepId: nextStep.id };
      const nextState = {
        ...input.state,
        currentStepId: nextStep.id,
        updatedAt: createTimestampMs(101),
        usage: { ...input.state.usage, steps: 1 },
      };

      await expect(
        input.storage.execution.commit({
          run: nextRun,
          state: nextState,
          expectedStateRevision: 1,
          expectedContinuationRevision: null,
          stepWrites: [
            {
              operation: "UPDATE",
              step: {
                ...input.step,
                status: "COMPLETED",
                finishedAt: createTimestampMs(101),
              },
            },
            { operation: "INSERT", step: nextStep },
          ],
          messagesToAppend: [],
          events: [],
          preparedInput: {
            toolCatalogFingerprint: OTHER_HASH,
            preparedResourceRefs: [projectedResource(input.binding.bindingId)],
          },
        }),
      ).rejects.toThrow(/fingerprint changed/u);

      const client = databaseClient(input);
      expect(
        client.prepare("SELECT status FROM agent_steps WHERE id = ?").get(input.step.id),
      ).toEqual({ status: "RUNNING" });
      expect(
        client.prepare("SELECT 1 AS found FROM agent_steps WHERE id = ?").get(nextStep.id),
      ).toBe(undefined);
      expect(await input.storage.runs.readPreparedInputReceipts?.(input.run.id)).toEqual([
        {
          runId: input.run.id,
          stepId: input.step.id,
          bindingId: input.binding.bindingId,
          projectionFingerprint: HASH,
          rendererVersion: "workflow-resource@1",
        },
      ]);
      expect(await input.storage.runs.readWorkflowProfile?.(input.run.id)).toMatchObject({
        toolCatalogFingerprint: HASH,
      });
    } finally {
      await input.storage.close();
    }
  });

  it("rolls back the Step, profile fingerprint, and receipts when receipt persistence fails", async () => {
    const input = await fixture();
    try {
      const client = databaseClient(input);
      client.exec(
        "CREATE TRIGGER fail_prepared_resource_receipt BEFORE INSERT ON prepared_input_resource_receipts " +
          "BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END",
      );

      await expect(
        commitPreparedStep(input, [projectedResource(input.binding.bindingId)]),
      ).rejects.toThrow();

      const stepRow = client
        .prepare("SELECT 1 AS found FROM agent_steps WHERE id = ?")
        .get(input.step.id) as { found: number } | undefined;
      expect(stepRow).toBeUndefined();
      const repository = input.storage.runs as ReceiptRunRepository;
      expect(await repository.readPreparedInputReceipts?.(input.run.id)).toEqual([]);
      expect(await input.storage.runs.readWorkflowProfile?.(input.run.id)).not.toMatchObject({
        toolCatalogFingerprint: HASH,
      });
    } finally {
      await input.storage.close();
    }
  });
});
