import {
  createRunTransitionPlanner,
  type RunExecutionCommit,
  type RunTransitionPlanInput,
} from "@caelush/agent";
import {
  RunController,
  RunControllerInfrastructureError,
  RunExecutionConflictError,
  RunRetryRegistry,
  createRunCommitEventMaterializer,
  type AIModelTurnResult,
  type RunCommitEventMaterializerInput,
  type RunCandidateBoundaryCommit,
  type RunCompletionPersistencePort,
  type RunExecutionStore,
  type RunVerifiedCompletionCommit,
} from "@caelush/core";
import { EventBus } from "@caelush/events";
import {
  AgentRunSchema,
  createEventId,
  createLLMCallId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  type RunId,
  type VerificationPlanId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { verificationPlanner } from "./support/fixtures.js";
import { modelTurnResult, aiError } from "./support/model-turns.js";
import {
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
} from "./support/run-agent-execution.js";
import { testRunMessageAuthority } from "../../core/test/support/run-message-authority.js";
import { projectedRunMessages } from "./support/projected-run-messages.js";

/**
 * The production Agent effect cutover, asserted against the real RunController.
 *
 * What is being proved is not that a Run reaches the right status — the existing suites already
 * cover that — but *which authority* moved it. A spy around the frozen planner and the event
 * materializer makes that observable: a branch is cut over exactly when the planner planned it, and
 * it is a compatibility bridge exactly when the planner was never called.
 */

/* ------------------------------------------------------------------- spies */

interface PlannerSpy {
  readonly planner: ReturnType<typeof createRunTransitionPlanner>;
  readonly inputs: RunTransitionPlanInput[];
  readonly commits: RunExecutionCommit[];
}

function spyPlanner(): PlannerSpy {
  const planner = createRunTransitionPlanner();
  const inputs: RunTransitionPlanInput[] = [];
  const commits: RunExecutionCommit[] = [];
  return {
    inputs,
    commits,
    planner: {
      plan: (input) => {
        inputs.push(input);
        const commit = planner.plan(input);
        commits.push(commit);
        return commit;
      },
    },
  };
}

interface MaterializerSpy {
  readonly materializer: ReturnType<typeof createRunCommitEventMaterializer>;
  readonly inputs: RunCommitEventMaterializerInput[];
}

function spyMaterializer(order: string[]): MaterializerSpy {
  const materializer = createRunCommitEventMaterializer();
  const inputs: RunCommitEventMaterializerInput[] = [];
  return {
    inputs,
    materializer: {
      materialize: (input) => {
        inputs.push(input);
        order.push("materialize");
        return materializer.materialize(input);
      },
    },
  };
}

/* ----------------------------------------------------------------- fixtures */

function makeRun(maxSteps = 4) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps, maxToolCalls: 4, timeoutMs: 10_000 },
    createdAt: createTimestampMs(1),
  });
}

function toolTurn(text = "inspect") {
  return modelTurnResult({
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text,
    toolCalls: [{ id: "call_a", name: "read_file", input: { path: "parser.ts" } }],
    finishReason: "TOOL_CALLS",
  });
}

function finalTurn(text = "answer") {
  return modelTurnResult({
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text,
    toolCalls: [],
    finishReason: "STOP",
  });
}

interface SetupOptions {
  readonly maxSteps?: number;
  readonly complete: (count: number, signal: AbortSignal) => Promise<AIModelTurnResult>;
  readonly store?: (storage: Awaited<ReturnType<typeof openCaelushStorage>>) => RunExecutionStore;
}

