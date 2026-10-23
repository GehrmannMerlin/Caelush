import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, RunExecutionCommit, RunExecutionStorePort } from "@caelush/agent";
import {
  createModelToolFeedbackProjector,
  createToolResultBatchNormalizer,
  DefaultAgentToolRegistryBuilder,
} from "@caelush/agent";
import type { AIModelTurnResult } from "@caelush/ai";
import { RunController, RunRetryRegistry, toContextObservationProjection } from "@caelush/core";
import {
  AgentRunSchema,
  createEventId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  type ContextBudgetPolicySnapshot,
  type DurableRunEvent,
  type RunId,
  type StepId,
} from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { CaelushStorage } from "../src/index.js";
import { openCaelushStorage } from "../src/index.js";
import { createCanonicalToolRuntime } from "./support/canonical-tool-runtime.js";
import {
  makeRun,
  makeSession,
  createStorageTestCompletionAssembly,
  verificationPlanner,
} from "./support/fixtures.js";
import { modelTurnResult } from "./support/model-turns.js";
import {
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
} from "./support/run-agent-execution.js";
import { projectedRunMessages } from "./support/projected-run-messages.js";
import { testRunMessageAuthority } from "../../core/test/support/run-message-authority.js";

const TRUNCATED_TEXT = "PRIVATE_TRUNCATED_ASSISTANT_OUTPUT";
const INITIAL_OUTPUT_TOKENS = 100;
const outputRecoveryPolicy = {
  version: "TURN_BUDGET_V3",
  algorithm: "HEADROOM_V1",
  minOutputTokens: 1_024,
  preferredOutputTokens: 16_384,
  safetyTokens: 2_048,
  expectedGrowthTokens: 4_096,
  postCompactionRatio: 0.5,
  outputRecovery: {
    version: "OUTPUT_RECOVERY_V1",
    maxRecoveryTurns: 1,
    outputMultiplier: 2,
  },
} satisfies ContextBudgetPolicySnapshot;

let temporaryDirectory: string | undefined;
const openStores: CaelushStorage[] = [];

