import {
  createRunId,
  createSessionId,
  createStepId,
  createVerificationPlanId,
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

const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
const session: ClientAgentSession = {
  id: createSessionId(),
  createdAt: 1,
  updatedAt: 1,
  metadata: {},
  defaultWorkspace: workspace,
};

describe("CLI cancellation and detach", () => {
  it("uses the canonical settled Run status instead of fabricating CANCELLED", async () => {
    const running = makeRun({ status: "RUNNING" });
    const completed = makeRun({
      id: running.id,
      status: "COMPLETED",
      finishedAt: 3,
      finalResult: verifiedFinalResult("completed before cancellation settled"),
    });
    const cancelRun = vi.fn(async () => actionResponse(completed, "CANCEL"));
    const controller = await boot(
      makeClient({
        listRuns: async (): Promise<RunListResponse> => ({ items: [running] }),
        cancelRun,
      }),
    );

    await expect(controller.cancelActiveRun()).resolves.toBe(true);

    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(controller.getState().activeRun).toBeUndefined();
    expect(controller.getState().displayHistory.at(-1)).toMatchObject({
      kind: "ASSISTANT",
      text: "completed before cancellation settled",
    });
    expect(controller.getState().activity).not.toBe("Cancelled");
    controller.dispose();
  });

  it("deduplicates repeated cancellation while the first request is in flight", async () => {
    const running = makeRun({ status: "RUNNING" });
    let release!: (response: RunActionResponse) => void;
    const cancelRun = vi.fn(() => new Promise<RunActionResponse>((resolve) => (release = resolve)));
    const controller = await boot(
      makeClient({
        listRuns: async (): Promise<RunListResponse> => ({ items: [running] }),
        cancelRun,
      }),
    );

    const first = controller.cancelActiveRun();
    const second = controller.cancelActiveRun();
    expect(controller.getState().controlMode).toBe("CANCELLING");
    expect(cancelRun).toHaveBeenCalledTimes(1);
    release(actionResponse(makeRun({ id: running.id, status: "CANCELLED" }), "CANCEL"));

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    controller.dispose();
  });

  it("keeps the active Run after a cancellation failure and exposes a recoverable error", async () => {
    const running = makeRun({ status: "RUNNING" });
    const controller = await boot(
      makeClient({
        listRuns: async (): Promise<RunListResponse> => ({ items: [running] }),
        cancelRun: async () => {
          throw new Error("secret daemon failure");
        },
      }),
    );

    await expect(controller.cancelActiveRun()).resolves.toBe(false);

    expect(controller.getState().activeRun?.runId).toBe(running.id);
    expect(controller.getState().controlMode).not.toBe("CANCELLING");
    expect(controller.getState().controlError).toBe(
      "Cancellation could not be confirmed. The Run may still be active.",
    );
    expect(JSON.stringify(controller.getState())).not.toContain("secret daemon failure");
    controller.dispose();
  });

  it("detaches only the local stream and never calls cancelRun", async () => {
    const running = makeRun({ status: "RUNNING" });
    let aborted = false;
    const cancelRun = vi.fn(async () => actionResponse(running, "CANCEL"));
    const controller = await boot(
      makeClient({
        listRuns: async (): Promise<RunListResponse> => ({ items: [running] }),
        cancelRun,
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
      }),
    );

    controller.detachActiveRun();
    await waitFor(() => aborted);

    expect(cancelRun).not.toHaveBeenCalled();
    expect(controller.getState().notice).toBe("The active Run continues in the local daemon.");
    controller.dispose();
  });
});

async function boot(client: CliDaemonClient): Promise<CliConversationController> {
  const controller = new CliConversationController({
    client,
    workspacePath: workspace.path,
    launchIntent: { kind: "RESUME_EXACT", sessionId: session.id },
  });
  await controller.bootstrap();
  return controller;
}

function makeClient(overrides: Partial<CliDaemonClient> = {}): CliDaemonClient {
  const run = makeRun();
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
    createRun: async () => run,
    listRuns: async () => ({ items: [] }),
    watchRunEvents: async function* (_runId, options) {
      options?.onOpen?.();
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield* [] as AgentEvent[];
    },
    startRun: async () => actionResponse(run, "START"),
    recoverRun: async () => actionResponse(run, "RECOVER"),
    cancelRun: async () => actionResponse(run, "CANCEL"),
    getRun: async () => run,
    listPendingApprovals: async () => ({ items: [] }),
    resolveApproval: async () => actionResponse(run, "RESOLVE_APPROVAL"),
    ...overrides,
  };
}

function makeRun(overrides: Partial<ClientAgentRun> = {}): ClientAgentRun {
  return {
    id: createRunId(),
    sessionId: session.id,
    goal: "cancel this Run",
    status: "PENDING",
    workspace,
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    model: { provider: "fixture", model: "fixture-model" },
    createdAt: 1,
    ...overrides,
  };
}

function actionResponse(
  run: ClientAgentRun,
  action: RunActionResponse["action"],
): RunActionResponse {
  return { runId: run.id, action, disposition: "SETTLED", run };
}

function verifiedFinalResult(text: string) {
  return {
    type: "VERIFIED_COMPLETION",
    text,
    verification: {
      planId: createVerificationPlanId(),
      sourceStepId: createStepId(),
      planHash: "a".repeat(64),
      candidateHash: "b".repeat(64),
      evidenceDigest: "c".repeat(64),
      freshnessHash: "d".repeat(64),
      sealHash: "e".repeat(64),
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
