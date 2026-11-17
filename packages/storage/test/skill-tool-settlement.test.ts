import {
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createToolInvocationId,
  type AgentRun,
  type AgentSession,
  type AgentStep,
  type WorkflowResourceBindingDraftV1,
} from "@caelush/protocol";
import {
  completeToolInvocation,
  createRequestedToolInvocation,
  createToolCompletedEvent,
  createToolObservation,
  startToolInvocation,
  ToolResourceBindingRejectedError,
  type ToolExecutionCommit,
} from "@caelush/agent";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteRunRepository } from "../src/repositories/run-repository.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { SqliteRunStateRepository } from "../src/repositories/run-state-repository.js";
import { SqliteStepRepository } from "../src/repositories/step-repository.js";
import { SqliteToolExecutionStore } from "../src/tool-execution-store.js";
import type { CaelushDatabase } from "../src/database.js";
import { makeRun, makeState, makeStep } from "./support/fixtures.js";
import {
  codingEffectsExtension,
  toolSettlementExtensionDecoder,
} from "./support/tool-settlement-decoder.js";

const MARKER = "CONTENT_READY: resource accepted; full content will be prepared for a later step.";

interface Harness {
  readonly database: CaelushDatabase;
  readonly runs: SqliteRunRepository;
  readonly store: SqliteToolExecutionStore;
  readonly run: AgentRun;
  readonly step: AgentStep;
  close(): void;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

async function setup(): Promise<Harness> {
  const database = await openCaelushDatabase({ path: ":memory:" });
  await migrateCaelushDatabase(database);
  const sessions = new SqliteSessionRepository(database);
  const runs = new SqliteRunRepository(database);
  const steps = new SqliteStepRepository(database);
  const states = new SqliteRunStateRepository(database);
  const store = new SqliteToolExecutionStore(database, {
    settlementExtension: toolSettlementExtensionDecoder(),
  });
  const session: AgentSession = {
    id: createSessionId(),
    createdAt: createTimestampMs(100),
    updatedAt: createTimestampMs(100),
    metadata: {},
  };
  const run = makeRun(session.id, {
    status: "RUNNING",
    startedAt: createTimestampMs(101),
  });
  const step = makeStep(run.id, {
    status: "COMPLETED",
    startedAt: createTimestampMs(100),
    finishedAt: createTimestampMs(101),
  });
  await sessions.insert(session);
  await runs.insert(run);
  await steps.insert(step);
  await states.save(makeState(run));
  const harness = { database, runs, store, run, step, close: () => database.close() };
  harnesses.push(harness);
  return harness;
}

function makeBinding(
  run: AgentRun,
  invocationId: ReturnType<typeof createToolInvocationId>,
  resourceId: string,
  tokenEstimate: number,
): WorkflowResourceBindingDraftV1 {
  return {
    runId: run.id,
    resourceKind: "WORKFLOW_INSTRUCTION",
    resourceId,
    resourceRevision: "bundle-revision-1",
    artifactRef: `skill-bundle:${resourceId}`,
    sourceFingerprint: `sha256-${resourceId}-source-v1`,
    utf8Bytes: tokenEstimate * 3,
    tokenEstimate,
    sourceToolInvocationId: invocationId,
  };
}

async function start(h: Harness, name: string) {
  const requested = createRequestedToolInvocation({
    id: createToolInvocationId(),
    runId: h.run.id,
    stepId: h.step.id,
    toolName: "read_skill",
    externalCallId: `call-${name}`,
    args: { skillId: name },
    riskLevel: "LOW",
    createdAt: createTimestampMs(110),
  });
  const first = await h.store.commit({
    sessionId: h.run.sessionId,
    invocation: requested,
    expectedRevision: null,
    events: [],
  });
  const running = startToolInvocation(requested, createTimestampMs(120));
  const second = await h.store.commit({
    sessionId: h.run.sessionId,
    invocation: running,
    expectedRevision: first.snapshot.revision,
    events: [],
  });
  return second.snapshot;
}

function terminalCommit(
  h: Harness,
  snapshot: Awaited<ReturnType<typeof start>>,
  binding: WorkflowResourceBindingDraftV1,
  event = false,
  withEffects = false,
): ToolExecutionCommit {
  const finishedAt = createTimestampMs(130);
  const invocation = completeToolInvocation(snapshot.invocation, finishedAt);
  const observation = createToolObservation({
    id: createObservationId(),
    runId: h.run.id,
    stepId: h.step.id,
    toolInvocationId: invocation.id,
    content: MARKER,
    details: {},
    isError: false,
    createdAt: finishedAt,
  });
  return {
    sessionId: h.run.sessionId,
    invocation,
    expectedRevision: snapshot.revision,
    observation,
    events: event
      ? [
          createToolCompletedEvent({
            eventId: createEventId(),
            sessionId: h.run.sessionId,
            timestamp: finishedAt,
            invocation,
            observationId: observation.id,
            result: { content: MARKER, details: {}, isError: false },
          }),
        ]
      : [],
    // The Phase 05.2 Agent sidecar is data-only; storage must persist it in this same authority tx.
    preparedResourceBindings: [binding],
    ...(withEffects
      ? {
          extension: codingEffectsExtension([
            {
              type: "FILE_CHANGE",
              invocationId: snapshot.invocation.id,
              summary: { path: "src/skill.ts", changeType: "MODIFIED", additions: 1, deletions: 0 },
            },
          ]),
        }
      : {}),
  } as ToolExecutionCommit;
}

describe("atomic Skill resource binding settlement", () => {
  it("commits the binding with terminal invocation and marker observation", async () => {
    const h = await setup();
    const snapshot = await start(h, "frontend-design");
    const binding = makeBinding(h.run, snapshot.invocation.id, "frontend-design", 512);

    await h.store.commit(terminalCommit(h, snapshot, binding));

    expect((await h.store.load(snapshot.invocation.id))?.invocation.status).toBe("COMPLETED");
    expect((await h.store.load(snapshot.invocation.id))?.observation?.content).toBe(MARKER);
    expect(await h.runs.readPreparedResources(h.run.id)).toMatchObject([
      {
        runId: h.run.id,
        resourceKind: "WORKFLOW_INSTRUCTION",
        resourceId: "frontend-design",
        resourceRevision: "bundle-revision-1",
        sourceFingerprint: "sha256-frontend-design-source-v1",
        sourceToolInvocationId: snapshot.invocation.id,
        tokenEstimate: 512,
      },
    ]);
  });

  it("rolls back invocation, observation, binding and event if the final event insert fails", async () => {
    const h = await setup();
    const snapshot = await start(h, "rollback-target");
    const binding = makeBinding(h.run, snapshot.invocation.id, "rollback-target", 512);
    h.database.client.exec(
      `CREATE TRIGGER reject_skill_settlement_event BEFORE INSERT ON agent_events ` +
        `WHEN (SELECT COUNT(*) FROM run_prepared_resources WHERE run_id = '${h.run.id}') = 1 ` +
        "BEGIN SELECT RAISE(ABORT, 'injected skill settlement event failure'); END;",
    );

    await expect(
      h.store.commit(terminalCommit(h, snapshot, binding, true, true)),
    ).rejects.toThrow();

    expect((await h.store.load(snapshot.invocation.id))?.invocation.status).toBe("RUNNING");
    expect((await h.store.load(snapshot.invocation.id))?.observation).toBeUndefined();
    expect(await h.runs.readPreparedResources(h.run.id)).toEqual([]);
    expect(h.database.client.prepare("SELECT COUNT(*) AS count FROM agent_events").get()).toEqual({
      count: 0,
    });
    expect((await new SqliteRunStateRepository(h.database).get(h.run.id))?.changedFiles).toEqual(
      [],
    );
  });

  it("rejects mismatched run or source identity without leaving partial settlement", async () => {
    const h = await setup();
    const snapshot = await start(h, "wrong-identity");
    const binding = makeBinding(h.run, snapshot.invocation.id, "wrong-identity", 512);

    await expect(
      h.store.commit(terminalCommit(h, snapshot, { ...binding, runId: createRunId() })),
    ).rejects.toBeInstanceOf(ToolResourceBindingRejectedError);
    expect((await h.store.load(snapshot.invocation.id))?.invocation.status).toBe("RUNNING");
    expect(await h.runs.readPreparedResources(h.run.id)).toEqual([]);
  });

  it("rejects a binding whose source Tool invocation differs from the committing invocation", async () => {
    const h = await setup();
    const snapshot = await start(h, "wrong-source-invocation");
    const binding = makeBinding(h.run, createToolInvocationId(), "wrong-source-invocation", 512);

    await expect(h.store.commit(terminalCommit(h, snapshot, binding))).rejects.toBeInstanceOf(
      ToolResourceBindingRejectedError,
    );
    expect((await h.store.load(snapshot.invocation.id))?.invocation.status).toBe("RUNNING");
    expect(await h.runs.readPreparedResources(h.run.id)).toEqual([]);
  });

  it("rejects an unknown resource kind without leaving partial settlement", async () => {
    const h = await setup();
    const snapshot = await start(h, "unknown-resource-kind");
    const binding = makeBinding(h.run, snapshot.invocation.id, "unknown-resource-kind", 512);

    await expect(
      h.store.commit(
        terminalCommit(h, snapshot, {
          ...binding,
          resourceKind: "UNTRUSTED_RESOURCE",
        } as unknown as WorkflowResourceBindingDraftV1),
      ),
    ).rejects.toBeInstanceOf(ToolResourceBindingRejectedError);
    expect((await h.store.load(snapshot.invocation.id))?.invocation.status).toBe("RUNNING");
    expect((await h.store.load(snapshot.invocation.id))?.observation).toBeUndefined();
    expect(await h.runs.readPreparedResources(h.run.id)).toEqual([]);
  });

  it("treats a same-version reread as idempotent and retains the original binding", async () => {
    const h = await setup();
    const first = await start(h, "same-version-a");
    const second = await start(h, "same-version-b");
    const initial = makeBinding(h.run, first.invocation.id, "same-version", 512);
    const reread = makeBinding(h.run, second.invocation.id, "same-version", 512);

    await h.store.commit(terminalCommit(h, first, initial));
    await h.store.commit(terminalCommit(h, second, reread));

    const active = await h.runs.readPreparedResources(h.run.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.sourceToolInvocationId).toBe(first.invocation.id);
  });

  it("rechecks aggregate budget under concurrent commits and keeps an in-budget winner", async () => {
    const h = await setup();
    const first = await start(h, "budget-a");
    const second = await start(h, "budget-b");
    const commits = [
      terminalCommit(h, first, makeBinding(h.run, first.invocation.id, "budget-a", 9_000)),
      terminalCommit(h, second, makeBinding(h.run, second.invocation.id, "budget-b", 9_000)),
    ];

    const results = await Promise.allSettled(commits.map((commit) => h.store.commit(commit)));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const active = await h.runs.readPreparedResources(h.run.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.tokenEstimate).toBe(9_000);
  });
});