async function setup(options: SetupOptions) {
  const storage = await openCaelushStorage({ path: ":memory:" });
  const run = makeRun(options.maxSteps);
  await storage.sessions.insert({
    id: run.sessionId,
    createdAt: createTimestampMs(1),
    updatedAt: createTimestampMs(1),
    metadata: {},
  } as never);
  await storage.runs.insert(run);

  const eventBus = new EventBus(storage.events);
  const events: { type: string }[] = [];
  eventBus.subscribe(run.id, (event) => events.push({ type: event.type }));

  const clockState = { value: 10 };
  const planner = spyPlanner();
  // The settlement order is recorded in one sequence so PLAN -> MATERIALIZE -> COMMIT -> NOTIFY is
  // observable as a single fact rather than inferred from three separate counters.
  const order: string[] = [];
  const materializer = spyMaterializer(order);
  let count = 0;

  const store = options.store?.(storage) ?? storage.execution;
  // The same durable store implements the Core-private completion persistence port; the fixture
  // reads it through that contract rather than through a verification-shaped store extension.
  const completion = storage.execution as unknown as RunCompletionPersistencePort;
  // Phase 3E: the Run Layer names a general execution store and a Core-private completion
  // persistence port. The real store implements both, and this fixture only observes the *order* in
  // which the Run Layer commits and notifies.
  const instrumented: RunExecutionStore = {
    load: (runId: RunId) => store.load(runId),
    requestCancellation: (runId: RunId, intent: Parameters<typeof store.requestCancellation>[1]) =>
      store.requestCancellation(runId, intent),
    commit: async (command: Parameters<typeof store.commit>[0]) => {
      order.push("commit");
      const result = await store.commit(command);
      order.push("notify");
      return result;
    },
  };
  const completionStore: RunCompletionPersistencePort = {
    loadVerificationPlan: (runId, planId) => completion.loadVerificationPlan(runId, planId),
    commitCandidateBoundary: async (command) => {
      order.push("commit");
      const result = await completion.commitCandidateBoundary(command);
      order.push("notify");
      return result;
    },
    commitVerifiedCompletion: async (command) => {
      order.push("commit");
      const result = await completion.commitVerifiedCompletion(command);
      order.push("notify");
      return result;
    },
  };

  // The Run Layer composes the frozen AgentLoop itself from these collaborator ports, so the
  // scripted provider turn is the only model authority this fixture hands it.
  const agentExecution = testRunAgentExecution({
    executor: fakeFrozenModelTurnExecutor(async (_request, signal) => {
      count += 1;
      return options.complete(count, signal);
    }),
    createStepId: () => createStepId(),
  });

  const controller = new RunController({
    agentExecution: agentExecution.factory,
    executionStore: instrumented,
    messages: testRunMessageAuthority(),
    completionStore,
    events: eventBus,
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "synthetic",
        contextLimits: { maxInputTokens: 1000 },
      }),
    },
    clock: { now: () => createTimestampMs(clockState.value++) },
    eventIdFactory: { create: () => createEventId() },
    verificationPlanner,
    transitionPlanner: planner.planner,
    eventMaterializer: materializer.materializer,
  });

  return {
    storage,
    run,
    controller,
    events,
    planner,
    materializer,
    /** Every durable step, in the order it happened. */
    order,
    providerCalls: () => count,
    setNow: (value: number) => {
      clockState.value = value;
    },
  };
}

/* ---------------------------------------------------------------- the tests */

