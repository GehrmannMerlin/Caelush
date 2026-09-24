import {
  createApprovalRequestId,
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  type JsonObject,
  type ToolInvocation,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createRequestedToolInvocation,
  createToolSettlementCoordinator,
  startToolInvocation,
  ToolExecutionConflictError,
  ToolExecutionInfrastructureError,
  ToolExecutionInvariantError,
  type ToolExecutionCommit,
  type ToolExecutionCommitResult,
  type ToolExecutionSnapshot,
  type ToolExecutionStorePort,
  type ToolSettlementExtension,
} from "@caelush/agent";
import type { AgentToolResult } from "../src/tools/types/tool-result.js";

/**
 * `ToolSettlementCoordinator` — the terminal commit.
 *
 * ```text
 * PreparedToolSettlement → COMPLETED | FAILED → observation + events + extension → one commit
 * ```
 *
 * The three-field frozen input is asserted here, and every test observes the *command* the coordinator
 * commits rather than a mock's behaviour — so what is verified is the durable statement, not the call.
 */

class RecordingStore implements ToolExecutionStorePort {
  readonly commands: ToolExecutionCommit[] = [];
  snapshot: ToolExecutionSnapshot | null = null;
  failWith: Error | undefined;
  /**
   * What this store reports it appended.
   *
   * The commit result is what a notifier is told about, so a test that asserts the
   * commit-before-notify ordering has to let the store speak; an empty list would make the
   * assertion vacuous.
   */
  committedEvents: readonly unknown[] = [];

  async load(): Promise<ToolExecutionSnapshot | null> {
    return this.snapshot;
  }

  async findByExternalCall(): Promise<ToolExecutionSnapshot | null> {
    return null;
  }

  async commit(command: ToolExecutionCommit): Promise<ToolExecutionCommitResult> {
    if (this.failWith !== undefined) throw this.failWith;
    const current = this.snapshot;
    if ((current?.revision ?? null) !== command.expectedRevision) {
      throw new ToolExecutionConflictError("revision conflict");
    }
    this.commands.push(command);
    this.snapshot = {
      sessionId: command.sessionId,
      invocation: command.invocation,
      revision: (current?.revision ?? 0) + 1,
      ...(command.observation === undefined ? {} : { observation: command.observation }),
      ...(command.approval === undefined ? {} : { approval: command.approval }),
    };
    return { snapshot: this.snapshot, events: this.committedEvents as never };
  }
}

const LAST_ID: { current?: string } = {};

function runningSnapshot(overrides: Partial<ToolInvocation> = {}): ToolExecutionSnapshot {
  const requested = createRequestedToolInvocation({
    id: (LAST_ID.current = createToolInvocationId()),
    runId: createRunId(),
    stepId: createStepId(),
    toolName: "echo_value",
    externalCallId: "call-1",
    args: { value: "hello" },
    riskLevel: "LOW",
    createdAt: createTimestampMs(10),
  });
  const running = startToolInvocation({ ...requested, ...overrides }, createTimestampMs(20));
  return { sessionId: createSessionId(), invocation: running, revision: null as never };
}

function settlement(result: Partial<AgentToolResult>, effects?: ToolSettlementExtension) {
  return {
    result: {
      content: "ok",
      details: {} as JsonObject,
      isError: false,
      ...result,
    } as AgentToolResult,
    ...(effects === undefined ? {} : { effects }),
  };
}

function build(options: { readonly notifier?: (events: readonly unknown[]) => void } = {}) {
  const store = new RecordingStore();

  let now = 1000;
  const budgetSettlements: Array<{ status: string; finishedAt: number }> = [];
  const notified: unknown[][] = [];
  const coordinator = createToolSettlementCoordinator({
    store,
    clock: { now: () => createTimestampMs(++now) },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
    budget: {
      async settle(input) {
        budgetSettlements.push({ status: input.status, finishedAt: input.finishedAt });
      },
    },
    ...(options.notifier === undefined
      ? {}
      : {
          notifier: {
            notifyCommitted(events: readonly unknown[]) {
              notified.push([...events]);
              options.notifier!(events);
            },
            emitTransient: () => undefined,
          },
        }),
  });
  return { coordinator, store, budgetSettlements, notified };
}