afterEach(async () => {
  for (const storage of openStores.splice(0)) await storage.close().catch(() => undefined);
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

function usage(outputTokens: number) {
  return { inputTokens: 10, outputTokens, totalTokens: 10 + outputTokens };
}

function completedTurn(
  text: string,
  finishReason: AIModelTurnResult["finishReason"],
  outputTokens: number,
  toolCalls: AIModelTurnResult["toolCalls"] = [],
) {
  return modelTurnResult({ text, finishReason, toolCalls, usage: usage(outputTokens) });
}

function makeOutputRecoveryRun(workspacePath: string) {
  const session = makeSession();
  const run = AgentRunSchema.parse(
    makeRun(session.id, {
      goal: "exercise durable output recovery",
      status: "PENDING",
      workspace: { id: createWorkspaceId(), path: workspacePath },
      model: { provider: "fixture", model: "fixture-model" },
      completionContract: "NATURAL_V1",
      contextBudgetPolicy: outputRecoveryPolicy,
      limits: { maxSteps: 12, maxToolCalls: 8, timeoutMs: 60_000, maxTokens: 1_000 },
    }),
  );
  return { session, run };
}

async function openRunStorage(
  databasePath: string,
  seed?: ReturnType<typeof makeOutputRecoveryRun>,
) {
  const storage = await openCaelushStorage({ path: databasePath });
  openStores.push(storage);
  if (seed !== undefined) {
    await storage.sessions.insert(seed.session);
    await storage.runs.insert(seed.run);
  }
  return storage;
}

function createNotifier(storage: CaelushStorage) {
  const events: DurableRunEvent[] = [];
  const commitVisibleSequences: Promise<{ sequence: number; latest: number }>[] = [];
  return {
    events,
    commitVisibleSequences,
    notifyCommitted(committed: readonly DurableRunEvent[]) {
      events.push(...committed);
      for (const event of committed) {
        commitVisibleSequences.push(
          storage.eventReader.latestSequence(event.runId).then((latest) => ({
            sequence: event.durability.sequence,
            latest,
          })),
        );
      }
    },
    emitTransient() {},
  };
}

function createRecoveryTool(effectCalls: string[]): AgentTool {
  return {
    name: "record_effect",
    description: "Record one fixture effect.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    label: "Record effect",
    resultDetailsSchema: { type: "object", properties: {}, additionalProperties: false },
    executionMode: "SEQUENTIAL",
    scheduling: { class: "MAY_MUTATE" },
    async execute({ identity }) {
      effectCalls.push(identity.externalCallId);
      return { content: "effect recorded", details: {}, isError: false };
    },
  };
}

function createToolRuntime(
  storage: CaelushStorage,
  effectCalls: string[],
  notifier: ReturnType<typeof createNotifier>,
) {
  const registryBuilder = new DefaultAgentToolRegistryBuilder();
  registryBuilder.register(createRecoveryTool(effectCalls));
  const registry = registryBuilder.build();
  const runtime = createCanonicalToolRuntime({ storage, registry, notifier });
  return {
    registry,
    toolTurn: {
      batches: runtime.batch,
      feedback: createModelToolFeedbackProjector({ projection: toContextObservationProjection() }),
      normalizer: createToolResultBatchNormalizer(),
      modelSpecs: () => registry.modelSpecs(),
    },
  };
}

function createController(
  storage: CaelushStorage,
  executor: ReturnType<typeof fakeFrozenModelTurnExecutor>,
  options: {
    readonly toolRuntime?: ReturnType<typeof createToolRuntime>;
    readonly tools?: Parameters<typeof testRunAgentExecution>[0]["tools"];
    readonly now?: number;
    readonly executionStore?: RunExecutionStorePort;
  } = {},
) {
  let currentTime = options.now ?? 5_000;
  const clock = { now: () => createTimestampMs(++currentTime) };
  const baseExecution = testRunAgentExecution({
    executor,
    ...(options.toolRuntime === undefined
      ? {}
      : { tools: options.toolRuntime.registry.modelSpecs() }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    createStepId: () => createStepId(),
  }).factory;
  const agentExecution = {
    async resolve(run: Parameters<typeof baseExecution.resolve>[0]) {
      return await baseExecution.resolve(run);
    },
  };
  const notifier = createNotifier(storage);
  const retryRegistry = new RunRetryRegistry({
    clock,
    timer: { schedule: () => ({ cancel() {} }) },
  });
  const controller = new RunController({
    agentExecution,
    executionStore: options.executionStore ?? storage.execution,
    completionStore: storage.execution,
    messages: testRunMessageAuthority({
      records: (runId) => storage.messageRecords.listByRun(runId),
    }),
    events: notifier,
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "synthetic fixture context",
        contextLimits: { maxInputTokens: 100_000 },
      }),
    },
    clock,
    eventIdFactory: { create: createEventId },
    completion: createStorageTestCompletionAssembly(storage, clock),
    verificationPlanner,
    budget: storage.budget,
    // Reserve from a deliberately conservative estimate for the ordinary turn, then a smaller
    // estimate for the admitted recovery cap. Settlement still records the executor's actual usage
    // into Storage's real budget ledger.
    tokenEstimator: {
      estimate(request) {
        if (
          request.settings?.maxOutputTokens !== undefined &&
          request.settings.maxOutputTokens > INITIAL_OUTPUT_TOKENS
        ) {
          return 100;
        }
        return executor.callCount() >= 2 ? 100 : 900;
      },
    },
    resourceGovernance: storage.resourceGovernance,
    progressPersistence: storage.execution,
    approvals: storage.approvals,
    retryRegistry,
    ...(options.toolRuntime === undefined ? {} : { toolTurn: options.toolRuntime.toolTurn }),
  });
  return { controller, notifier, retryRegistry };
}

function outputToolCall(id: string) {
  return { id, name: "record_effect", input: {} };
}

function isRecoveryOpenCommit(command: RunExecutionCommit): boolean {
  const recovery = command.state?.modelOutputRecovery;
  return (
    recovery?.phase === "OPENED" &&
    recovery.recoveryStepId !== undefined &&
    command.stepWrites.some(
      (write) => write.operation === "INSERT" && write.step.id === recovery.recoveryStepId,
    )
  );
}

