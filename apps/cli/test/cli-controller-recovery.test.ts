import {
  ApprovalRequestSchema,
  createApprovalRequestId,
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

const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };

describe("CLI active Run recovery", () => {
  it("starts a recovered PENDING Run only after explicit confirmation", async () => {
    const pending = makeRun({ status: "PENDING" });
    const started = makeRun({ id: pending.id, status: "RUNNING" });
    const startRun = vi.fn(async (): Promise<RunActionResponse> => actionResponse(started, "START"));
    const client = makeClient({
      listRuns: async (): Promise<RunListResponse> => ({ items: [pending] }),
      startRun,
    });
    const controller = new CliConversationController({
      client,
      workspacePath: workspace.path,
      launchIntent: { kind: "RESUME_EXACT", sessionId: clientSession.id },
    });

    await controller.bootstrap();
    expect(startRun).not.toHaveBeenCalled();
    expect(controller.getState().controlMode).toBe("PENDING_RUN_CONFIRMATION");

    await controller.confirmPendingRun(true);
    expect(startRun).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("checks pending approvals before recovering a WAITING_APPROVAL Run", async () => {
    const waiting = makeRun({ status: "WAITING_APPROVAL" });
    const calls: string[] = [];
    const client = makeClient({
      listRuns: async (): Promise<RunListResponse> => ({ items: [waiting] }),
      listPendingApprovals: async () => {
        calls.push("approvals");
        return { items: [makeApproval(waiting.id)] };
      },
      recoverRun: async () => {
        calls.push("recover");
        return actionResponse(waiting, "RECOVER");
      },
    });
    const controller = new CliConversationController({
      client,
      workspacePath: workspace.path,
      launchIntent: { kind: "RESUME_EXACT", sessionId: clientSession.id },
    });

    await controller.bootstrap();

    expect(calls).toEqual(["approvals"]);
    expect(controller.getState().controlMode).toBe("APPROVAL");
    expect(controller.getState().approvalState?.requests[0]?.id).toBeDefined();
    controller.dispose();
  });

  it("attaches an active Run from sequence zero and admits recovery once after open", async () => {
    const running = makeRun({ status: "RUNNING" });
    const watchCalls: Array<{ readonly afterSequence?: number }> = [];
    const recoverRun = vi.fn(async () => actionResponse(running, "RECOVER"));
    const client = makeClient({
      listRuns: async (): Promise<RunListResponse> => ({ items: [running] }),
      recoverRun,
      watchRunEvents: async function* (_runId, options) {
        watchCalls.push({ afterSequence: options?.afterSequence });
        options?.onOpen?.();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield* [] as AgentEvent[];
      },
    });
    const controller = new CliConversationController({
      client,
      workspacePath: workspace.path,
      launchIntent: { kind: "RESUME_EXACT", sessionId: clientSession.id },
    });

    await controller.bootstrap();
    await waitFor(() => recoverRun.mock.calls.length === 1);

    expect(watchCalls).toEqual([{ afterSequence: 0 }]);
    expect(recoverRun).toHaveBeenCalledTimes(1);
    expect(controller.getState().timeline.runId).toBe(running.id);
    expect(controller.getState().timeline.lastDurableSequence).toBe(0);
    controller.dispose();
  });
});

const clientSession: ClientAgentSession = {
  id: createSessionId(),
  createdAt: 1,
  updatedAt: 1,
  metadata: {},
  defaultWorkspace: workspace,
};

function makeClient(overrides: Partial<CliDaemonClient> = {}): CliDaemonClient {
  const defaultRun = makeRun();
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
    createSession: async () => clientSession,
    getSession: async () => clientSession,
    listSessions: async () => ({ items: [clientSession] }),
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

function makeRun(overrides: Partial<ClientAgentRun> = {}): ClientAgentRun {
  return {
    id: createRunId(),
    sessionId: clientSession.id,
    goal: "recover this Run",
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

function makeApproval(runId: ClientAgentRun["id"]) {
  return ApprovalRequestSchema.parse({
    id: createApprovalRequestId(),
    runId,
    toolInvocationId: createToolInvocationId(),
    riskLevel: "HIGH",
    title: "Approval required",
    reason: "The action requires approval.",
    action: { toolName: "read_file", summary: "Read a source file" },
    status: "PENDING",
    scope: "ONCE",
    createdAt: 1,
  });
}

function actionResponse(run: ClientAgentRun, action: RunActionResponse["action"]): RunActionResponse {
  return {
    runId: run.id,
    action,
    disposition: "SCHEDULED",
    run,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(predicate()).toBe(true);
}
