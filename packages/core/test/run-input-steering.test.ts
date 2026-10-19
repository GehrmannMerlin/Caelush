import type { AIModelRequest } from "@caelush/ai";
import type { AgentTurnRef } from "@caelush/agent";
import {
  createEventId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  computeSecurityPolicyDigest,
  AgentRunSchema,
  type AgentStep,
  type StepId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { RunController } from "../src/run-controller.js";
import {
  RunInputPendingError,
  type DurableAgentEvent,
  type RunExecutionCommit,
  type RunExecutionSnapshot,
  type RunExecutionStore,
} from "../src/run-execution-store.js";
import {
  fakeFrozenModelTurnExecutor,
  fakeContextEngine,
  testRunAgentExecution,
} from "./support/run-agent-execution.js";
import { aiError } from "./support/fake-model-turn-executor.js";
import { testRunMessageAuthority } from "./support/run-message-authority.js";
import { completionStoreOver } from "./support/completion-store.js";
import {
  answerTurn,
  harness3d,
  makeRunD,
  stubToolBatches,
  toolTurn,
} from "./support/phase-3d-tool-turn.js";

/**
 * Mid-Run user correction, end to end through the one driver.
 *
 * ```text
 * first answer (would complete)  →  deferred as commentary
 * accepted correction            →  canonical USER, recorded in the same transaction
 * WAITING_STEERING               →  the same driver's next turn
 * second answer                  →  normal completion
 * ```
 *
 * The fixture store applies the handoff and assignment the way the SQLite store does, so the test
 * observes the *contract* between the controller and its store rather than a controller-only
 * simulation.
 */

const clock = { now: () => createTimestampMs(10) };

function makeRun() {
  const securityPolicy = {
    schemaVersion: 1 as const,
    preset: { id: "VIEW_ONLY" as const, version: 1 },
    permissionProfile: "READ_ONLY" as const,
    approvalPolicy: "ON_BOUNDARY" as const,
    filesystemBoundary: "WORKSPACE_READ_ONLY" as const,
    processBoundary: "READ_ONLY" as const,
    requiredEnforcement: "OS_RESTRICTED" as const,
    hardSafetyPolicyVersion: "hard-safety@1",
    commandPolicyVersion: "command-policy@1",
    secretPolicyVersion: "secret-policy@1",
    createdAt: new Date(1).toISOString(),
  };
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect project",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ON_BOUNDARY",
    securityPolicy: {
      ...securityPolicy,
      policyDigest: computeSecurityPolicyDigest(securityPolicy),
    },
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 100_000 },
    completionContract: "NATURAL_V1",
    createdAt: createTimestampMs(1),
  });
}

function pendingInput(text: string, acceptedSequence = 1) {
  return { inputId: `input-${acceptedSequence}`, acceptedSequence, text };
}

/** The snapshot input facts a store keeps across commits. */
interface InputState {
  pending: { inputId: string; acceptedSequence: number; text: string }[];
  recorded: { inputId: string; acceptedSequence: number; messageId: string }[];
}

class MemoryExecutionStore implements RunExecutionStore {
  stateRevision: number | undefined;
  continuationRevision: number | undefined;
  readonly commits: RunExecutionCommit[] = [];
  readonly steps = new Map<StepId, AgentStep>();
  private sequence = 0;
  private inputs: InputState = { pending: [], recorded: [] };
  /** When set, the next completion commit is refused as if an input had just been accepted. */
  rejectNextCommitWithPendingInput: string | undefined;

  constructor(public snapshot: RunExecutionSnapshot) {
    this.stateRevision = snapshot.stateRevision;
    this.continuationRevision = snapshot.continuationRevision;
  }

  acceptPending(text: string): void {
    const acceptedSequence = this.inputs.pending.length + this.inputs.recorded.length + 1;
    this.inputs.pending.push(pendingInput(text, acceptedSequence));
    this.snapshot = { ...this.snapshot, runInputs: this.inputSnapshot() };
  }

  private inputSnapshot() {
    return {
      pending: [...this.inputs.pending],
      recorded: [...this.inputs.recorded],
      pendingCount: this.inputs.pending.length,
      recordedCount: this.inputs.recorded.length,
      unassignedCount: this.inputs.pending.length + this.inputs.recorded.length,
    };
  }

