import type { AIModelRequest } from "@caelush/ai";
import type { AgentTurnRef } from "@caelush/agent";
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
import { completionStoreOver } from "./support/completion-store.js";
import { RunController } from "../src/run-controller.js";
import {
  createAssistantMessageAppend,
  createExternalToolResultMessageAppend,
  createUserMessageAppend,
} from "../src/run-message-materializer.js";
import type {
  DurableAgentEvent,
  RunExecutionCommit,
  RunExecutionSnapshot,
  RunExecutionStorePort,
} from "../src/run-execution-store.js";
import type { RunContinuationCheckpoint } from "../src/agent-continuation.js";
import type { AgentToolCallsDecision } from "../src/agent-decision.js";
import type { RunAgentExecutionContextFactory } from "../src/run-agent-execution.js";
import {
  createInitialAgentState,
  markAgentStateWaitingApproval,
  markAgentStateWaitingResource,
  startAgentState,
} from "../src/agent-state.js";
import {
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
} from "./support/run-agent-execution.js";
import { testRunMessageAuthority } from "./support/run-message-authority.js";

/**
 * `AgentTurnInput.TOOL_RESULTS.sourceStepId` provenance.
 *
 * The frozen field names the durable AgentStep that *requested* the Tools. It is not the Step of the
 * resume attempt, not `failedStepId`, and certainly not the model turn's call identity — the
 * previous implementation cast an `LLMCallId` into a `StepId`, which is why every case below uses
 * three deliberately different identifiers.
 *
 * Phase 3C checkpoint 6 retired the legacy facade, so the assertion point moved with the ownership:
 * the frozen turn input is no longer handed to a spy `AgentLoop`. What a test can observe on the
 * direct path is the pair the Run Layer *does* control — the durable continuation it committed and
 * the frozen `AgentTurnRef` / request the provider actually received — and the boundary's own
 * refusal to open a Tool-resume turn against a Step the continuation did not record.
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

/** A store that commits the way the production store does, from whatever snapshot is seeded. */
class SeededStore implements RunExecutionStorePort {
  stateRevision: number | undefined;
  continuationRevision: number | undefined;
  readonly commits: RunExecutionCommit[] = [];
  private sequence = 0;

  constructor(public snapshot: RunExecutionSnapshot) {
    this.stateRevision = snapshot.stateRevision;
    this.continuationRevision = snapshot.continuationRevision;
  }

  async load(): Promise<RunExecutionSnapshot> {
    return this.snapshot;
  }

  async requestCancellation(): Promise<RunExecutionSnapshot> {
    return this.snapshot;
  }