describe("production Agent effect cutover", () => {
  it("plans a canonical TOOL_REQUESTS settlement instead of hand-writing it", async () => {
    const fixture = await setup({ complete: async () => toolTurn() });
    const waiting = await fixture.controller.start(fixture.run.id);

    expect(waiting.status).toBe("WAITING_TOOL_RESULTS");
    // Exactly one plan and one materialization, and the settlement order is PLAN, MATERIALIZE,
    // COMMIT, NOTIFY for the transition the planner produced.
    expect(fixture.planner.inputs).toHaveLength(1);
    expect(fixture.materializer.inputs).toHaveLength(1);
    expect(fixture.order.slice(-3)).toEqual(["materialize", "commit", "notify"]);

    // The directive is the coordinator's, not a value re-derived from the legacy epoch.
    expect(fixture.planner.inputs[0]?.directive).toMatchObject({
      kind: "ADVANCE_AGENT",
      reason: "INITIAL",
    });
    const effect = fixture.planner.inputs[0]?.effect;
    expect(effect?.kind).toBe("AGENT");
    if (effect?.kind !== "AGENT") throw new Error("expected an AGENT effect");
    expect(effect.result.kind).toBe("TOOL_REQUESTS");

    // The planner planned the transition, so the commit is the planner's.
    const planned = fixture.planner.commits[0]!;
    expect(planned.events).toEqual([]);
    expect(planned.stepWrites.map((write) => write.operation)).toEqual(["UPDATE"]);
    expect(planned.stepWrites[0]?.step.status).toBe("COMPLETED");
    // The frozen planner owns the state transition but not the semantic message materialization.
    expect(planned.messagesToAppend).toEqual([]);
    // The Core settlement adds exactly the assistant message for the completed provider turn; the
    // user message was durably written in the PENDING -> RUNNING checkpoint before the provider.
    expect(
      fixture.materializer.inputs[0]?.plannedCommit.messagesToAppend.map(
        (entry) => entry.draft.messageType,
      ),
    ).toEqual(["ASSISTANT"]);
    expect(planned.continuation?.operation).toBe("SET");

    const snapshot = await fixture.storage.execution.load(fixture.run.id);
    expect(snapshot?.run.status).toBe("RUNNING");
    expect(snapshot?.run.currentStepId).toBeUndefined();
    expect(snapshot?.continuation).toMatchObject({
      type: "WAITING_TOOL_RESULTS",
      pendingDecision: { type: "TOOL_CALLS_REQUESTED" },
    });
    // The goal and the assistant turn it produced, each appended exactly once, by the planner.
    expect(
      (await projectedRunMessages(fixture.storage, fixture.run.id)).map((message) => message.role),
    ).toEqual(["user", "assistant"]);

    // One durable Step, opened once and settled once.
    expect(await fixture.storage.steps.listByRun(fixture.run.id)).toHaveLength(1);
    expect((await fixture.storage.steps.listByRun(fixture.run.id))[0]?.status).toBe("COMPLETED");
    await fixture.storage.close();
  });

  it("records the settled turn and its reasoning summary exactly once", async () => {
    const fixture = await setup({ complete: async () => toolTurn() });
    await fixture.controller.start(fixture.run.id);

    const types = fixture.events.map((event) => event.type);
    expect(types).toEqual([
      "run.started",
      "status.changed",
      "llm.started",
      "llm.completed",
      "reasoning.summary",
    ]);
    expect(types.filter((type) => type === "llm.completed")).toHaveLength(1);
    expect(types.filter((type) => type === "status.changed")).toHaveLength(1);
    await fixture.storage.close();
  });

  it("settles a non-retryable Agent failure through the planner", async () => {
    const fixture = await setup({
      complete: async () => {
        throw new Error("provider exploded");
      },
    });

    const failed = await fixture.controller.start(fixture.run.id);

    // The kernel really produced a frozen `FAILED` result here, so this is a canonical branch and
    // the planner settles it — the compatibility settlement is not reached at all.
    expect(failed.status).toBe("FAILED");
    expect(fixture.planner.inputs).toHaveLength(1);
    expect(fixture.materializer.inputs).toHaveLength(1);
    expect(fixture.planner.inputs[0]?.effect).toMatchObject({ kind: "AGENT" });

    const planned = fixture.planner.commits[0]!;
    expect(planned.run.status).toBe("FAILED");
    expect(planned.state?.status).toBe("FAILED");
    expect(planned.stepWrites.map((write) => write.step.status)).toEqual(["FAILED"]);
    // This Run never opened a continuation, so there is nothing to clear: absent means "leave it
    // alone", which is the planner's documented reading of an optional commit field.
    expect(planned.continuation).toBeUndefined();

    const snapshot = await fixture.storage.execution.load(fixture.run.id);
    expect(snapshot?.run.status).toBe("FAILED");
    expect(snapshot?.state?.status).toBe("FAILED");
    expect(snapshot?.continuation).toBeUndefined();
    expect(snapshot?.run.currentStepId).toBeUndefined();
    await fixture.storage.close();
  });

  it("keeps a retryable provider failure on the Run Retry Policy bridge", async () => {
    const scheduled: Array<{ cancelled: boolean }> = [];
    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = makeRun();
    await storage.sessions.insert({
      id: run.sessionId,
      createdAt: createTimestampMs(1),
      updatedAt: createTimestampMs(1),
      metadata: {},
    } as never);
    await storage.runs.insert(run);

    const eventBus = new EventBus(storage.events);
    const clockState = { value: 10 };
    const planner = spyPlanner();
    const order: string[] = [];
    const materializer = spyMaterializer(order);
    let count = 0;
    const agentExecution = testRunAgentExecution({
      executor: fakeFrozenModelTurnExecutor(async () => {
        count += 1;
        throw aiError("AI_NETWORK", { message: "provider secret" });
      }),
      createStepId: () => createStepId(),
    });
    const controller = new RunController({
      agentExecution: agentExecution.factory,
      executionStore: storage.execution,
      messages: testRunMessageAuthority(),
      events: eventBus,
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "synthetic",
          contextLimits: { maxInputTokens: 1000 },
        }),
      },
      clock: { now: () => createTimestampMs(clockState.value++) },
      eventIdFactory: { create: () => createEventId() },
      verificationPlanner,
      transitionPlanner: planner.planner,
      eventMaterializer: materializer.materializer,
      retryRegistry: new RunRetryRegistry({
        clock: { now: () => createTimestampMs(clockState.value) },
        timer: {
          schedule: (delayMs, callback) => {
            // The delay and the callback are what the Run Retry Policy decided; this test only
            // needs to observe that a retry was armed, and that the planner had no part in it.
            void delayMs;
            void callback;
            const entry = { cancelled: false };
            scheduled.push(entry);
            return { cancel: () => (entry.cancelled = true) };
          },
        },
      }),
    });

    const waiting = await controller.start(run.id);

    // The retry decision belongs to the Run Retry Policy: the planner is never asked to invent an
    // attempt number or a next attempt time, and it plans no lifecycle transition here.
    expect(waiting.status).toBe("WAITING_RETRY");
    if (waiting.status !== "WAITING_RETRY") throw new Error("missing retry boundary");
    expect(planner.inputs).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    expect(count).toBe(1);
    expect(waiting.nextAttemptAt).toBeGreaterThan(clockState.value);

    await storage.close();
  });

  it("keeps a FinalCandidate on the verification compatibility bridge", async () => {
    const fixture = await setup({ complete: async () => finalTurn() });
    const result = await fixture.controller.start(fixture.run.id);

    // The planner's FINAL_CANDIDATE branch stays fail-closed and is not used as a fallback, so the
    // legacy verification bridge settles this transition and no plan is produced for it.
    expect(fixture.planner.inputs).toHaveLength(0);
    expect(result.status).toBe("AWAITING_VERIFICATION");

    const snapshot = await fixture.storage.execution.load(fixture.run.id);
    expect(snapshot?.run.status).toBe("VERIFYING");
    if (snapshot?.continuation?.type !== "AWAITING_VERIFICATION") {
      throw new Error("expected an AWAITING_VERIFICATION boundary");
    }
    // A real plan identity, minted by the host, and a durable plan row the boundary actually wrote.
    const planId = snapshot.continuation.verificationPlanId;
    expect(planId).toMatch(/^vplan_/);
    const plan = await (
      fixture.storage.execution as unknown as RunCompletionPersistencePort
    ).loadVerificationPlan(snapshot.run.id, planId);
    expect(plan?.id).toBe(planId);
    expect(plan?.candidateHash).toBeDefined();
    expect(plan?.checks.length).toBeGreaterThan(0);
    await fixture.storage.close();
  });
});

