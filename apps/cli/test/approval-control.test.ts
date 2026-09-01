import {
  ApprovalRequestSchema,
  createApprovalRequestId,
  createRunId,
  createSessionId,
  createToolInvocationId,
  createWorkspaceId,
  type AgentEvent,
  type ApprovalRequest,
  type ClientAgentRun,
  type ClientAgentSession,
  type RunActionResponse,
  type RunListResponse,
} from "@caelush/protocol";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import {
  CliConversationController,
  type CliDaemonClient,
} from "../src/application/cli-controller.js";
import { createApprovalView } from "../src/application/cli-control.js";
import { ApprovalDialog } from "../src/components/ApprovalDialog.js";

const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
const session: ClientAgentSession = {
  id: createSessionId(),
  createdAt: 1,
  updatedAt: 1,
  metadata: {},
  defaultWorkspace: workspace,
};

describe("CLI Approval control", () => {
  it("submits exactly one request on double Enter and keeps the exact Approval ID", async () => {
    const run = makeRun({ status: "WAITING_APPROVAL" });
    const approval = makeApproval(run.id);
    const resolveApproval = vi.fn(async () => actionResponse(run, "RESOLVE_APPROVAL"));
    const client = makeClient({
      listRuns: async (): Promise<RunListResponse> => ({ items: [run] }),
      listPendingApprovals: async () => ({ items: [approval] }),
      resolveApproval,
    });
    const controller = await boot(client);

    const first = controller.resolveApproval(approval.id, { action: "REJECT" });
    const duplicate = controller.resolveApproval(approval.id, { action: "REJECT" });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([true, false]);
    expect(resolveApproval).toHaveBeenCalledTimes(1);
    expect(resolveApproval).toHaveBeenCalledWith(run.id, approval.id, { action: "REJECT" });
    controller.dispose();
  });

  it("does not resolve an Approval that another client already settled", async () => {
    const run = makeRun({ status: "WAITING_APPROVAL" });
    const approval = makeApproval(run.id);
    const resolveApproval = vi.fn(async () => actionResponse(run, "RESOLVE_APPROVAL"));
    let pending = true;
    const client = makeClient({
      listRuns: async (): Promise<RunListResponse> => ({ items: [run] }),
      listPendingApprovals: async () => ({ items: pending ? [approval] : [] }),
      resolveApproval,
    });
    const controller = await boot(client);
    pending = false;

    await expect(controller.resolveApproval(approval.id, { action: "REJECT" })).resolves.toBe(
      false,
    );
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(controller.getState().controlMode).not.toBe("APPROVAL");
    controller.dispose();
  });

  it("renders only safe Approval view fields", () => {
    const view = createApprovalView(
      makeApproval(createRunId(), {
        action: {
          toolName: "read_file",
          summary: "Read a source file",
          requiredCapabilities: ["filesystem.read"],
          command: "SECRET_COMMAND",
          patch: "SECRET_PATCH",
          stdin: "SECRET_STDIN",
        },
      }),
    );
    const rendered = render(
      React.createElement(ApprovalDialog, {
        approval: view,
        selectedIndex: view.selectedIndex,
        submitting: false,
        onMove: () => undefined,
        onSubmit: () => undefined,
        onClose: () => undefined,
      }),
    );

    expect(rendered.lastFrame()).toContain("Permission required");
    expect(rendered.lastFrame()).toContain("Read a source file");
    expect(rendered.lastFrame()).not.toContain("SECRET");
    expect(rendered.lastFrame()).not.toContain("SECRET_COMMAND");
    rendered.unmount();
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
    goal: "approve this Run",
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

function makeApproval(
  runId: ClientAgentRun["id"],
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return ApprovalRequestSchema.parse({
    id: createApprovalRequestId(),
    runId,
    toolInvocationId: createToolInvocationId(),
    riskLevel: "HIGH",
    title: "Permission required",
    reason: "The action requires approval.",
    action: { toolName: "read_file", summary: "Read a source file" },
    status: "PENDING",
    scope: "ONCE",
    createdAt: 1,
    ...overrides,
  });
}

function actionResponse(
  run: ClientAgentRun,
  action: RunActionResponse["action"],
): RunActionResponse {
  return { runId: run.id, action, disposition: "SCHEDULED", run };
}