  async commit(command: RunExecutionCommit) {
    this.commits.push(command);
    if (command.state !== undefined) {
      this.stateRevision = (this.stateRevision ?? 0) + 1;
    }
    const activeStep = command.stepWrites.find((write) => write.step.status === "RUNNING")?.step;
    const nextContinuation =
      command.continuation === undefined
        ? this.snapshot.continuation
        : command.continuation.operation === "CLEAR"
          ? undefined
          : command.continuation.checkpoint;
    if (command.continuation?.operation === "SET") {
      this.continuationRevision = (this.continuationRevision ?? 0) + 1;
    }
    if (command.continuation?.operation === "CLEAR") this.continuationRevision = undefined;
    // Rebuilt member by member rather than spread from a `Record`: the snapshot fields are
    // optional-without-undefined, so "absent" has to be omitted rather than assigned.
    const conversationRecords = [
      ...this.snapshot.conversationRecords,
      ...command.messagesToAppend.map((entry, index) => ({
        runId: command.run.id,
        sequence: this.snapshot.conversationRecords.length + index + 1,
        ...entry.draft,
      })),
    ];
    this.snapshot = {
      run: command.run,
      conversationRecords,
      ...(command.state === undefined
        ? this.snapshot.state === undefined
          ? {}
          : { state: this.snapshot.state }
        : { state: command.state }),
      ...(this.stateRevision === undefined ? {} : { stateRevision: this.stateRevision }),
      ...(activeStep === undefined ? {} : { activeStep }),
      ...(nextContinuation === undefined ? {} : { continuation: nextContinuation }),
      ...(nextContinuation === undefined || this.continuationRevision === undefined
        ? {}
        : { continuationRevision: this.continuationRevision }),
    };
    const events: DurableAgentEvent[] = command.events.map((draft) => ({
      ...draft,
      durability: { ...draft.durability, sequence: ++this.sequence },
    }));
    return { snapshot: this.snapshot, events };
  }
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

/** What one provider turn was actually handed by the Run Layer. */
interface ObservedTurn {
  readonly turn: AgentTurnRef;
  readonly request: AIModelRequest;
}

/**
 * The direct Agent execution dependencies, recording every provider turn.
 *
 * The Step identity factory is seeded so the *allocated* Step is distinguishable from the request
 * Step the continuation recorded: a test that let the two coincide would prove nothing.
 */
function agentExecutionFor(observed: ObservedTurn[]): RunAgentExecutionContextFactory {
  let allocated = 0;
  return testRunAgentExecution({
    executor: fakeFrozenModelTurnExecutor(async () => ({
      text: "resumed",
      finishReason: "STOP" as const,
    })),
    createStepId: () => {
      allocated += 1;
      return `stp_0195f3a0-0000-7000-8000-0000000000${String(allocated).padStart(2, "0")}` as StepId;
    },
    onTurn: (turn, request) => {
      observed.push({ turn, request });
    },
  }).factory;
}

function controllerFor(
  store: SeededStore,
  observed: ObservedTurn[],
  extra: Record<string, unknown> = {},
): RunController {
  return new RunController({
    agentExecution: agentExecutionFor(observed),
    executionStore: store,
    messages: testRunMessageAuthority({ snapshot: () => store.snapshot }),
    completionStore: completionStoreOver(store),
    events: { notifyCommitted: () => undefined, emitTransient: () => undefined },
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

/**
 * A RUNNING Run waiting for Tool results, with the accepted results already recorded.
 *
 * The conversation holds the open user turn and the assistant message that announced the calls —
 * which is exactly what the durable ledger of a real Tool boundary contains. The frozen projection
 * refuses a Tool resume whose history does not show that pending assistant, so a fixture without it
 * would be a state the Run Layer could never actually be in.
 */
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
    conversationRecords: openToolTurn(run),
    continuation: checkpoint,
    continuationRevision: 1,
  });
  return { run, store };
}

/** The durable conversation of a Run parked on an open Tool turn. */
function openToolTurn(run: ReturnType<typeof makeRun>) {
  const messages = testRunMessageAuthority();
  const user = createUserMessageAppend(messages, run, "GOAL").draft;
  const assistant = createAssistantMessageAppend(
    messages,
    run,
    ORIGINAL_TOOL_STEP,
    PENDING_DECISION.modelTurn,
  ).draft;
  const result = createExternalToolResultMessageAppend(
    messages,
    run,
    ORIGINAL_TOOL_STEP,
    RECEIVED_RESULTS[0]!,
    { maxSingleObservationTokens: 100, maxObservationBatchTokens: 200 },
  ).draft;
  return [
    {
      sequence: 1,
      runId: run.id,
      ...user,
    },
    {
      sequence: 2,
      runId: run.id,
      ...assistant,
    },
    {
      sequence: 3,
      runId: run.id,
      ...result,
    },
  ];
}

/** Whether the crash-recovery entry point drove the batch, rather than a fresh execution. */
function crashRecoveryRan(store: SeededStore): boolean {
  return store.commits.some((commit) =>
    commit.events.some((event) => event.type === "llm.started"),
  );
}

describe("RunController Tool resume provenance", () => {
  it("resumes the continuation's own source Step, never this attempt's Step", async () => {
    const { store, run } = waitingToolResults();
    const observed: ObservedTurn[] = [];

    await controllerFor(store, observed).recover(run.id);

    // Exactly one provider turn ran, and the Step it ran as is the one the Run Layer allocated —
    // not the request Step the continuation recorded.
    expect(observed).toHaveLength(1);
    expect(observed[0]!.turn.stepId).not.toBe(ORIGINAL_TOOL_STEP);
    expect(observed[0]!.turn.stepId).not.toBe(FAILED_RETRY_STEP);
    expect(observed[0]!.turn.stepId).not.toBe(MODEL_CALL_ID);
    // The model was shown the pending assistant tool call and its result, and the user turn exactly
    // once: the resume is a real Tool continuation, not a new user follow-up.
    const roles = observed[0]!.request.messages.map((message) => message.role);
    expect(roles.filter((role) => role === "user")).toHaveLength(1);
    expect(roles.filter((role) => role === "assistant")).toHaveLength(1);
    expect(roles.filter((role) => role === "tool")).toHaveLength(1);
  });

  it("keeps the request Step on a crash recovery, not the recovering Step", async () => {
    const { store, run } = waitingToolResults();
    const observed: ObservedTurn[] = [];

    // `recover()` is the restart path: the Run was interrupted at the Tool boundary.
    await controllerFor(store, observed).recover(run.id);

    // The batch re-entered the recovery entry point HEAD used — the one that goes through
    // `recoverOrDispatch`, so a durable RUNNING invocation fails closed rather than being
    // re-dispatched — and the turn it opened is a *new* attempt, never the request Step the
    // continuation recorded.
    expect(crashRecoveryRan(store)).toBe(true);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.turn.stepId).not.toBe(ORIGINAL_TOOL_STEP);
    expect(observed[0]!.turn.stepId).not.toBe(FAILED_RETRY_STEP);
    // And the model was shown the batch's own open turn exactly once.
    const roles = observed[0]!.request.messages.map((message) => message.role);
    expect(roles.filter((role) => role === "user")).toHaveLength(1);
    expect(roles.filter((role) => role === "tool")).toHaveLength(1);
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
    const observed: ObservedTurn[] = [];

    await controllerFor(store, observed).recover(run.id);

    // A retry is a *new* attempt: it allocates a new Step rather than reusing the failed one, and
    // the failed attempt's Step is never the provenance of the resume.
    expect(observed).toHaveLength(1);
    expect(observed[0]!.turn.stepId).not.toBe(FAILED_RETRY_STEP);
    expect(observed[0]!.turn.stepId).not.toBe(ORIGINAL_TOOL_STEP);
    const roles = observed[0]!.request.messages.map((message) => message.role);
    expect(roles.filter((role) => role === "user")).toHaveLength(1);
    expect(roles.filter((role) => role === "tool")).toHaveLength(1);
  });

  it("recovers a legacy retry checkpoint from the durable conversation", async () => {
    const { store, run } = waitingToolResults();
    store.snapshot = {
      ...store.snapshot,
      // A checkpoint written before the retry continuation carried `sourceStepId`. The Step is
      // still determinable: the assistant message that announced the calls records it.
      conversationRecords: openToolTurn(run) as never,
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
    const observed: ObservedTurn[] = [];

    await controllerFor(store, observed).recover(run.id);

    // The normalization is a real durable write, not a runtime special case: the recovered
    // provenance is persisted onto the continuation *before* anything is routed, so the coordinator
    // only ever sees a state it can route on.
    const normalizations = store.commits.filter(
      (commit) => commit.continuation?.operation === "SET",
    );
    const normalized = normalizations[0]?.continuation;
    expect(
      normalized?.operation === "SET" && normalized.checkpoint.type === "WAITING_RETRY"
        ? normalized.checkpoint.sourceStepId
        : undefined,
    ).toBe(ORIGINAL_TOOL_STEP);
    // It was written as a continuation update and nothing else: no Step was rewritten, no Run moved.
    expect(normalizations[0]?.stepWrites).toEqual([]);
    expect(normalizations[0]?.messagesToAppend).toEqual([]);

    expect(observed).toHaveLength(1);
    expect(observed[0]!.turn.stepId).not.toBe(ORIGINAL_TOOL_STEP);
    expect(observed[0]!.turn.stepId).not.toBe(FAILED_RETRY_STEP);
  });

  it("fails closed when a legacy retry checkpoint has no determinable source Step", async () => {
    const { store, run } = waitingToolResults();
    store.snapshot = {
      ...store.snapshot,
      // No `sourceStepId`, and no durable assistant message to recover it from.
      conversationRecords: [],
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
    const observed: ObservedTurn[] = [];

    // Guessing would open a Tool resume against a Step that never requested the Tools.
    await expect(controllerFor(store, observed).recover(run.id)).rejects.toThrow(
      /no durable source Step/,
    );
    expect(observed).toHaveLength(0);
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
    const observed: ObservedTurn[] = [];

    // Resolving the approval is the production entry point for this boundary. It clears only the
    // waiting pointer; the Tool request's Step is not its to change.
    await controllerFor(store, observed, {
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

    // The approval resume really happened — the Run left the waiting status — and the continuation
    // it wrote still names the Step that requested the Tools.
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
      conversationRecords: [],
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

    await controllerFor(store, []).continueResourceGuard(run.id);

    const recorded = store.snapshot.continuation;
    expect(recorded?.type === "WAITING_TOOL_RESULTS" ? recorded.sourceStepId : undefined).toBe(
      ORIGINAL_TOOL_STEP,
    );
  });
});