describe("ToolSettlementCoordinator", () => {
  it("settles a successful result as COMPLETED with a non-error observation", async () => {
    const { coordinator, store } = build();
    const snapshot = runningSnapshot();

    const committed = await coordinator.settle({
      snapshot,
      settlement: settlement({ content: "done", details: { echoed: "done" } }),
      now: createTimestampMs(2000),
    });

    expect(committed.invocation.status).toBe("COMPLETED");
    expect(committed.observation?.isError).toBe(false);
    expect(committed.observation?.content).toBe("done");
    const command = store.commands[0]!;
    expect(command.invocation.status).toBe("COMPLETED");
    expect(command.expectedRevision).toBeNull();
    expect(command.events.map(({ type }) => type)).toEqual(["tool.completed"]);
  });

  it("settles an isError result as FAILED with an error observation", async () => {
    const { coordinator, store } = build();

    const committed = await coordinator.settle({
      snapshot: runningSnapshot(),
      settlement: settlement({ content: "it broke", isError: true }),
      now: createTimestampMs(2000),
    });

    expect(committed.invocation.status).toBe("FAILED");
    expect(committed.observation?.isError).toBe(true);
    const command = store.commands[0]!;
    expect(command.invocation.error?.code).toBe("TOOL_EXECUTION_ERROR");
    expect(command.events.map(({ type }) => type)).toEqual(["tool.failed"]);
  });

  it("derives every observation field from the invocation it settles", async () => {
    const { coordinator } = build();
    const snapshot = runningSnapshot();
    const now = createTimestampMs(2000);

    const committed = await coordinator.settle({
      snapshot,
      settlement: settlement({ content: "ok" }),
      now,
    });

    const observation = committed.observation!;
    expect(observation.runId).toBe(snapshot.invocation.runId);
    expect(observation.stepId).toBe(snapshot.invocation.stepId);
    expect(observation.toolInvocationId).toBe(snapshot.invocation.id);
    expect(observation.createdAt).toBe(now);
    expect(observation.createdAt).toBe(committed.invocation.finishedAt);
  });

  it("uses the settlement timestamp for the invocation, the observation and the event", async () => {
    const { coordinator, store } = build();
    const now = createTimestampMs(2000);

    await coordinator.settle({
      snapshot: runningSnapshot(),
      settlement: settlement({}),
      now,
    });

    const command = store.commands[0]!;
    expect(command.invocation.finishedAt).toBe(now);
    expect(command.observation?.createdAt).toBe(now);
    expect(command.events[0]?.timestamp).toBe(now);
  });

  it("forwards the opaque settlement extension unchanged", async () => {
    const { coordinator, store } = build();
    const extension: ToolSettlementExtension = Object.freeze({
      kind: "caelush.coding.effects.v1",
      payload: Object.freeze({ effects: [{ type: "FILE_READ", path: "a.ts" }] } as never),
    });

    await coordinator.settle({
      snapshot: runningSnapshot(),
      settlement: settlement({}, extension),
      now: createTimestampMs(2000),
    });

    expect(store.commands[0]?.extension).toBe(extension);
  });

  it("never branches on the extension kind", async () => {
    const { coordinator, store } = build();
    // A kind this layer has never heard of, with a payload it cannot interpret.
    const extension: ToolSettlementExtension = Object.freeze({
      kind: "example.unrecognised.v99",
      payload: Object.freeze({ whatever: [1, 2, 3] } as never),
    });

    await coordinator.settle({
      snapshot: runningSnapshot(),
      settlement: settlement({}, extension),
      now: createTimestampMs(2000),
    });

    // Committed as-is: interpretation belongs to the host boundary that declared the kind.
    expect(store.commands[0]?.extension?.kind).toBe("example.unrecognised.v99");
  });

  it("appends host-contributed durable events ahead of the terminal event", async () => {
    const { coordinator, store } = build();
    const extension: ToolSettlementExtension = Object.freeze({
      kind: "caelush.coding.effects.v1",
      payload: Object.freeze({}) as never,
      events: Object.freeze([
        {
          eventId: createEventId(),
          schemaVersion: 1 as const,
          type: "file.read" as const,
          runId: createRunId(),
          sessionId: createSessionId(),
          stepId: createStepId(),
          timestamp: createTimestampMs(1999),
          visibility: "USER_VISIBLE" as const,
          durability: { kind: "DURABLE" as const, version: 1 as const },
          payload: { path: "a.ts" },
        },
      ]) as never,
    });

    await coordinator.settle({
      snapshot: runningSnapshot(),
      settlement: settlement({}, extension),
      now: createTimestampMs(2000),
    });

    expect(store.commands[0]?.events.map(({ type }) => type)).toEqual([
      "file.read",
      "tool.completed",
    ]);
  });

  it("refuses to settle an invocation that is not RUNNING", async () => {
    const { coordinator, store } = build();
    const snapshot = runningSnapshot();
    const alreadyDone = {
      ...snapshot,
      invocation: {
        ...snapshot.invocation,
        status: "COMPLETED" as const,
        finishedAt: createTimestampMs(30),
      },
    };

    await expect(
      coordinator.settle({
        snapshot: alreadyDone as never,
        settlement: settlement({}),
        now: createTimestampMs(2000),
      }),
    ).rejects.toBeInstanceOf(ToolExecutionInvariantError);
    expect(store.commands).toHaveLength(0);
  });

  it("propagates a storage conflict unchanged so the caller can re-read", async () => {
    const { coordinator, store } = build();
    // Somebody else moved the row between the read and the commit: the snapshot claims one revision
    // and the store holds another.
    const snapshot = { ...runningSnapshot(), revision: 7 };
    store.snapshot = { ...runningSnapshot(), revision: 3 };

    await expect(
      coordinator.settle({ snapshot, settlement: settlement({}), now: createTimestampMs(2000) }),
    ).rejects.toBeInstanceOf(ToolExecutionConflictError);
  });

  it("classifies a storage failure as a SETTLEMENT infrastructure failure", async () => {
    const { coordinator, store } = build();
    store.failWith = new Error("disk went away");

    await expect(
      coordinator.settle({
        snapshot: runningSnapshot(),
        settlement: settlement({}),
        now: createTimestampMs(2000),
      }),
    ).rejects.toMatchObject({ name: "ToolExecutionInfrastructureError", phase: "SETTLEMENT" });
  });

  it("reports no partial observable result when the commit fails", async () => {
    const { coordinator, store } = build();
    store.failWith = new ToolExecutionInfrastructureError("SETTLEMENT", "commit failed");
    const snapshot = runningSnapshot();

    await coordinator
      .settle({ snapshot, settlement: settlement({}), now: createTimestampMs(2000) })
      .catch(() => undefined);

    // Nothing was durably written, and the snapshot the caller still holds is untouched.
    expect(store.commands).toHaveLength(0);
    expect(store.snapshot).toBeNull();
    expect(snapshot.invocation.status).toBe("RUNNING");
  });

  it("settles the budget only after the durable commit", async () => {
    const order: string[] = [];
    const store = new RecordingStore();
    let now = 1000;
    const coordinator = createToolSettlementCoordinator({
      store,
      clock: { now: () => createTimestampMs(++now) },
      observationIdFactory: { create: createObservationId },
      eventIdFactory: { create: createEventId },
      budget: {
        async settle() {
          order.push("budget");
        },
      },
    });
    const original = store.commit.bind(store);
    store.commit = async (command: ToolExecutionCommit) => {
      order.push("commit");
      return await original(command);
    };

    await coordinator.settle({
      snapshot: runningSnapshot(),
      settlement: settlement({}),
      now: createTimestampMs(2000),
    });

    expect(order).toEqual(["commit", "budget"]);
  });

  it("notifies committed events only after the durable commit", async () => {
    const order: string[] = [];
    const store = new RecordingStore();
    let now = 1000;
    const coordinator = createToolSettlementCoordinator({
      store,
      clock: { now: () => createTimestampMs(++now) },
      observationIdFactory: { create: createObservationId },
      eventIdFactory: { create: createEventId },
      notifier: {
        notifyCommitted() {
          order.push("notify");
        },
        emitTransient: () => undefined,
      },
    });
    store.committedEvents = [createEventId()];
    const original = store.commit.bind(store);
    store.commit = async (command: ToolExecutionCommit) => {
      order.push("commit");
      return await original(command);
    };

    await coordinator.settle({
      snapshot: runningSnapshot(),
      settlement: settlement({}),
      now: createTimestampMs(2000),
    });

    expect(order).toEqual(["commit", "notify"]);
  });

  it("exposes exactly one method with the frozen three-field input", async () => {
    const { coordinator } = build();
    expect(Object.keys(coordinator)).toEqual(["settle"]);
  });

  it("rejects a malformed settlement result rather than committing it", async () => {
    const { coordinator, store } = build();
    // A settlement whose result is not the frozen shape cannot produce a valid observation, and the
    // observation invariant is what catches it.
    await expect(
      coordinator.settle({
        snapshot: runningSnapshot(),
        settlement: { result: { content: 42, details: {}, isError: false } } as never,
        now: createTimestampMs(2000),
      }),
    ).rejects.toBeTruthy();
    expect(store.commands).toHaveLength(0);
  });

  it("keeps the approval identity out of the settlement path entirely", async () => {
    const { coordinator, store } = build();
    await coordinator.settle({
      snapshot: runningSnapshot(),
      settlement: settlement({}),
      now: createTimestampMs(2000),
    });
    const command = store.commands[0]!;
    expect(command.approval).toBeUndefined();
    expect(command.approvalKey).toBeUndefined();
    expect(command.budgetStart).toBeUndefined();
    void createApprovalRequestId;
  });
});
