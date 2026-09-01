import {
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createVerificationPlanId,
  createWorkspaceId,
  type AgentEvent,
  type ClientAgentRun,
  type ClientAgentSession,
  type DaemonInfo,
  type HealthResponse,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  CliConversationController,
  type CliDaemonClient,
} from "../src/application/cli-controller.js";

describe("CLI terminal lifecycle", () => {
  it("fetches one canonical Run and appends only its verified final text", async () => {
    const run = makeRun("complete this");
    const completed = makeRun("complete this", {
      status: "COMPLETED",
      finishedAt: 3,
      finalResult: verifiedFinalResult("verified answer"),
    });
    let getRunCalls = 0;
    const client = makeClient({
      createRun: async () => run,
      watchRunEvents: async function* () {
        yield terminalEvent(run, "run.completed", { result: { hidden: "ignored" } });
      },
      getRun: async () => {
        getRunCalls += 1;
        return completed;
      },
    });
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });
    await controller.bootstrap();

    await controller.submitPrompt("complete this");
    await waitFor(() => controller.getState().activeRun === undefined);

    expect(getRunCalls).toBe(1);
    expect(controller.getState().displayHistory.at(-1)).toMatchObject({
      kind: "ASSISTANT",
      text: "verified answer",
    });
    expect(JSON.stringify(controller.getState())).not.toContain("ignored");
    expect(controller.getState().composerEnabled).toBe(true);
  });

  it("renders non-completed canonical status without fabricating an assistant answer", async () => {
    const run = makeRun("fail this");
    const failed = makeRun("fail this", { status: "FAILED", finishedAt: 3 });
    const client = makeClient({
      createRun: async () => run,
      watchRunEvents: async function* () {
        yield terminalEvent(run, "run.failed", { error: { message: "hidden" } });
      },
      getRun: async () => failed,
    });
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });
    await controller.bootstrap();

    await controller.submitPrompt("fail this");
    await waitFor(() => controller.getState().activeRun === undefined);

    expect(controller.getState().displayHistory.at(-1)).toMatchObject({
      kind: "RUN_TERMINAL",
      text: "Run ended with status FAILED.",
    });
    expect(controller.getState().displayHistory.some((entry) => entry.kind === "ASSISTANT")).toBe(
      false,
    );
  });

  it("returns to the recovery picker when another Run remains active in the Session", async () => {
    const run = makeRun("finish one");
    const completed = makeRun("finish one", {
      id: run.id,
      status: "COMPLETED",
      finishedAt: 3,
      finalResult: verifiedFinalResult("verified answer"),
    });
    const remaining = makeRun("keep the other one", { status: "RUNNING" });
    const client = makeClient({
      createRun: async () => run,
      watchRunEvents: async function* () {
        yield terminalEvent(run, "run.completed", { result: { hidden: "ignored" } });
      },
      getRun: async () => completed,
      listRuns: async () => ({ items: [completed, remaining] }),
    });
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });
    await controller.bootstrap();

    await controller.submitPrompt("finish one");
    await waitFor(() => controller.getState().controlMode === "RUN_RECOVERY_PICKER");

    expect(controller.getState().recoveryCandidates.map((candidate) => candidate.id)).toEqual([
      remaining.id,
    ]);
    expect(controller.getState().composerEnabled).toBe(false);
    controller.dispose();
  });

  it("keeps the active Run locked on SSE failure and never calls cancellation", async () => {
    const run = makeRun("observe this");
    let cancelCalls = 0;
    const client = makeClient({
      createRun: async () => run,
      watchRunEvents: async function* () {
        throw new Error("raw daemon internals");
        yield* [] as AgentEvent[];
      },
      startRun: async () => actionResponse(run),
    });
    (client as CliDaemonClient & { cancelRun(): Promise<void> }).cancelRun = async () => {
      cancelCalls += 1;
    };
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });
    await controller.bootstrap();

    await controller.submitPrompt("observe this");
    await waitFor(() => controller.getState().activity === "Transport error");

    expect(cancelCalls).toBe(0);
    expect(controller.getState().activeRun?.runId).toBe(run.id);
    expect(controller.getState().composerEnabled).toBe(false);
    expect(JSON.stringify(controller.getState())).not.toContain("raw daemon internals");
  });

  it("aborts an active stream on dispose without cancelling the daemon Run", async () => {
    const run = makeRun("dispose this");
    let aborted = false;
    const client = makeClient({
      createRun: async () => run,
      watchRunEvents: async function* (_runId, options) {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        yield* [] as AgentEvent[];
      },
    });
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });
    await controller.bootstrap();
    await controller.submitPrompt("dispose this");

    controller.dispose();
    await waitFor(() => aborted);
    expect(aborted).toBe(true);
  });
});

function makeClient(overrides: Partial<CliDaemonClient> = {}): CliDaemonClient {
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
    listSessions: async () => ({ items: [session] }),
    getSession: async () => session,
    listRuns: async () => ({ items: [] }),
    recoverRun: async () => actionResponse(run),
    cancelRun: async () => actionResponse(run),
    listPendingApprovals: async () => ({ items: [] }),
    resolveApproval: async () => actionResponse(run),
    ...overrides,
  };
}

function makeInfo(): DaemonInfo {
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
    defaultRunConfiguration: {
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    },
  };
}

function makeHealth(): HealthResponse {
  return {
    service: "caelush-daemon",
    status: "ready",
    apiVersion: "v1",
    protocolVersion: 1,
  };
}

function makeSession(): ClientAgentSession {
  return { id: createSessionId(), createdAt: 1, updatedAt: 1, metadata: {} };
}

function makeRun(goal: string, overrides: Partial<ClientAgentRun> = {}): ClientAgentRun {
  return {
    id: createRunId(),
    sessionId: createSessionId(),
    goal,
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "C:\\workspace\\project" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    model: { provider: "fixture", model: "fixture-model" },
    createdAt: 1,
    ...overrides,
  };
}

function actionResponse(run: ClientAgentRun) {
  return { runId: run.id, action: "START" as const, disposition: "SCHEDULED" as const, run };
}

function terminalEvent(
  run: ClientAgentRun,
  type: "run.completed" | "run.failed",
  payload: unknown,
): AgentEvent {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    type,
    runId: run.id,
    sessionId: run.sessionId,
    stepId: createStepId(),
    timestamp: 2,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence: 1 },
    payload,
  } as AgentEvent;
}

function verifiedFinalResult(text: string) {
  const digest = "a".repeat(64);
  return {
    type: "VERIFIED_COMPLETION",
    text,
    verification: {
      planId: createVerificationPlanId(),
      sourceStepId: createStepId(),
      planHash: digest,
      candidateHash: digest,
      evidenceDigest: digest,
      freshnessHash: digest,
      sealHash: digest,
      checks: { total: 1, passed: 1, skipped: 0, advisoryWarnings: 0 },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(predicate()).toBe(true);
}
