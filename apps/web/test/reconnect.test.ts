import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  ClientAgentRun,
  ClientAgentSession,
  DaemonInfo,
  WorkspaceRef,
} from "@caelush/protocol";
import {
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  DaemonInfoSchema,
  createRunId,
  createSessionId,
  createWorkspaceId,
} from "@caelush/protocol";
import type { Timer, TimerHandle, WatchRunEventsOptions } from "@caelush/client";
import { WebSessionManager, type WebSessionClient } from "../src/application/session-manager.js";

describe("WebSessionManager live run reconnection", () => {
  it("replays from the retained durable sequence without replacing Timeline entries", async () => {
    const run = makeRun();
    const timer = new FakeTimer();
    const client = makeClient(run);
    client.watchRunEvents.mockImplementationOnce(async function* (_runId, options) {
      options?.onOpen?.();
      yield durableReasoning(run, 50, "before loss");
      throw new Error("network lost");
    });
    client.watchRunEvents.mockImplementationOnce(async function* (_runId, options) {
      options?.onOpen?.();
      yield durableReasoning(run, 51, "replayed one");
      yield durableReasoning(run, 52, "replayed two");
      yield durableReasoning(run, 53, "replayed three");
      await new Promise<void>(() => undefined);
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo(), timer });

    manager.beginDraft();
    await expect(manager.submitPrompt("reconnect")).resolves.toBe(true);
    await waitFor(() => timer.delays.length === 1);
    timer.fireNext();
    await waitFor(() => manager.getSnapshot().timeline.lastDurableSequence === 53);

    expect(client.watchRunEvents.mock.calls.map(([, options]) => options?.afterSequence)).toEqual([
      0, 50,
    ]);
    expect(manager.getSnapshot().timeline.settled).toMatchObject([
      { kind: "REASONING", text: "before loss" },
      { kind: "REASONING", text: "replayed one" },
      { kind: "REASONING", text: "replayed two" },
      { kind: "REASONING", text: "replayed three" },
    ]);
    expect(manager.getSnapshot().transportState).toBe("CONNECTED");
    manager.dispose();
  });

  it("aborts the old stream before replacement and ignores its late events", async () => {
    const run = makeRun();
    const timer = new FakeTimer();
    const client = makeClient(run);
    let firstOptions: WatchRunEventsOptions | undefined;
    client.watchRunEvents.mockImplementationOnce(async function* (_runId, options) {
      firstOptions = options;
      options?.onOpen?.();
      yield durableReasoning(run, 1, "first");
      throw new Error("lost");
    });
    client.watchRunEvents.mockImplementationOnce(async function* (_runId, options) {
      options?.onOpen?.();
      yield durableReasoning(run, 2, "second");
      await new Promise<void>(() => undefined);
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo(), timer });

    manager.beginDraft();
    await manager.submitPrompt("replace stream");
    await waitFor(() => timer.delays.length === 1);
    timer.fireNext();
    await waitFor(() => manager.getSnapshot().timeline.lastDurableSequence === 2);
    expect(firstOptions?.signal.aborted).toBe(true);
    expect(client.watchRunEvents).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it("discards a late recovery result from a replaced stream generation", async () => {
    const run = makeRun();
    const timer = new FakeTimer();
    const client = makeClient(run);
    const lateRecovery = deferred<{ disposition: "SCHEDULED"; run: ClientAgentRun }>();
    let streamCount = 0;
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      streamCount += 1;
      options?.onOpen?.();
      if (streamCount === 3) {
        await new Promise<void>(() => undefined);
      }
      throw new Error("lost");
    });
    client.recoverRun.mockImplementationOnce(async () => lateRecovery.promise);
    client.recoverRun.mockImplementationOnce(async () => ({ disposition: "SCHEDULED", run }));
    const manager = new WebSessionManager({ client, workspace, info: makeInfo(), timer });

    manager.beginDraft();
    await manager.submitPrompt("guard old recovery");
    await waitFor(() => timer.delays.length === 1);
    timer.fireNext();
    await waitFor(() => timer.delays.length === 2);
    timer.fireNext();
    await waitFor(() => client.recoverRun.mock.calls.length === 2);
    lateRecovery.resolve({ disposition: "SCHEDULED", run: makeRun({ ...run, status: "RUNNING" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.getSnapshot().activeRun?.status).toBe("PENDING");
    manager.dispose();
  });

  it("uses all six shared retry delays, disconnects on exhaustion, and manual reconnect does not create a Run", async () => {
    const run = makeRun();
    const timer = new FakeTimer();
    const client = makeClient(run);
    let connectionCount = 0;
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      if (connectionCount++ === 0) options?.onOpen?.();
      throw new Error("lost");
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo(), timer });

    manager.beginDraft();
    await manager.submitPrompt("exhaust retries");
    for (let index = 0; index < 6; index += 1) {
      await waitFor(() => timer.delays.length === index + 1);
      timer.fireNext();
    }
    await waitFor(() => manager.getSnapshot().transportState === "DISCONNECTED");

    expect(timer.delays).toEqual([250, 500, 1000, 2000, 4000, 5000]);
    expect(manager.getSnapshot().error?.code).toBe("RUN_RECONNECT_EXHAUSTED");
    const createCalls = client.createRun.mock.calls.length;
    manager.reconnectActiveRun();
    expect(client.createRun).toHaveBeenCalledTimes(createCalls);
    expect(timer.delays).toHaveLength(7);
    manager.dispose();
  });
});

class FakeTimer implements Timer {
  readonly delays: number[] = [];
  private readonly callbacks: (() => void)[] = [];

  schedule(delayMs: number, callback: () => void): TimerHandle {
    this.delays.push(delayMs);
    this.callbacks.push(callback);
    return { cancel: () => undefined };
  }

  fireNext(): void {
    this.callbacks.shift()?.();
  }
}

const workspace: WorkspaceRef = { id: createWorkspaceId(), path: "D:/workspace" };

function makeClient(
  run: ClientAgentRun,
): WebSessionClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    listSessions: vi.fn(async () => ({ items: [] })),
    listRuns: vi.fn(async () => ({ items: [] })),
    getSession: vi.fn(),
    createSession: vi.fn(async () => makeSession()),
    createRun: vi.fn(async () => run),
    getRun: vi.fn(async () => run),
    listPendingApprovals: vi.fn(async () => ({ items: [] })),
    resolveApproval: vi.fn(),
    startRun: vi.fn(async () => ({ disposition: "SCHEDULED", run })),
    recoverRun: vi.fn(async () => ({ disposition: "SCHEDULED", run })),
    cancelRun: vi.fn(),
    watchRunEvents: vi.fn(),
  } as unknown as WebSessionClient & Record<string, ReturnType<typeof vi.fn>>;
}

