import {
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createWorkspaceId,
  type AgentEvent,
  type ClientAgentRun,
  type ClientAgentSession,
  type DaemonInfo,
  type DefaultRunConfiguration,
  type HealthResponse,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CaelushClientProtocolError } from "@caelush/client";
import {
  CliConversationController,
  type CliDaemonClient,
} from "../src/application/cli-controller.js";

const defaultRunConfiguration: DefaultRunConfiguration = {
  runtime: { id: "local", kind: "local" },
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
  limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
};

describe("CliConversationController", () => {
  it("bootstraps health, compatibility, and one Session for the current workspace", async () => {
    const calls: string[] = [];
    const session = makeSession();
    const info = makeInfo();
    const client: CliDaemonClient = {
      getHealth: async () => {
        calls.push("health");
        return makeHealth();
      },
      getInfo: async () => {
        calls.push("info");
        return info;
      },
      createSession: async (input) => {
        calls.push("createSession");
        expect(input).toEqual({
          title: "project",
          defaultWorkspace: { id: expect.any(String), path: "C:\\workspace\\project" },
          defaultModel: { provider: "fixture", model: "fixture-model" },
          metadata: {},
        });
        return session;
      },
      createRun: async () => {
        throw new Error("not used");
      },
      watchRunEvents: async function* () {
        throw new Error("not used");
        yield* [] as AgentEvent[];
      },
      startRun: async () => {
        throw new Error("not used");
      },
      getRun: async () => {
        throw new Error("not used");
      },
    };
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });

    await controller.bootstrap();

    expect(calls).toEqual(["health", "info", "createSession"]);
    expect(controller.getState()).toMatchObject({
      bootstrap: "READY",
      session,
      composerEnabled: true,
      activity: "Ready",
    });
  });

  it("creates one guarded Run and starts the watch before startRun", async () => {
    const calls: string[] = [];
    const run = makeRun("the first prompt");
    const client = makeClient({
      calls,
      createRun: async (_sessionId, input) => {
        calls.push("createRun");
        expect(input).toMatchObject({
          goal: "the first prompt",
          workspace: { path: "C:\\workspace\\project" },
          model: { provider: "fixture", model: "fixture-model" },
          ...defaultRunConfiguration,
        });
        return run;
      },
      watchRunEvents: async function* () {
        calls.push("watch");
        await new Promise<void>(() => undefined);
        yield* [] as AgentEvent[];
      },
      startRun: async () => {
        calls.push("startRun");
        return actionResponse(run);
      },
    });
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });
    await controller.bootstrap();

    const first = controller.submitPrompt(" the first prompt ");
    const second = controller.submitPrompt("the second prompt");
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);

    expect(calls).toEqual(["createRun", "watch", "startRun"]);
    expect(controller.getState().displayHistory).toEqual([
      { id: "user-1", kind: "USER", text: "the first prompt", runId: run.id },
    ]);
    expect(controller.getState().composerEnabled).toBe(false);
    controller.dispose();
  });

  it("ignores empty prompts and refuses prompts above the UTF-8 bound", async () => {
    const client = makeClient();
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });
    await controller.bootstrap();

    await expect(controller.submitPrompt("  ")).resolves.toBe(false);
    await expect(controller.submitPrompt("😀".repeat(300_000))).resolves.toBe(false);
    expect(controller.getState().displayHistory).toEqual([]);
  });

  it("fails safely before Session creation when the daemon is unreachable", async () => {
    let sessionCalls = 0;
    const controller = new CliConversationController({
      client: makeClient({
        getHealth: async () => {
          throw new CaelushClientProtocolError("Daemon request failed: ECONNREFUSED");
        },
        createSession: async () => {
          sessionCalls += 1;
          return makeSession();
        },
      }),
      workspacePath: "C:\\workspace\\project",
    });

    await controller.bootstrap();

    expect(sessionCalls).toBe(0);
    expect(controller.getState()).toMatchObject({
      bootstrap: "BOOTSTRAP_ERROR",
      composerEnabled: false,
      fatalError: "Caelush Local Agent Service is not reachable.",
    });
  });

  it("fails safely before Session creation when public defaults are missing", async () => {
    let sessionCalls = 0;
    const controller = new CliConversationController({
      client: makeClient({
        getInfo: async () => ({ ...makeInfo(), defaultModel: undefined }) as unknown as DaemonInfo,
        createSession: async () => {
          sessionCalls += 1;
          return makeSession();
        },
      }),
      workspacePath: "C:\\workspace\\project",
    });

    await controller.bootstrap();

    expect(sessionCalls).toBe(0);
    expect(controller.getState()).toMatchObject({
      bootstrap: "BOOTSTRAP_ERROR",
      fatalError: "Daemon is missing a default model or Run configuration.",
    });
  });
});

export function makeClient(overrides: Partial<CliDaemonClient> = {}): CliDaemonClient {
  const session = makeSession();
  const run = makeRun("prompt");
  return {
    getHealth: async () => makeHealth(),
    getInfo: async () => makeInfo(),
    createSession: async () => session,
    createRun: async () => run,
    watchRunEvents: async function* () {
      await new Promise<void>(() => undefined);
      yield* [] as AgentEvent[];
    },
    startRun: async () => actionResponse(run),
    getRun: async () => run,
    ...overrides,
  };
}

export function makeInfo(): DaemonInfo {
  return {
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
    defaultRunConfiguration,
  };
}

export function makeHealth(): HealthResponse {
  return {
    service: "caelush-daemon",
    status: "ready",
    apiVersion: "v1",
    protocolVersion: 1,
  };
}

export function makeSession(): ClientAgentSession {
  return {
    id: createSessionId(),
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  };
}

export function makeRun(goal: string): ClientAgentRun {
  return {
    id: createRunId(),
    sessionId: createSessionId(),
    goal,
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "C:\\workspace\\project" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: defaultRunConfiguration.limits,
    model: { provider: "fixture", model: "fixture-model" },
    createdAt: 1,
  };
}

export function actionResponse(run: ClientAgentRun) {
  return {
    runId: run.id,
    action: "START" as const,
    disposition: "SCHEDULED" as const,
    run,
  };
}

export function completedEvent(run: ClientAgentRun): AgentEvent {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    type: "run.completed",
    runId: run.id,
    sessionId: run.sessionId,
    stepId: createStepId(),
    timestamp: 2,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence: 1 },
    payload: { result: { type: "VERIFIED_COMPLETION" } },
  } as AgentEvent;
}
