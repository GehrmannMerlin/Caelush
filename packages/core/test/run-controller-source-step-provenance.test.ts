import {
  AgentRunSchema,
  createEventId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  type StepId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import type { AgentLoop } from "../src/agent-loop.js";
import { RunController } from "../src/run-controller.js";
import type { AgentLoopResumeInput } from "../src/agent-loop-input.js";
import type { AgentLoopCommonInput } from "../src/agent-loop-input.js";
import type { AgentLoopExecutionResult } from "../src/agent-loop-input.js";
import type {
  RunExecutionCommit,
  RunExecutionSnapshot,
  RunExecutionStorePort,
} from "../src/run-execution-store.js";
import type { RunContinuationCheckpoint } from "../src/agent-continuation.js";
import type { AgentToolCallsDecision } from "../src/agent-decision.js";
import {
  createInitialAgentState,
  markAgentStateWaitingApproval,
  markAgentStateWaitingResource,
  startAgentState,
} from "../src/agent-state.js";

/**
 * `AgentTurnInput.TOOL_RESULTS.sourceStepId` provenance.
 *
 * The frozen field names the durable AgentStep that *requested* the Tools. It is not the Step of
 * the resume attempt, not `failedStepId`, and certainly not the model turn's call identity — the
 * previous implementation cast an `LLMCallId` into a `StepId`, which is why every case below uses
 * three deliberately different identifiers.
 *
 * The assertion point is the frozen turn input the loop is handed, recorded by a spy loop. A test
 * that let the ids coincide would prove nothing, so they never do.
 */

const ORIGINAL_TOOL_STEP = "stp_0195f3a0-0000-7000-8000-000000000a01" as StepId;
const FAILED_RETRY_STEP = "stp_0195f3a0-0000-7000-8000-000000000c03" as StepId;
const MODEL_CALL_ID = "llm_0195f3a0-0000-7000-8000-000000000b02";

const PENDING_DECISION: AgentToolCallsDecision = {
  type: "TOOL_CALLS_REQUESTED",
  modelTurn: {
    callId: MODEL_CALL_ID,
    model: { provider: "fixture", model: "fixture-model" },
    finishReason: "TOOL_CALLS",
    assistantMessage: {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_a", toolName: "read_file", input: { path: "a.ts" } },
      ],
    },
  },
  toolRequests: [{ externalCallId: "call_a", toolName: "read_file", args: { path: "a.ts" } }],
};

const RECEIVED_RESULTS = [
  {
    role: "tool" as const,
    toolCallId: "call_a",
    toolName: "read_file",
    content: "source",
    isError: false,
  },
];

function makeRun() {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "resume the tools",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs: 10_000 },
    createdAt: createTimestampMs(1),
  });
}

/** A store that holds whatever snapshot the test seeds. */
class SeededStore implements RunExecutionStorePort {
  constructor(public snapshot: RunExecutionSnapshot) {}

  async load(): Promise<RunExecutionSnapshot> {
    return this.snapshot;
  }

  async requestCancellation(): Promise<RunExecutionSnapshot> {
    return this.snapshot;
  }

  async commit(command: RunExecutionCommit) {
    const nextContinuation =
      command.continuation === undefined
        ? this.snapshot.continuation
        : command.continuation.operation === "CLEAR"
          ? undefined
          : command.continuation.checkpoint;
    // `continuation` is an optional-without-undefined field, so it is rebuilt by omission rather
    // than assigned `undefined`.
    const rest: Record<string, unknown> = { ...this.snapshot };
    delete rest.continuation;
    this.snapshot = {
      ...rest,
      run: command.run,
      ...(command.state === undefined ? {} : { state: command.state }),
      ...(nextContinuation === undefined
        ? {}
        : { continuation: nextContinuation, continuationRevision: 2 }),
      conversation: [
        ...this.snapshot.conversation,
        ...command.messagesToAppend.map((entry, index) => ({
          runId: command.run.id,
          sequence: this.snapshot.conversation.length + index + 1,
          ...entry,
        })),
      ],
    };
    return { snapshot: this.snapshot, events: [] };
  }
}