describe("durable model turn boundary in production", () => {
  it("opens the Step durably before the provider runs, exactly once", async () => {
    const fixture = await setup({ complete: async () => toolTurn() });
    await fixture.controller.start(fixture.run.id);

    const types = fixture.events.map((event) => event.type);
    // `llm.started` is the boundary's own durable event: one turn, one of them.
    expect(types.filter((type) => type === "llm.started")).toHaveLength(1);
    expect(types.filter((type) => type === "llm.completed")).toHaveLength(1);
    expect(fixture.providerCalls()).toBe(1);
    expect(await fixture.storage.steps.listByRun(fixture.run.id)).toHaveLength(1);
    await fixture.storage.close();
  });

  it("never reaches the provider when the durable open-Step commit is refused", async () => {
    const fixture = await setup({
      complete: async () => toolTurn(),
      store: (storage) => ({
        load: (runId) => storage.execution.load(runId),
        requestCancellation: (runId, intent) =>
          storage.execution.requestCancellation(runId, intent),
        commit: async (command) => {
          const isBoundary = command.stepWrites.some((write) => write.operation === "INSERT");
          if (isBoundary) throw new RunExecutionConflictError("boundary conflict");
          return storage.execution.commit(command);
        },
        loadVerificationPlan: (runId: RunId, planId: VerificationPlanId) =>
          (storage.execution as unknown as RunCompletionPersistencePort).loadVerificationPlan(
            runId,
            planId,
          ),
        commitCandidateBoundary: (command: RunCandidateBoundaryCommit) =>
          (storage.execution as unknown as RunCompletionPersistencePort).commitCandidateBoundary(
            command,
          ),
        commitVerifiedCompletion: (command: RunVerifiedCompletionCommit) =>
          (storage.execution as unknown as RunCompletionPersistencePort).commitVerifiedCompletion(
            command,
          ),
      }),
    });

    await expect(fixture.controller.start(fixture.run.id)).rejects.toBeInstanceOf(
      RunControllerInfrastructureError,
    );

    // No provider I/O, no durable Step, no boundary event, and no retry: a commit conflict is not a
    // model failure and must never be settled as one.
    expect(fixture.providerCalls()).toBe(0);
    expect(await fixture.storage.steps.listByRun(fixture.run.id)).toHaveLength(0);
    expect(fixture.events.map((event) => event.type)).toEqual(["run.started", "status.changed"]);
    const snapshot = await fixture.storage.execution.load(fixture.run.id);
    expect(snapshot?.run.status).toBe("RUNNING");
    expect(snapshot?.run.currentStepId).toBeUndefined();
    expect(snapshot?.state?.usage.steps).toBe(0);
    await fixture.storage.close();
  });
});