  async load(): Promise<RunExecutionSnapshot> {
    return this.snapshot;
  }

  async requestCancellation(
    runId: ReturnType<typeof createRunId>,
    intent: RunExecutionSnapshot["cancellationIntent"],
  ): Promise<RunExecutionSnapshot> {
    if (intent === undefined || intent.runId !== runId) throw new Error("invalid cancellation");
    this.snapshot = { ...this.snapshot, cancellationIntent: intent };
    return this.snapshot;
  }

  async commit(command: RunExecutionCommit) {
    if (this.rejectNextCommitWithPendingInput !== undefined && command.run.status === "COMPLETED") {
      this.acceptPending(this.rejectNextCommitWithPendingInput);
      this.rejectNextCommitWithPendingInput = undefined;
      throw new RunInputPendingError();
    }
    this.commits.push(command);
    if (command.state !== undefined) this.stateRevision = (this.stateRevision ?? 0) + 1;
    for (const write of command.stepWrites) this.steps.set(write.step.id, write.step);
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

    for (const entry of command.runInputs?.handoff?.entries ?? []) {
      this.inputs.pending = this.inputs.pending.filter((item) => item.inputId !== entry.inputId);
      this.inputs.recorded.push({
        inputId: entry.inputId,
        acceptedSequence: entry.acceptedSequence,
        messageId: entry.messageId,
      });
    }
    for (const messageId of command.runInputs?.assignment?.messageIds ?? []) {
      this.inputs.recorded = this.inputs.recorded.filter((item) => item.messageId !== messageId);
    }

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
      runInputs: this.inputSnapshot(),
    };
    const events: DurableAgentEvent[] = command.events.map((draft) => ({
      ...draft,
      durability: { ...draft.durability, sequence: ++this.sequence },
    }));
    return { snapshot: this.snapshot, events };
  }
}

interface Harness {
  readonly controller: RunController;
  readonly store: MemoryExecutionStore;
  readonly observed: { readonly turn: AgentTurnRef; readonly request: AIModelRequest }[];
}

function harness(options: {
  readonly executor: ReturnType<typeof fakeFrozenModelTurnExecutor>;
  readonly clock?: { now(): ReturnType<typeof createTimestampMs> };
}): Harness {
  const run = makeRun();
  const store = new MemoryExecutionStore({ run, conversationRecords: [] });
  const observed: { turn: AgentTurnRef; request: AIModelRequest }[] = [];
  const execution = testRunAgentExecution({
    executor: options.executor,
    contextEngine: fakeContextEngine(),
    onTurn: (turn, request) => observed.push({ turn, request }),
  }).factory;
  const controller = new RunController({
    agentExecution: execution,
    executionStore: store,
    messages: testRunMessageAuthority({ snapshot: () => store.snapshot }),
    completionStore: completionStoreOver(store),
    events: {
      notifyCommitted: () => undefined,
      emitTransient: () => undefined,
    },
    configResolver: {
      resolve: async () => ({ baseSystemPrompt: "base", contextLimits: { maxInputTokens: 1000 } }),
    },
    clock: options.clock ?? clock,
    eventIdFactory: { create: createEventId },
  } as never);
  return { controller, store, observed };
}

function turn(text: string) {
  return { text, toolCalls: [], finishReason: "STOP" as const };
}