/** A spy loop: it records the frozen resume input and reports a final candidate. */
function spyLoop(): {
  readonly loop: AgentLoop;
  resumes(): readonly AgentLoopResumeInput[];
  continuations(): readonly AgentLoopCommonInput[];
  starts(): number;
} {
  const resumes: AgentLoopResumeInput[] = [];
  const continuations: AgentLoopCommonInput[] = [];
  let starts = 0;
  // The observation happens before settlement, so the spy settles deterministically rather than
  // leaving the controller to interpret an unknown outcome.
  const settled = (state: AgentLoopCommonInput["state"]): AgentLoopExecutionResult =>
    ({
      status: "FAILED",
      error: { code: "MODEL_ERROR", message: "spy", retryable: false, phase: "LLM" },
      state,
      messagesToAppend: [],
      providerTurnState: "NOT_STARTED",
    }) as never;
  const loop = {
    withLifecycleHooks: () => loop,
    async run(input: AgentLoopCommonInput) {
      starts += 1;
      return settled(input.state);
    },
    async continueRun(input: AgentLoopCommonInput) {
      continuations.push(input);
      return settled(input.state);
    },
    async resumeWithToolResults(input: AgentLoopResumeInput) {
      resumes.push(input);
      return settled(input.state);
    },
  } as unknown as AgentLoop;
  return { loop, resumes: () => resumes, continuations: () => continuations, starts: () => starts };
}

/**
 * A real AgentState projection of the Run, in the state the boundary requires.
 *
 * The fixtures are built from the same factories production uses, so the Run/AgentState
 * synchronization invariant is satisfied by construction rather than by hand-shaped literals.
 */
function stateFor(
  run: ReturnType<typeof makeRun>,
  status: "RUNNING" | "WAITING_APPROVAL" | "WAITING_RESOURCE" = "RUNNING",
) {
  const pending = AgentRunSchema.parse({ ...run, status: "PENDING", startedAt: undefined });
  const running = startAgentState(
    createInitialAgentState(pending, createTimestampMs(1)),
    createTimestampMs(1),
  );
  if (status === "WAITING_APPROVAL")
    return markAgentStateWaitingApproval(running, createTimestampMs(1));
  if (status === "WAITING_RESOURCE")
    return markAgentStateWaitingResource(running, createTimestampMs(1));
  return running;
}

function controllerFor(
  store: SeededStore,
  spy: ReturnType<typeof spyLoop>,
  extra: Record<string, unknown> = {},
): RunController {
  return new RunController({
    agentLoop: spy.loop,
    executionStore: store,
    events: { notifyCommitted: () => undefined },
    configResolver: {
      resolve: async () => ({ baseSystemPrompt: "base", contextLimits: { maxInputTokens: 1000 } }),
    },
    clock: { now: () => createTimestampMs(10) },
    eventIdFactory: { create: createEventId },
    verificationPlanner: {
      plan: ({
        runId,
        sourceStepId,
      }: {
        runId: ReturnType<typeof createRunId>;
        sourceStepId: StepId;
      }) => ({
        runId,
        sourceStepId,
        plannerVersion: "phase-11a.v1",
        planHash: "a".repeat(64),
        checks: [
          {
            ordinal: 0,
            stage: "ACCEPTANCE",
            requirement: "REQUIRED",
            spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
          },
        ],
      }),
    },
    approvals: { getById: async () => null, resolve: async () => ({}) },
    ...extra,
  } as never);
}

/** A RUNNING Run waiting for Tool results, with the accepted results already recorded. */
function waitingToolResults(overrides: Partial<RunContinuationCheckpoint> = {}) {
  const run = makeRun();
  const checkpoint: RunContinuationCheckpoint = {
    type: "WAITING_TOOL_RESULTS",
    runId: run.id,
    sourceStepId: ORIGINAL_TOOL_STEP,
    pendingDecision: PENDING_DECISION,
    receivedResults: RECEIVED_RESULTS,
    ...overrides,
  } as RunContinuationCheckpoint;
  const store = new SeededStore({
    run: AgentRunSchema.parse({ ...run, status: "RUNNING", startedAt: createTimestampMs(1) }),
    state: stateFor(run) as never,
    conversation: [],
    continuation: checkpoint,
    continuationRevision: 1,
  });
  return { run, store };
}

