import {
  ClientAgentRunSchema,
  DaemonInfoSchema,
  createRunId,
  createSessionId,
  createWorkspaceId,
  type SecurityCapabilitiesResponse,
  type WorkspaceSecurityCapabilitiesResponse,
} from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import { WebSessionManager, type WebSessionClient } from "../src/application/session-manager.js";

const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" } as const;

function info() {
  return DaemonInfoSchema.parse({
    apiVersion: "v1",
    protocolVersion: 1,
    daemonVersion: "0.1.0",
    capabilities: {
      runExecution: true,
      runRecovery: true,
      cancellation: true,
      approvals: true,
      sseReplay: true,
      sessionTranscript: true,
    },
    runtimeKinds: ["local"],
    configuredProviders: ["fixture"],
    defaultModel: { provider: "fixture", model: "fixture-model" },
    defaultRunConfiguration: {
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1_000 },
    },
  });
}

function capabilities(): SecurityCapabilitiesResponse {
  return {
    schemaVersion: 1,
    defaultPreset: "WORKSPACE_WRITE",
    presets: [
      {
        id: "VIEW_ONLY",
        version: 1,
        displayName: "仅可查看",
        description: "只读。",
        permissionProfile: "READ_ONLY",
        approvalPolicy: "ON_BOUNDARY",
        filesystemBoundary: "WORKSPACE_READ_ONLY",
        processBoundary: "READ_ONLY",
        requiredEnforcement: "OS_RESTRICTED",
        requiresConfirmation: false,
      },
      {
        id: "WORKSPACE_WRITE",
        version: 1,
        displayName: "工作区内修改",
        description: "可写当前工作区。",
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "ON_BOUNDARY",
        filesystemBoundary: "WORKSPACE_READ_WRITE",
        processBoundary: "WORKSPACE_WRITE",
        requiredEnforcement: "OS_RESTRICTED",
        requiresConfirmation: false,
      },
      {
        id: "FULL_ACCESS",
        version: 1,
        displayName: "完全权限",
        description: "主机用户范围。",
        permissionProfile: "FULL_ACCESS",
        approvalPolicy: "NEVER_ASK",
        filesystemBoundary: "HOST_USER_SCOPE",
        processBoundary: "UNRESTRICTED",
        requiredEnforcement: "HARD_SAFETY_ONLY",
        requiresConfirmation: true,
      },
    ],
    processSandbox: { status: "AVAILABLE", enforcement: "HARD", provider: "fixture" },
    ttySupported: true,
    workspacePreparationSupported: false,
  };
}

function workspaceCapabilities(): WorkspaceSecurityCapabilitiesResponse {
  return {
    schemaVersion: 1,
    workspaceId: workspace.id,
    presets: [
      { id: "VIEW_ONLY", version: 1, status: "AVAILABLE" },
      { id: "WORKSPACE_WRITE", version: 1, status: "AVAILABLE" },
      { id: "FULL_ACCESS", version: 1, status: "AVAILABLE" },
    ],
    preparation: { supported: false, status: "NOT_REQUIRED" },
  };
}

function baseClient(overrides: Partial<WebSessionClient> = {}): WebSessionClient {
  return {
    listSessions: vi.fn(async () => ({ items: [] })),
    listRuns: vi.fn(async () => ({ items: [] })),
    createSession: vi.fn(async () => ({
      id: createSessionId(),
      defaultWorkspace: workspace,
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
    })),
    createRun: vi.fn(async (_sessionId, input) =>
      ClientAgentRunSchema.parse({
        id: createRunId(),
        sessionId: _sessionId,
        goal: input.goal,
        status: "PENDING",
        workspace,
        model: input.model,
        runtime: input.runtime,
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "ON_BOUNDARY",
        limits: input.limits,
        createdAt: 1,
      }),
    ),
    getRun: vi.fn(),
    startRun: vi.fn(async (runId) => ({
      runId,
      action: "START" as const,
      disposition: "SCHEDULED" as const,
      run: ClientAgentRunSchema.parse({
        id: runId,
        sessionId: createSessionId(),
        goal: "task",
        status: "RUNNING",
        workspace,
        model: { provider: "fixture", model: "fixture-model" },
        runtime: { id: "local", kind: "local" },
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "ON_BOUNDARY",
        limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1_000 },
        createdAt: 1,
      }),
    })),
    watchRunEvents: vi.fn(async function* () {
      yield* [];
    }),
    getSessionTranscript: vi.fn(async () => ({ items: [] })),
    ...overrides,
  } as WebSessionClient;
}

describe("WebSessionManager permission lifecycle", () => {
  it("does not select Full Access or create a Session when capability lookup fails", async () => {
    const createSession = vi.fn();
    const client = baseClient({
      createSession,
      getSecurityCapabilities: vi.fn(async () => {
        throw new Error("probe failed");
      }),
      getWorkspaceSecurityCapabilities: vi.fn(),
    });
    const manager = new WebSessionManager({ client, workspace, info: info() });

    await manager.loadSessions();
    manager.beginDraft();

    expect(manager.getSnapshot().selectedPreset).toBeUndefined();
    expect(await manager.submitPrompt("inspect safely")).toBe(false);
    expect(createSession).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("submits only the selected preset identity and locks it while the Run is active", async () => {
    const createdRun = ClientAgentRunSchema.parse({
      id: createRunId(),
      sessionId: createSessionId(),
      goal: "write safely",
      status: "PENDING",
      workspace,
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "ON_BOUNDARY",
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1_000 },
      createdAt: 1,
    });
    const createRun = vi.fn(async () => createdRun);
    const client = baseClient({
      createRun,
      getSecurityCapabilities: vi.fn(async () => capabilities()),
      getWorkspaceSecurityCapabilities: vi.fn(async () => workspaceCapabilities()),
    });
    const manager = new WebSessionManager({ client, workspace, info: info() });

    await manager.loadSessions();
    manager.beginDraft();
    expect(manager.getSnapshot().selectedPreset).toEqual({
      id: "WORKSPACE_WRITE",
      expectedVersion: 1,
    });
    await expect(manager.submitPrompt("write safely")).resolves.toBe(true);
    expect(createRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
      }),
    );
    expect(createRun.mock.calls[0]?.[1]).not.toHaveProperty("permissionProfile");
    expect(await manager.selectPermissionPreset({ id: "FULL_ACCESS", expectedVersion: 1 })).toBe(
      false,
    );
    manager.dispose();
  });
});