function lastUserText(request: AIModelRequest): string {
  const last = [...request.messages].reverse().find((message) => message.role === "user");
  if (last === undefined || last.role !== "user") return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

describe("Run input steering through the direct driver", () => {
  it("defers a would-be-final answer, records the correction, and continues in the same driver", async () => {
    const storeRef: { current?: MemoryExecutionStore } = {};
    const executor = fakeFrozenModelTurnExecutor((_request, _signal, callIndex) => {
      if (callIndex === 0) {
        // The user corrects the Run while the first answer is being produced.
        storeRef.current?.acceptPending("use the existing SDK");
        return turn("I rewrote the client from scratch.");
      }
      return turn("Kept the existing SDK and updated only the parser.");
    });
    const h = harness({ executor });
    storeRef.current = h.store;

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("COMPLETED");
    expect(h.observed).toHaveLength(2);

    // The deferred settlement: the answer is commentary, the correction is a canonical USER, and
    // the Run holds a steering boundary instead of a final result.
    const deferred = h.store.commits.find(
      (commit) =>
        commit.continuation?.operation === "SET" &&
        commit.continuation.checkpoint.type === "WAITING_STEERING",
    );
    expect(deferred).toBeDefined();
    const assistant = deferred!.messagesToAppend.filter(
      (entry) => entry.draft.messageType === "ASSISTANT",
    );
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.draft.data).toMatchObject({ phase: "COMMENTARY" });
    expect(deferred!.runInputs?.handoff?.entries).toHaveLength(1);
    expect(deferred!.runInputs?.handoff?.entries[0]?.acceptedSequence).toBe(1);
    // The model's own text is preserved, not replaced by the correction.
    expect(JSON.stringify(assistant[0]!.draft.data)).toContain("rewrote the client");

    // The steering turn's open associates exactly the recorded message with the new Step.
    const steeringOpen = h.store.commits.find(
      (commit) => commit.runInputs?.assignment !== undefined,
    );
    expect(steeringOpen?.runInputs?.assignment?.messageIds).toHaveLength(1);

    // The second request carries the correction as the newest user message.
    expect(lastUserText(h.observed[1]!.request)).toContain("use the existing SDK");
    // One correction, one canonical message: the second request does not repeat it as a new record.
    const userMessages = h.store.snapshot.conversationRecords.filter(
      (record) => record.messageType === "USER",
    );
    expect(userMessages).toHaveLength(2);
  });

  it("re-plans when a correction is accepted in the last window, without a second provider turn", async () => {
    const storeRef: { current?: MemoryExecutionStore } = {};
    const executor = fakeFrozenModelTurnExecutor((_request, _signal, callIndex) =>
      callIndex === 0 ? turn("first answer") : turn("second answer"),
    );
    const h = harness({ executor });
    storeRef.current = h.store;
    // The completion transaction finds an input accepted after planning and refuses with a typed
    // conflict; the controller must settle the *same* frozen effect as a deferred answer.
    h.store.rejectNextCommitWithPendingInput = "actually, keep the old parser";

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("COMPLETED");
    expect(h.observed).toHaveLength(2);
    const deferred = h.store.commits.find(
      (commit) =>
        commit.continuation?.operation === "SET" &&
        commit.continuation.checkpoint.type === "WAITING_STEERING",
    );
    expect(deferred).toBeDefined();
    // The first answer is recorded once, as commentary — the refused attempt left nothing behind.
    expect(
      h.store.snapshot.conversationRecords.filter(
        (record) => record.messageType === "ASSISTANT" && record.data.phase === "COMMENTARY",
      ),
    ).toHaveLength(1);
    expect(lastUserText(h.observed[1]!.request)).toContain("keep the old parser");
  });

  it("accepts a correction while the model turn is in flight without touching its revisions", async () => {
    const storeRef: { current?: MemoryExecutionStore } = {};
    let observedDuringTurn: { state?: number; continuation?: number } = {};
    const executor = fakeFrozenModelTurnExecutor((_request, _signal, callIndex) => {
      if (callIndex === 0) {
        const store = storeRef.current!;
        store.acceptPending("a correction");
        observedDuringTurn = {
          state: store.stateRevision,
          continuation: store.continuationRevision,
        };
        return turn("answer");
      }
      return turn("final");
    });
    const h = harness({ executor });
    storeRef.current = h.store;

    await h.controller.start(h.store.snapshot.run.id);

    // While the model turn was open, acceptance changed neither revision: the in-flight Step's CAS
    // is exactly the one it was opened with.
    expect(observedDuringTurn.state).toBe(2);
    expect(observedDuringTurn.continuation).toBeUndefined();
    expect(h.store.snapshot.run.status).toBe("COMPLETED");
  });
});