describe("RunController Tool resume provenance", () => {
  it("passes the continuation's own source Step on a normal resume", async () => {
    const { store, run } = waitingToolResults();
    const spy = spyLoop();

    await controllerFor(store, spy).recover(run.id);

    expect(spy.resumes()).toHaveLength(1);
    const resume = spy.resumes()[0]!;
    // The three identifiers are all different, so an accidental equality cannot pass this.
    expect(resume.sourceStepId).toBe(ORIGINAL_TOOL_STEP);
    expect(resume.sourceStepId).not.toBe(FAILED_RETRY_STEP);
    expect(resume.sourceStepId).not.toBe(MODEL_CALL_ID);
  });

  it("keeps the request Step on a crash recovery, not the recovering Step", async () => {
    const { store, run } = waitingToolResults();
    const spy = spyLoop();

    // `recover()` is the restart path: the Run was interrupted at the Tool boundary.
    await controllerFor(store, spy).recover(run.id);

    expect(spy.resumes()[0]?.sourceStepId).toBe(ORIGINAL_TOOL_STEP);
  });

  it("keeps the request Step across a retry of the Tool resume", async () => {
    const { store, run } = waitingToolResults();
    store.snapshot = {
      ...store.snapshot,
      continuation: {
        type: "WAITING_RETRY",
        runId: run.id,
        // The attempt that failed. It is deliberately not the request Step.
        failedStepId: FAILED_RETRY_STEP,
        attempt: 2,
        maxAttempts: 3,
        nextAttemptAt: createTimestampMs(5),
        errorCode: "LLM_NETWORK",
        mode: "TOOL_RESULTS",
        pendingDecision: PENDING_DECISION,
        receivedResults: RECEIVED_RESULTS,
        sourceStepId: ORIGINAL_TOOL_STEP,
      } as never,
    };
    const spy = spyLoop();

    await controllerFor(store, spy).recover(run.id);

    const resume = spy.resumes()[0]!;
    expect(resume.sourceStepId).toBe(ORIGINAL_TOOL_STEP);
    // The failed attempt's Step is never the provenance.
    expect(resume.sourceStepId).not.toBe(FAILED_RETRY_STEP);
  });

  it("recovers a legacy retry checkpoint from the durable conversation", async () => {
    const { store, run } = waitingToolResults();
    store.snapshot = {
      ...store.snapshot,
      // A checkpoint written before the retry continuation carried `sourceStepId`. The Step is
      // still determinable: the assistant message that announced the calls records it.
      conversation: [
        {
          runId: run.id,
          sequence: 1,
          message: { role: "user", content: "resume the tools" },
        },
        {
          runId: run.id,
          sequence: 2,
          sourceStepId: ORIGINAL_TOOL_STEP,
          message: {
            role: "assistant",
            content: PENDING_DECISION.modelTurn.assistantMessage.content,
          },
        },
      ] as never,
      continuation: {
        type: "WAITING_RETRY",
        runId: run.id,
        failedStepId: FAILED_RETRY_STEP,
        attempt: 2,
        maxAttempts: 3,
        nextAttemptAt: createTimestampMs(5),
        errorCode: "LLM_NETWORK",
        mode: "TOOL_RESULTS",
        pendingDecision: PENDING_DECISION,
        receivedResults: RECEIVED_RESULTS,
      } as never,
    };
    const spy = spyLoop();

    await controllerFor(store, spy).recover(run.id);

    expect(spy.resumes()[0]?.sourceStepId).toBe(ORIGINAL_TOOL_STEP);
  });

  it("fails closed when a legacy retry checkpoint has no determinable source Step", async () => {
    const { store, run } = waitingToolResults();
    store.snapshot = {
      ...store.snapshot,
      // No `sourceStepId`, and no durable assistant message to recover it from.
      conversation: [],
      continuation: {
        type: "WAITING_RETRY",
        runId: run.id,
        failedStepId: FAILED_RETRY_STEP,
        attempt: 2,
        maxAttempts: 3,
        nextAttemptAt: createTimestampMs(5),
        errorCode: "LLM_NETWORK",
        mode: "TOOL_RESULTS",
        pendingDecision: PENDING_DECISION,
        receivedResults: RECEIVED_RESULTS,
      } as never,
    };
    const spy = spyLoop();

    // Guessing would open a Tool resume against a Step that never requested the Tools.
    await expect(controllerFor(store, spy).recover(run.id)).rejects.toThrow(
      /no durable source Step/,
    );
    expect(spy.resumes()).toHaveLength(0);
  });

  it("keeps the request Step across an approval resume", async () => {
    const { store, run } = waitingToolResults();
    const approvalId = "apr_0195f3a0-0000-7000-8000-000000000001";
    store.snapshot = {
      ...store.snapshot,
      run: AgentRunSchema.parse({ ...run, status: "WAITING_APPROVAL" }),
      state: stateFor(run, "WAITING_APPROVAL") as never,
      continuation: {
        type: "WAITING_TOOL_RESULTS",
        runId: run.id,
        sourceStepId: ORIGINAL_TOOL_STEP,
        pendingDecision: PENDING_DECISION,
        waitingApproval: {
          invocationId: "tiv_0195f3a0-0000-7000-8000-000000000001",
          approvalId,
          externalCallId: "call_a",
          toolName: "read_file",
        },
      } as never,
    };
    const spy = spyLoop();

    // Resolving the approval is the production entry point for this boundary. It clears only the
    // waiting pointer; the Tool request's Step is not its to change, and the batch then re-enters
    // the same resume path the normal case above proves.
    await controllerFor(store, spy, {
      approvals: {
        getById: async () => ({
          id: approvalId,
          runId: run.id,
          toolInvocationId: "tiv_0195f3a0-0000-7000-8000-000000000001",
          riskLevel: "HIGH",
          title: "approve",
          reason: "reason",
          action: {},
          status: "APPROVED",
          scope: "ONCE",
          grantedScope: "ONCE",
          createdAt: createTimestampMs(1),
          resolvedAt: createTimestampMs(2),
        }),
        resolve: async () => ({
          id: approvalId,
          runId: run.id,
          toolInvocationId: "tiv_0195f3a0-0000-7000-8000-000000000001",
          riskLevel: "HIGH",
          title: "approve",
          reason: "reason",
          action: {},
          status: "APPROVED",
          scope: "ONCE",
          grantedScope: "ONCE",
          createdAt: createTimestampMs(1),
          resolvedAt: createTimestampMs(2),
        }),
      },
    }).resolveApproval(run.id, approvalId as never, { action: "APPROVE", scope: "ONCE" });

    // The approval resume really happened — the Run left the waiting status — and the
    // continuation it wrote still names the Step that requested the Tools.
    expect(store.snapshot.run.status).toBe("RUNNING");
    const recorded = store.snapshot.continuation;
    expect(recorded?.type === "WAITING_TOOL_RESULTS" ? recorded.sourceStepId : undefined).toBe(
      ORIGINAL_TOOL_STEP,
    );
  });

  it("keeps the request Step across a resource resume", async () => {
    const run = makeRun();
    const store = new SeededStore({
      run: AgentRunSchema.parse({
        ...run,
        status: "WAITING_RESOURCE",
        startedAt: createTimestampMs(1),
      }),
      state: stateFor(run, "WAITING_RESOURCE") as never,
      conversation: [],
      continuation: {
        type: "WAITING_RESOURCE",
        runId: run.id,
        sourceStepId: ORIGINAL_TOOL_STEP,
        pendingDecision: PENDING_DECISION,
        reason: "NO_PROGRESS",
        replanCount: 1,
      } as never,
      continuationRevision: 1,
    });

    await controllerFor(store, spyLoop()).continueResourceGuard(run.id);

    const recorded = store.snapshot.continuation;
    expect(recorded?.type === "WAITING_TOOL_RESULTS" ? recorded.sourceStepId : undefined).toBe(
      ORIGINAL_TOOL_STEP,
    );
  });
});
