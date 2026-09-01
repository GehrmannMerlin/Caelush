import {
  AgentEventSchema,
  createEventId,
  createRunId,
  createSessionId,
  createToolInvocationId,
  createWorkspaceId,
  type AgentEvent,
  type ClientAgentRun,
  type ClientAgentSession,
  type RunActionResponse,
  type RunListResponse,
} from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  CliConversationController,
  type CliDaemonClient,
} from "../src/application/cli-controller.js";
import type { CliTimer, CliTimerHandle } from "../src/application/reconnect-scheduler.js";

const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
const session: ClientAgentSession = {
  id: createSessionId(),
  createdAt: 1,
  updatedAt: 1,
  metadata: {},
  defaultWorkspace: workspace,
};

describe("CLI stream reconnect", () => {
  it("reconnects after the current durable cursor and ignores stale generations", async () => {
    const run = makeRun({ status: "RUNNING" });
    const timer = new FakeTimer();
    const watchCalls: Array<{ readonly afterSequence?: number }> = [];
    let watchCount = 0;
    const currentEvent = makeShellEvent(run, 5, "current");
    const client = makeClient({
      listRuns: async (): Promise<RunListResponse> => ({ items: [run] }),
      watchRunEvents: async function* (...args) {
        const options = args[1];
        watchCount += 1;
        watchCalls.push({ afterSequence: options?.afterSequence });
        options?.onOpen?.();
        if (watchCount === 1) {
          yield currentEvent;
          throw new Error("first stream closed");
        }
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield* [] as AgentEvent[];
      },
      recoverRun: vi.fn(async () => actionResponse(run, "RECOVER")),
    });
    const controller = new CliConversationController({
      client,
      workspacePath: workspace.path,
      launchIntent: { kind: "RESUME_EXACT", sessionId: session.id },
      timer,
    });

    await controller.bootstrap();
    await waitFor(() => controller.getState().transportState === "RECONNECTING");
    timer.runNext();
    await waitFor(() => watchCalls.length === 2);

    expect(watchCalls).toEqual([{ afterSequence: 0 }, { afterSequence: 5 }]);
    expect(controller.getState().timeline.lastDurableSequence).toBe(5);
    expect(JSON.stringify(controller.getState())).toContain("current");
    expect(JSON.stringify(controller.getState())).not.toContain("stale");
    controller.dispose();
  });

  it("becomes DISCONNECTED after six failed reconnect attempts and supports manual R retry", async () => {
    const run = makeRun({ status: "RUNNING" });
    const timer = new FakeTimer();
    const client = makeClient({
      listRuns: async (): Promise<RunListResponse> => ({ items: [run] }),
      watchRunEvents: async function* () {
        throw new Error("connection failed");
        yield* [] as AgentEvent[];
      },
    });
    const controller = new CliConversationController({
      client,
      workspacePath: workspace.path,
      launchIntent: { kind: "RESUME_EXACT", sessionId: session.id },
      timer,
    });

    await controller.bootstrap();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await waitFor(() => timer.pendingCount === 1);
      timer.runNext();
    }
    await waitFor(() => controller.getState().transportState === "DISCONNECTED");
    expect(controller.getState().transportError).toContain("Connection to the local Agent service");

    controller.reconnectActiveRun();
    expect(controller.getState().transportState).toBe("RECONNECTING");
    controller.dispose();
  });
});

class FakeTimer implements CliTimer {
  readonly delays: number[] = [];
  private callbacks: Array<{ callback: () => void; cancelled: boolean }> = [];

  get pendingCount(): number {
    return this.callbacks.filter((item) => !item.cancelled).length;
  }

  schedule(delayMs: number, callback: () => void): CliTimerHandle {
    const item = { callback, cancelled: false };
    this.delays.push(delayMs);
    this.callbacks.push(item);
    return { cancel: () => (item.cancelled = true) };
  }

  runNext(): void {
    const item = this.callbacks.find((candidate) => !candidate.cancelled);
    if (item === undefined) throw new Error("No timer is pending");
    item.cancelled = true;
    item.callback();
  }
}

const defaultRun: ClientAgentRun = {
  id: createRunId(),
  sessionId: session.id,
  goal: "reconnect this Run",
  status: "PENDING",
  workspace,
  runtime: { id: "local", kind: "local" },
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
  limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
  model: { provider: "fixture", model: "fixture-model" },
  createdAt: 1,
};

function makeRun(overrides: Partial<ClientAgentRun> = {}): ClientAgentRun {
  return { ...defaultRun, id: createRunId(), ...overrides };
}

function makeClient(overrides: Partial<CliDaemonClient> = {}): CliDaemonClient {
  return {
    getHealth: async () => ({
      service: "caelush-daemon",
      status: "ready",
      apiVersion: "v1",
      protocolVersion: 1,
    }),
    getInfo: async () => ({
      apiVersion: "v1",
      protocolVersion: 1,
      daemonVersion: "0.1.0",
      capabilities: {
        runExecution: true,
        runRecovery: true,
        cancellation: true,
        approvals: true,
        sseReplay: true,
      },
      runtimeKinds: ["local"],
      configuredProviders: ["fixture"],
      defaultModel: { provider: "fixture", model: "fixture-model" },
      defaultRunConfiguration: {
        runtime: { id: "local", kind: "local" },
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "DANGEROUS_ONLY",
        limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
      },
    }),
    createSession: async () => session,
    listSessions: async () => ({ items: [session] }),
    getSession: async () => session,
    createRun: async () => defaultRun,
    listRuns: async () => ({ items: [] }),
    watchRunEvents: async function* () {
      await new Promise<void>(() => undefined);
      yield* [] as AgentEvent[];
    },
    startRun: async () => actionResponse(defaultRun, "START"),
    recoverRun: async () => actionResponse(defaultRun, "RECOVER"),
    cancelRun: async () => actionResponse(defaultRun, "CANCEL"),
    getRun: async () => defaultRun,
    listPendingApprovals: async () => ({ items: [] }),
    resolveApproval: async () => actionResponse(defaultRun, "RESOLVE_APPROVAL"),
    ...overrides,
  };
}

function actionResponse(
  run: ClientAgentRun,
  action: RunActionResponse["action"],
): RunActionResponse {
  return { runId: run.id, action, disposition: "SCHEDULED", run };
}

function makeShellEvent(run: ClientAgentRun, sequence: number, chunk: string): AgentEvent {
  return AgentEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    type: "shell.output",
    timestamp: sequence,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence },
    payload: { invocationId: createToolInvocationId(), stream: "stdout", chunk },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(predicate()).toBe(true);
}