function makeInfo(): DaemonInfo {
  return DaemonInfoSchema.parse({
    apiVersion: "v1",
    protocolVersion: 1,
    daemonVersion: "test",
    capabilities: {
      runExecution: true,
      runRecovery: true,
      cancellation: true,
      approvals: true,
      sseReplay: true,
    },
    runtimeKinds: ["local"],
    configuredProviders: ["fixture"],
    defaultModel: { provider: "fixture", model: "fixture" },
    defaultRunConfiguration: {
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 1000 },
    },
  });
}

function makeSession(): ClientAgentSession {
  return ClientAgentSessionSchema.parse({
    id: createSessionId(),
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  });
}

function makeRun(overrides: Partial<ClientAgentRun> = {}): ClientAgentRun {
  return ClientAgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "test",
    status: "PENDING",
    workspace,
    model: { provider: "fixture", model: "fixture" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 1000 },
    createdAt: 1,
    ...overrides,
  });
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function durableReasoning(run: ClientAgentRun, sequence: number, summary: string): AgentEvent {
  return {
    type: "reasoning.summary",
    eventId: `evt_00000000-0000-7000-8000-${sequence.toString().padStart(12, "0")}`,
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    timestamp: sequence,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", sequence },
    payload: { summary },
  } as AgentEvent;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}