describe("canonical settlement side-effect safety", () => {
  it("does not notify a transition whose commit lost the revision race", async () => {
    const fixture = await setup({
      complete: async () => toolTurn(),
      store: (storage) => {
        let settlementSeen = false;
        return {
          load: (runId) => storage.execution.load(runId),
          requestCancellation: (runId, intent) =>
            storage.execution.requestCancellation(runId, intent),
          commit: async (command) => {
            // The settlement is the commit that updates a Step. Its durable revision is forced to
            // disagree here, which is exactly what a concurrent writer would have done.
            const isSettlement = command.stepWrites.some((write) => write.operation === "UPDATE");
            if (isSettlement && !settlementSeen) {
              settlementSeen = true;
              return storage.execution.commit({
                ...command,
                expectedStateRevision: (command.expectedStateRevision ?? 0) + 99,
              });
            }
            return storage.execution.commit(command);
          },
          loadVerificationPlan: (runId: RunId, planId: VerificationPlanId) =>
            (storage.execution as unknown as RunCompletionPersistencePort).loadVerificationPlan(
              runId,
              planId,
            ),
          commitCandidateBoundary: (command: RunCandidateBoundaryCommit) =>
            (storage.execution as unknown as RunCompletionPersistencePort).commitCandidateBoundary(
              command,
            ),
          commitVerifiedCompletion: (command: RunVerifiedCompletionCommit) =>
            (storage.execution as unknown as RunCompletionPersistencePort).commitVerifiedCompletion(
              command,
            ),
        };
      },
    });

    await expect(fixture.controller.start(fixture.run.id)).rejects.toBeInstanceOf(
      RunExecutionConflictError,
    );

    // The model turn ran exactly once and was never replayed to resolve the conflict.
    expect(fixture.providerCalls()).toBe(1);
    // The transition that lost the race published nothing: no `llm.completed` reached a subscriber.
    expect(fixture.events.map((event) => event.type)).toEqual([
      "run.started",
      "status.changed",
      "llm.started",
    ]);
    // And nothing was durably settled.
    const snapshot = await fixture.storage.execution.load(fixture.run.id);
    expect(snapshot?.continuation).toBeUndefined();
    expect(snapshot?.conversationRecords).toHaveLength(1);
    await fixture.storage.close();
  });

  it("counts usage once for one model call", async () => {
    const fixture = await setup({ complete: async () => toolTurn() });
    await fixture.controller.start(fixture.run.id);

    const snapshot = await fixture.storage.execution.load(fixture.run.id);
    // The fixture's provider turn reports no usage, so exactly one attempt is counted — and only
    // one, which is the property the planner's settlement has to preserve.
    expect(snapshot?.state?.usage.steps).toBe(1);
    expect(fixture.providerCalls()).toBe(1);
    await fixture.storage.close();
  });
});