describe("a correction that arrives during a Tool batch", () => {
  it("waits for the whole batch and then travels with the TOOL_RESULTS turn", async () => {
    const batches = stubToolBatches();
    const storeRef: { current?: import("./support/phase-3d-tool-turn.js").MemoryRunStore } = {};
    const h = harness3d({
      run: makeRunD({ completionContract: "NATURAL_V1" }),
      script: (call) => {
        if (call === 0) {
          // Accepted while the model's Tool request is being executed: the batch is already open.
          storeRef.current?.acceptPendingRunInput("stop editing and just read it");
          return toolTurn([
            { id: "call_a", name: "read_file", input: { path: "a.ts" } },
            { id: "call_b", name: "read_file", input: { path: "b.ts" } },
          ]);
        }
        return answerTurn("read both files");
      },
      toolBatches: batches,
    });
    storeRef.current = h.store;

    await h.controller.start(h.store.snapshot.run.id);

    // Both calls executed: a correction never truncates a dispatched batch.
    expect(batches.calls[0]?.request.calls).toHaveLength(2);
    expect(batches.physicalExecutions).toBe(1);
    // The resume turn follows immediately; a fixture Context engine that does not report its
    // selection can require one further turn before the association is provable, which is the
    // conservative outcome and not a duplicate correction.
    expect(h.turns.length).toBeGreaterThanOrEqual(2);
    expect(
      h.store.snapshot.conversationRecords.filter((record) => record.messageType === "USER"),
    ).toHaveLength(2);

    // The correction's USER commit happened between the batch and the next turn, and it did not
    // replace the Tool continuation the resume depends on.
    const handoff = h.store.commits.find((commit) => commit.runInputs?.handoff !== undefined);
    expect(handoff).toBeDefined();
    expect(handoff!.continuation).toBeUndefined();
    expect(handoff!.stepWrites).toHaveLength(0);

    // The resume turn is the TOOL_RESULTS turn, and it carries the correction after the results.
    const request = h.turns[1]!.request;
    const tail = request.messages.slice(-3).map((message) => message.role);
    expect(tail).toEqual(["tool", "tool", "user"]);
    const last = request.messages.at(-1)!;
    expect(last.role === "user" && String(last.content)).toContain("stop editing and just read it");

    // The first Step association is the correction's message, written when that turn opened.
    const opening = h.store.commits.find((commit) => commit.runInputs?.assignment !== undefined);
    expect(opening?.runInputs?.assignment?.messageIds).toHaveLength(1);
  });
});

describe("a steering turn that fails", () => {
  it("retries the same corrections and never falls back to the original goal", async () => {
    const storeRef: { current?: MemoryExecutionStore } = {};
    const mutableClock = { value: 10 };
    const clockRef = { now: () => createTimestampMs(mutableClock.value) };
    const executor = fakeFrozenModelTurnExecutor(async (_request, _signal, callIndex) => {
      if (callIndex === 0) {
        storeRef.current?.acceptPending("use the existing SDK");
        return turn("first answer");
      }
      if (callIndex === 1) throw aiError("AI_NETWORK", { message: "socket closed" });
      return turn("final answer");
    });
    const h = harness({ executor, clock: clockRef });
    storeRef.current = h.store;

    const first = await h.controller.start(h.store.snapshot.run.id);
    expect(first.status).toBe("WAITING_RETRY");
    if (first.status !== "WAITING_RETRY") throw new Error("not waiting for a retry");

    // The retry checkpoint keeps the steering provenance, not a fresh START.
    const retry = h.store.commits.at(-1)?.continuation;
    expect(retry?.operation).toBe("SET");
    if (retry?.operation !== "SET" || retry.checkpoint.type !== "WAITING_RETRY") {
      throw new Error("no retry checkpoint");
    }
    expect(retry.checkpoint.mode).toBe("STEERING");
    if (retry.checkpoint.mode !== "STEERING") throw new Error("wrong retry mode");
    expect(retry.checkpoint.messageIds).toHaveLength(1);

    // The backoff is not bypassed: recovering before it is due leaves the Run parked.
    expect((await h.controller.recover(h.store.snapshot.run.id)).status).toBe("WAITING_RETRY");

    mutableClock.value = first.nextAttemptAt + 1;
    const resumed = await h.controller.recover(h.store.snapshot.run.id);
    expect(resumed.status).toBe("TERMINAL");
    expect(resumed.run.status).toBe("COMPLETED");

    // The correction exists once, and the retry re-sent it rather than appending it again.
    expect(
      h.store.snapshot.conversationRecords.filter((record) => record.messageType === "USER"),
    ).toHaveLength(2);
    expect(lastUserText(h.observed[2]!.request)).toContain("use the existing SDK");
  });
});