describe("RunController SQLite output recovery restart boundaries", () => {
  it("reopens one RESERVED recovery after restart without replaying the Tool effect or truncated answer", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "caelush-output-recovery-r9-"));
    const databasePath = join(temporaryDirectory, "caelush.sqlite");
    const seeded = makeOutputRecoveryRun(join(temporaryDirectory, "workspace"));
    const firstStorage = await openRunStorage(databasePath, seeded);
    const effectCalls: string[] = [];
    const firstNotifier = createNotifier(firstStorage);
    const executor = fakeFrozenModelTurnExecutor((_request, _signal, callIndex) => {
      if (callIndex === 0) {
        return completedTurn("run the effect once", "TOOL_CALLS", 24, [
          outputToolCall("call_effect"),
        ]);
      }
      if (callIndex === 1) {
        // A LENGTH response may carry a parseable tool request, but it is not an executable result.
        return completedTurn(TRUNCATED_TEXT, "LENGTH", 66, [outputToolCall("truncated_decoy")]);
      }
      return completedTurn("recovered final answer", "STOP", 74);
    });
    const firstRuntime = createToolRuntime(firstStorage, effectCalls, firstNotifier);
    const first = createController(firstStorage, executor, { toolRuntime: firstRuntime });

    const waiting = await first.controller.start(seeded.run.id);
    expect(waiting.status).toBe("WAITING_RETRY");
    const reserved = await firstStorage.execution.load(seeded.run.id);
    expect(reserved?.state?.modelOutputRecovery).toMatchObject({ phase: "RESERVED" });
    expect(reserved?.continuation).toMatchObject({
      type: "WAITING_RETRY",
      errorCode: "LLM_OUTPUT_TRUNCATED",
      mode: "TOOL_RESULTS",
    });
    expect(reserved?.activeStep).toBeUndefined();
    expect(reserved?.run.currentStepId).toBeUndefined();
    if (reserved?.continuation?.type !== "WAITING_RETRY") {
      throw new Error("missing persisted WAITING_RETRY continuation");
    }
    expect(reserved.continuation.failedStepId).toBe(
      reserved.state?.modelOutputRecovery?.sourceStepId,
    );
    expect(effectCalls).toEqual(["call_effect"]);
    expect(await firstStorage.toolInvocations.listByRun(seeded.run.id)).toHaveLength(1);
    expect(await firstStorage.observations.listByRun(seeded.run.id)).toHaveLength(1);
    expect(JSON.stringify(await projectedRunMessages(firstStorage, seeded.run.id))).not.toContain(
      TRUNCATED_TEXT,
    );
    expect(
      (await firstStorage.messageRecords.listByRun(seeded.run.id)).map(
        ({ messageType }) => messageType,
      ),
    ).toEqual(["USER", "ASSISTANT", "TOOL_RESULT"]);
    const failedStepId = reserved?.state?.modelOutputRecovery?.sourceStepId;
    if (failedStepId === undefined) throw new Error("missing truncated source Step ID");
    const truncatedReplayRows = firstStorage.messageRecords.database.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM private_replays AS replay
         INNER JOIN agent_messages AS message ON message.message_id = replay.message_id
         WHERE message.run_id = ? AND message.source_step_id = ?`,
      )
      .get(seeded.run.id, failedStepId) as { count: number };
    expect(truncatedReplayRows.count).toBe(0);
    expect(
      first.notifier.events.find(
        (event) => event.type === "retry.scheduled" && event.schemaVersion === 2,
      )?.payload,
    ).toMatchObject({
      attempt: 2,
      maxAttempts: 2,
      errorCode: "LLM_OUTPUT_TRUNCATED",
    });
    const firstControllerNotifications = await Promise.all(first.notifier.commitVisibleSequences);
    const firstToolNotifications = await Promise.all(firstNotifier.commitVisibleSequences);
    expect(
      [...firstControllerNotifications, ...firstToolNotifications].every(
        ({ sequence, latest }) => latest >= sequence,
      ),
    ).toBe(true);
    await closeStorage(firstStorage);

    const secondStorage = await openRunStorage(databasePath);
    const secondNotifier = createNotifier(secondStorage);
    const secondRuntime = createToolRuntime(secondStorage, effectCalls, secondNotifier);
    const second = createController(secondStorage, executor, {
      toolRuntime: secondRuntime,
      now: 10_000,
    });
    const final = await second.controller.recover(seeded.run.id);

    expect(final.status).toBe("TERMINAL");
    if (final.status !== "TERMINAL") throw new Error("recovery should complete the Run");
    expect(final.run.status).toBe("COMPLETED");
    expect(executor.callCount()).toBe(3);
    expect(executor.requests[2]?.settings?.maxOutputTokens).toBe(132);
    expect(effectCalls).toEqual(["call_effect"]);
    expect(await secondStorage.toolInvocations.listByRun(seeded.run.id)).toHaveLength(1);
    expect(await secondStorage.observations.listByRun(seeded.run.id)).toHaveLength(1);
    expect(
      (await secondStorage.execution.load(seeded.run.id))?.state?.modelOutputRecovery,
    ).toMatchObject({
      phase: "OPENED",
      sourceStepId: reserved?.state?.modelOutputRecovery?.sourceStepId,
    });
    const messages = await projectedRunMessages(secondStorage, seeded.run.id);
    expect(messages.map(({ role }) => role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(JSON.stringify(messages)).not.toContain(TRUNCATED_TEXT);
    expect(JSON.stringify(executor.requests[2]?.messages)).not.toContain(TRUNCATED_TEXT);

    const events = await secondStorage.eventReader.replay(seeded.run.id, {
      afterSequence: 0,
      throughSequence: Number.MAX_SAFE_INTEGER,
      limit: 200,
    });
    expect(events.map(({ durability }) => durability.sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(
      events.filter((event) => event.type === "retry.scheduled" && event.schemaVersion === 2),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "retry.started")).toHaveLength(1);
    const ledger = await secondStorage.budgetLedger.listByRun(seeded.run.id);
    expect(ledger.filter(({ kind }) => kind === "LLM_ATTEMPT")).toHaveLength(3);
    expect(
      ledger.filter(({ kind, state }) => kind === "LLM_ATTEMPT" && state !== "SETTLED"),
    ).toEqual([]);
    expect(
      ledger
        .filter(({ kind }) => kind === "LLM_ATTEMPT")
        .map(({ actualInputTokens, actualOutputTokens }) => [
          actualInputTokens,
          actualOutputTokens,
        ]),
    ).toEqual([
      [10, 24],
      [10, 66],
      [10, 74],
    ]);
    const settledState = await secondStorage.execution.load(seeded.run.id);
    expect(settledState?.state?.usage.inputTokens).toBe(30);
    expect(settledState?.state?.usage.outputTokens).toBe(164);
    const notified = await Promise.all(secondNotifier.commitVisibleSequences);
    expect(notified.every(({ sequence, latest }) => latest >= sequence)).toBe(true);
  });

  it("rolls back a failed v2 schedule commit and keeps usage settlement idempotent", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "caelush-output-recovery-rollback-"));
    const seeded = makeOutputRecoveryRun(join(temporaryDirectory, "workspace"));
    const storage = await openRunStorage(join(temporaryDirectory, "caelush.sqlite"), seeded);
    const executor = fakeFrozenModelTurnExecutor(() =>
      completedTurn(TRUNCATED_TEXT, "LENGTH", INITIAL_OUTPUT_TOKENS),
    );
    const { controller } = createController(storage, executor);
    storage.messageRecords.database.client.exec(`
      CREATE TRIGGER reject_output_recovery_schedule
      BEFORE INSERT ON agent_events
      WHEN NEW.event_type = 'retry.scheduled' AND NEW.event_schema_version = 2
      BEGIN SELECT RAISE(ABORT, 'injected R9 recovery schedule failure'); END;
    `);

    await expect(controller.start(seeded.run.id)).rejects.toThrow();
    const snapshot = await storage.execution.load(seeded.run.id);
    expect(snapshot?.state?.modelOutputRecovery).toBeUndefined();
    expect(snapshot?.continuation).toBeUndefined();
    expect(snapshot?.activeStep?.status).toBe("RUNNING");
    expect(snapshot?.run.currentStepId).toBe(snapshot?.activeStep?.id);
    const committedEvents = await storage.eventReader.replay(seeded.run.id, {
      afterSequence: 0,
      throughSequence: Number.MAX_SAFE_INTEGER,
      limit: 100,
    });
    expect(
      committedEvents.some(
        (event) => event.type === "retry.scheduled" && event.schemaVersion === 2,
      ),
    ).toBe(false);
    expect(committedEvents.some((event) => event.type === "llm.failed")).toBe(false);
    expect(committedEvents.map(({ durability }) => durability.sequence)).toEqual(
      Array.from({ length: committedEvents.length }, (_, index) => index + 1),
    );
    expect(await storage.eventReader.latestSequence(seeded.run.id)).toBe(committedEvents.length);

    const llmEntry = (await storage.budgetLedger.listByRun(seeded.run.id)).find(
      ({ kind }) => kind === "LLM_ATTEMPT",
    );
    expect(llmEntry).toMatchObject({
      state: "SETTLED",
      actualInputTokens: 10,
      actualOutputTokens: 100,
    });
    const before = await storage.budgetLedger.snapshot(seeded.run.id);
    await storage.budget.settleLLM({
      runId: seeded.run.id,
      stepId: llmEntry!.ownerId as StepId,
      usage: usage(INITIAL_OUTPUT_TOKENS),
      settledAt: createTimestampMs(20_000),
    });
    expect(await storage.budgetLedger.snapshot(seeded.run.id)).toEqual(before);
  });

  it("fails closed after an OPENED commit survives a crash before Provider I/O", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "caelush-output-recovery-open-crash-"));
    const databasePath = join(temporaryDirectory, "caelush.sqlite");
    const seeded = makeOutputRecoveryRun(join(temporaryDirectory, "workspace"));
    const firstStorage = await openRunStorage(databasePath, seeded);
    const executor = fakeFrozenModelTurnExecutor((_request, _signal, callIndex) =>
      callIndex === 0
        ? completedTurn(TRUNCATED_TEXT, "LENGTH", INITIAL_OUTPUT_TOKENS)
        : completedTurn("must not be sent", "STOP", 20),
    );
    const first = createController(firstStorage, executor);
    expect((await first.controller.start(seeded.run.id)).status).toBe("WAITING_RETRY");

    let failedAfterCommit = false;
    const crashAfterOpen: RunExecutionStorePort = {
      load: (runId: RunId) => firstStorage.execution.load(runId),
      requestCancellation: (runId, intent) =>
        firstStorage.execution.requestCancellation(runId, intent),
      async commit(command) {
        const committed = await firstStorage.execution.commit(command);
        if (!failedAfterCommit && isRecoveryOpenCommit(command)) {
          failedAfterCommit = true;
          throw new Error("simulated process crash after OPENED commit");
        }
        return committed;
      },
    };
    const second = createController(firstStorage, executor, {
      now: 10_000,
      executionStore: crashAfterOpen,
    });
    await expect(second.controller.recover(seeded.run.id)).rejects.toThrow();
    expect(failedAfterCommit).toBe(true);
    expect(executor.callCount()).toBe(1);
    const opened = await firstStorage.execution.load(seeded.run.id);
    expect(opened?.state?.modelOutputRecovery).toMatchObject({ phase: "OPENED" });
    expect(opened?.activeStep).toMatchObject({ status: "RUNNING" });
    expect(opened?.activeStepProviderStarted).toBe(true);
    await closeStorage(firstStorage);

    const restartedStorage = await openRunStorage(databasePath);
    const restarted = createController(restartedStorage, executor, { now: 20_000 });
    const failed = await restarted.controller.recover(seeded.run.id);
    expect(failed.status).toBe("FAILED");
    expect(executor.callCount()).toBe(1);
    const finalSnapshot = await restartedStorage.execution.load(seeded.run.id);
    expect(finalSnapshot?.state?.modelOutputRecovery).toMatchObject({ phase: "OPENED" });
    expect(finalSnapshot?.continuation).toBeUndefined();
    const events = await restartedStorage.eventReader.replay(seeded.run.id, {
      afterSequence: 0,
      throughSequence: Number.MAX_SAFE_INTEGER,
      limit: 100,
    });
    expect(
      events.filter((event) => event.type === "retry.scheduled" && event.schemaVersion === 2),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "retry.started")).toHaveLength(1);
    expect(events.some((event) => event.type === "retry.exhausted")).toBe(false);
    const postCrashNotifications = await Promise.all(restarted.notifier.commitVisibleSequences);
    expect(postCrashNotifications.every(({ sequence, latest }) => latest >= sequence)).toBe(true);
  });

  it("keeps the one recovery allowance spent after a successful recovery and later LENGTH", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "caelush-output-recovery-second-length-"));
    const databasePath = join(temporaryDirectory, "caelush.sqlite");
    const seeded = makeOutputRecoveryRun(join(temporaryDirectory, "workspace"));
    const firstStorage = await openRunStorage(databasePath, seeded);
    const passiveTool = {
      name: "read_file",
      description: "Read a file.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    } as const;
    const executor = fakeFrozenModelTurnExecutor((_request, _signal, callIndex) => {
      if (callIndex === 0) return completedTurn(TRUNCATED_TEXT, "LENGTH", INITIAL_OUTPUT_TOKENS);
      if (callIndex === 1) {
        return completedTurn("request external read", "TOOL_CALLS", 20, [
          { id: "external-read", name: "read_file", input: {} },
        ]);
      }
      return completedTurn(TRUNCATED_TEXT, "LENGTH", 760, [
        { id: "second-truncated-tool", name: "read_file", input: {} },
      ]);
    });
    const first = createController(firstStorage, executor, { tools: [passiveTool] });
    expect((await first.controller.start(seeded.run.id)).status).toBe("WAITING_RETRY");
    const recoveredBoundary = await first.controller.recover(seeded.run.id);
    expect(recoveredBoundary.status).toBe("WAITING_TOOL_RESULTS");
    expect(executor.callCount()).toBe(2);
    expect(executor.requests[1]?.settings?.maxOutputTokens).toBe(INITIAL_OUTPUT_TOKENS * 2);
    await closeStorage(firstStorage);

    const secondStorage = await openRunStorage(databasePath);
    const restarted = createController(secondStorage, executor, {
      now: 10_000,
      tools: [passiveTool],
    });
    expect((await restarted.controller.recover(seeded.run.id)).status).toBe("WAITING_TOOL_RESULTS");
    const result = await restarted.controller.submitToolResults(seeded.run.id, [
      {
        role: "tool",
        toolCallId: "external-read",
        toolName: "read_file",
        content: "file contents",
        isError: false,
      },
    ]);
    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") throw new Error("a second LENGTH must fail closed");
    expect(result.run.status).toBe("FAILED");
    expect(executor.callCount()).toBe(3);
    const finalSnapshot = await secondStorage.execution.load(seeded.run.id);
    expect(finalSnapshot?.state?.modelOutputRecovery).toMatchObject({
      phase: "OPENED",
      targetOutputTokens: INITIAL_OUTPUT_TOKENS * 2,
    });
    expect(finalSnapshot?.continuation).toBeUndefined();
    const events = await secondStorage.eventReader.replay(seeded.run.id, {
      afterSequence: 0,
      throughSequence: Number.MAX_SAFE_INTEGER,
      limit: 100,
    });
    expect(
      events.filter((event) => event.type === "retry.scheduled" && event.schemaVersion === 2),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "retry.started")).toHaveLength(1);
    expect(events.some((event) => event.type === "retry.exhausted")).toBe(false);
    const messages = await projectedRunMessages(secondStorage, seeded.run.id);
    expect(messages.map(({ role }) => role)).toEqual(["user", "assistant", "tool"]);
    expect(JSON.stringify(messages)).not.toContain(TRUNCATED_TEXT);
    const messageRecords = await secondStorage.messageRecords.listByRun(seeded.run.id);
    expect(messageRecords.map(({ messageType }) => messageType)).toEqual([
      "USER",
      "ASSISTANT",
      "TOOL_RESULT",
    ]);
  });
});

async function closeStorage(storage: CaelushStorage): Promise<void> {
  const index = openStores.indexOf(storage);
  if (index >= 0) openStores.splice(index, 1);
  await storage.close();
}
