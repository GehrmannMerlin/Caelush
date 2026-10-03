import {
  ClientAgentRunSchema,
  DaemonInfoSchema,
  createRunId,
  createSessionId,
  createWorkspaceId,
  type SecurityPreparationResponse,
  type SecurityCapabilitiesResponse,
  type WorkspaceSecurityCapabilitiesResponse,
} from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import { WebSessionManager, type WebSessionClient } from "../src/application/session-manager.js";
import { PermissionPresetSelectionStore } from "../src/application/session-persistence.js";

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

type PresetStatus = "AVAILABLE" | "PREPARATION_REQUIRED" | "UNAVAILABLE";

function workspaceCapabilities(
  statuses: Partial<
    Readonly<Record<"VIEW_ONLY" | "WORKSPACE_WRITE" | "FULL_ACCESS", PresetStatus>>
  > = {},
  preparation: WorkspaceSecurityCapabilitiesResponse["preparation"] = {
    supported: false,
    status: "NOT_REQUIRED",
  },
): WorkspaceSecurityCapabilitiesResponse {
  return {
    schemaVersion: 1,
    workspaceId: workspace.id,
    presets: [
      { id: "VIEW_ONLY", version: 1, status: statuses.VIEW_ONLY ?? "AVAILABLE" },
      {
        id: "WORKSPACE_WRITE",
        version: 1,
        status: statuses.WORKSPACE_WRITE ?? "AVAILABLE",
      },
      { id: "FULL_ACCESS", version: 1, status: statuses.FULL_ACCESS ?? "AVAILABLE" },
    ],
    preparation,
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
    expect(manager.getSnapshot().error?.code).toBe("PERMISSION_CAPABILITIES_FAILED");
    expect(createSession).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("falls back to View Only when the configured Workspace Write preset is unavailable", async () => {
    const client = baseClient({
      getSecurityCapabilities: vi.fn(async () => capabilities()),
      getWorkspaceSecurityCapabilities: vi.fn(async () =>
        workspaceCapabilities({ WORKSPACE_WRITE: "UNAVAILABLE" }),
      ),
    });
    const manager = new WebSessionManager({ client, workspace, info: info() });

    await manager.loadSessions();
    manager.beginDraft();

    expect(manager.getSnapshot().selectedPreset).toEqual({
      id: "VIEW_ONLY",
      expectedVersion: 1,
    });
    expect(manager.getSnapshot().requestedPreset).toEqual({
      id: "WORKSPACE_WRITE",
      expectedVersion: 1,
    });
    manager.dispose();
  });

  it("does not automatically select Full Access when it is the only available preset", async () => {
    const client = baseClient({
      getSecurityCapabilities: vi.fn(async () => capabilities()),
      getWorkspaceSecurityCapabilities: vi.fn(async () =>
        workspaceCapabilities({ VIEW_ONLY: "UNAVAILABLE", WORKSPACE_WRITE: "UNAVAILABLE" }),
      ),
    });
    const manager = new WebSessionManager({ client, workspace, info: info() });

    await manager.loadSessions();
    manager.beginDraft();

    expect(manager.getSnapshot().selectedPreset).toBeUndefined();
    expect(manager.getSnapshot().permissionCapabilities).toBeDefined();
    manager.dispose();
  });

  it("reports preset unavailability and creates nothing after a successful empty capability load", async () => {
    const createSession = vi.fn();
    const createRun = vi.fn();
    const client = baseClient({
      createSession,
      createRun,
      getSecurityCapabilities: vi.fn(async () => capabilities()),
      getWorkspaceSecurityCapabilities: vi.fn(async () =>
        workspaceCapabilities({ VIEW_ONLY: "UNAVAILABLE", WORKSPACE_WRITE: "UNAVAILABLE" }),
      ),
    });
    const manager = new WebSessionManager({ client, workspace, info: info() });

    await manager.loadSessions();
    manager.beginDraft();

    await expect(manager.submitPrompt("inspect with an explicit permission")).resolves.toBe(false);
    expect(manager.getSnapshot().error?.code).toBe("PERMISSION_PRESET_UNAVAILABLE");
    expect(manager.getSnapshot().error?.message).toBe("所选权限当前不可用，已阻止创建任务。");
    expect(createSession).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
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

describe("WebSessionManager workspace preparation", () => {
  const REQUIRED_PREPARATION = {
    supported: true,
    status: "REQUIRED",
    reasonCode: "WORKSPACE_PREPARATION_REQUIRED",
  } as const;

  it("selects the prepared preset only after reloading workspace capabilities", async () => {
    const getWorkspaceSecurityCapabilities = vi
      .fn()
      .mockResolvedValueOnce(
        workspaceCapabilities({ WORKSPACE_WRITE: "PREPARATION_REQUIRED" }, REQUIRED_PREPARATION),
      )
      .mockResolvedValue(workspaceCapabilities());
    const prepareWorkspaceSecurity = vi.fn(async () => ({
      schemaVersion: 1 as const,
      workspaceId: workspace.id,
      preset: { id: "WORKSPACE_WRITE" as const, expectedVersion: 1 },
      status: "READY" as const,
    }));
    const client = baseClient({
      getSecurityCapabilities: vi.fn(async () => capabilities()),
      getWorkspaceSecurityCapabilities,
      prepareWorkspaceSecurity,
    });
    const manager = new WebSessionManager({ client, workspace, info: info() });

    await manager.loadSessions();
    manager.beginDraft();
    // An unprepared default cannot become the selected permission until the user explicitly
    // chooses it and workspace capabilities confirm preparation.
    expect(manager.getSnapshot().selectedPreset).toEqual({ id: "VIEW_ONLY", expectedVersion: 1 });
    expect(manager.getSnapshot().requestedPreset).toEqual({ id: "VIEW_ONLY", expectedVersion: 1 });

    await expect(
      manager.preparePermissionPreset({ id: "WORKSPACE_WRITE", expectedVersion: 1 }),
    ).resolves.toBe(true);

    expect(prepareWorkspaceSecurity).toHaveBeenCalledWith(workspace.id, {
      id: "WORKSPACE_WRITE",
      expectedVersion: 1,
    });
    // The reload is the whole contract: selection must never come from the pre-preparation read.
    expect(getWorkspaceSecurityCapabilities).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot().selectedPreset).toEqual({
      id: "WORKSPACE_WRITE",
      expectedVersion: 1,
    });
    manager.dispose();
  });

  it("does not persist or select a preset whose preparation the host refused", async () => {
    const store = new PermissionPresetSelectionStore(new Map());
    const prepareWorkspaceSecurity = vi.fn(async () => ({
      schemaVersion: 1 as const,
      workspaceId: workspace.id,
      preset: { id: "WORKSPACE_WRITE" as const, expectedVersion: 1 },
      status: "FAILED" as const,
      reasonCode: "PRESET_VERSION_MISMATCH",
    }));
    const client = baseClient({
      getSecurityCapabilities: vi.fn(async () => capabilities()),
      getWorkspaceSecurityCapabilities: vi.fn(async () =>
        workspaceCapabilities({ WORKSPACE_WRITE: "PREPARATION_REQUIRED" }, REQUIRED_PREPARATION),
      ),
      prepareWorkspaceSecurity,
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: info(),
      permissionPresetStore: store,
    });

    await manager.loadSessions();
    manager.beginDraft();

    await expect(
      manager.preparePermissionPreset({ id: "WORKSPACE_WRITE", expectedVersion: 1 }),
    ).resolves.toBe(false);
    expect(manager.getSnapshot().error?.code).toBe("PERMISSION_PREPARATION_FAILED");
    expect(manager.getSnapshot().selectedPreset).toEqual({ id: "VIEW_ONLY", expectedVersion: 1 });
    // A refused preparation must not leave a persisted preference for a preset this workspace
    // cannot use; that would silently discard the user's actual choice on the next load.
    expect(store.read(workspace.id)).toBeUndefined();
    manager.dispose();
  });

  it("requires capability readback before persisting a prepared permission", async () => {
    const store = new PermissionPresetSelectionStore(new Map());
    const getWorkspaceSecurityCapabilities = vi
      .fn()
      .mockResolvedValue(
        workspaceCapabilities({ WORKSPACE_WRITE: "PREPARATION_REQUIRED" }, REQUIRED_PREPARATION),
      );
    const prepareWorkspaceSecurity = vi.fn(async () => ({
      schemaVersion: 1 as const,
      workspaceId: workspace.id,
      preset: { id: "WORKSPACE_WRITE" as const, expectedVersion: 1 },
      status: "READY" as const,
    }));
    const client = baseClient({
      getSecurityCapabilities: vi.fn(async () => capabilities()),
      getWorkspaceSecurityCapabilities,
      prepareWorkspaceSecurity,
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: info(),
      permissionPresetStore: store,
    });

    await manager.loadSessions();
    manager.beginDraft();
    await expect(
      manager.preparePermissionPreset({ id: "WORKSPACE_WRITE", expectedVersion: 1 }),
    ).resolves.toBe(false);

    expect(getWorkspaceSecurityCapabilities).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot().selectedPreset).toEqual({ id: "VIEW_ONLY", expectedVersion: 1 });
    expect(manager.getSnapshot().error?.reasonCode).toBe("WORKSPACE_PREPARATION_NOT_CONFIRMED");
    expect(store.read(workspace.id)).toBeUndefined();
    manager.dispose();
  });

  it("rejects a preparation acknowledgement for a different workspace permission", async () => {
    const store = new PermissionPresetSelectionStore(new Map());
    const prepareWorkspaceSecurity = vi.fn(async () => ({
      schemaVersion: 1 as const,
      workspaceId: workspace.id,
      preset: { id: "VIEW_ONLY" as const, expectedVersion: 1 },
      status: "READY" as const,
    }));
    const client = baseClient({
      getSecurityCapabilities: vi.fn(async () => capabilities()),
      getWorkspaceSecurityCapabilities: vi.fn(async () =>
        workspaceCapabilities({ WORKSPACE_WRITE: "PREPARATION_REQUIRED" }, REQUIRED_PREPARATION),
      ),
      prepareWorkspaceSecurity,
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: info(),
      permissionPresetStore: store,
    });

    await manager.loadSessions();
    manager.beginDraft();
    await expect(
      manager.preparePermissionPreset({ id: "WORKSPACE_WRITE", expectedVersion: 1 }),
    ).resolves.toBe(false);

    expect(manager.getSnapshot().selectedPreset).toEqual({ id: "VIEW_ONLY", expectedVersion: 1 });
    expect(manager.getSnapshot().error?.reasonCode).toBe("WORKSPACE_PREPARATION_RESPONSE_MISMATCH");
    expect(store.read(workspace.id)).toBeUndefined();
    manager.dispose();
  });

  it("restores the active preset selection after preparation fails", async () => {
    const prepareWorkspaceSecurity = vi.fn(async () => ({
      schemaVersion: 1 as const,
      workspaceId: workspace.id,
      preset: { id: "WORKSPACE_WRITE" as const, expectedVersion: 1 },
      status: "FAILED" as const,
      reasonCode: "WINDOWS_ACL_APPLY_FAILED",
    }));
    const client = baseClient({
      getSecurityCapabilities: vi.fn(async () => capabilities()),
      getWorkspaceSecurityCapabilities: vi.fn(async () =>
        workspaceCapabilities({ WORKSPACE_WRITE: "PREPARATION_REQUIRED" }, REQUIRED_PREPARATION),
      ),
      prepareWorkspaceSecurity,
    });
    const manager = new WebSessionManager({ client, workspace, info: info() });

    await manager.loadSessions();
    manager.beginDraft();
    await manager.preparePermissionPreset({ id: "WORKSPACE_WRITE", expectedVersion: 1 });

    const snapshot = manager.getSnapshot();
    expect(snapshot.requestedPreset).toEqual({ id: "VIEW_ONLY", expectedVersion: 1 });
    expect(snapshot.selectedPreset).toEqual({ id: "VIEW_ONLY", expectedVersion: 1 });
    manager.dispose();
  });

  it("exposes the daemon's bounded reason for a failed workspace preparation", async () => {
    const prepareWorkspaceSecurity = vi.fn(async () => ({
      schemaVersion: 1 as const,
      workspaceId: workspace.id,
      preset: { id: "WORKSPACE_WRITE" as const, expectedVersion: 1 },
      status: "FAILED" as const,
      reasonCode: "WINDOWS_ACL_APPLY_FAILED",
    }));
    const client = baseClient({
      getSecurityCapabilities: vi.fn(async () => capabilities()),
      getWorkspaceSecurityCapabilities: vi.fn(async () =>
        workspaceCapabilities({ WORKSPACE_WRITE: "PREPARATION_REQUIRED" }, REQUIRED_PREPARATION),
      ),
      prepareWorkspaceSecurity,
    });
    const manager = new WebSessionManager({ client, workspace, info: info() });

    await manager.loadSessions();
    manager.beginDraft();
    await manager.preparePermissionPreset({ id: "WORKSPACE_WRITE", expectedVersion: 1 });

    const error = manager.getSnapshot().error;
    expect(error).toMatchObject({
      code: "PERMISSION_PREPARATION_FAILED",
      reasonCode: "WINDOWS_ACL_APPLY_FAILED",
      message: "工作区准备失败：Windows 未能应用工作区访问控制设置。",
    });
    manager.dispose();
  });

  it("publishes the requested and preparing presets while host preparation is pending", async () => {
    let resolvePreparation: ((response: SecurityPreparationResponse) => void) | undefined;
    const createSession = vi.fn();
    const prepareWorkspaceSecurity = vi.fn(
      () =>
        new Promise<SecurityPreparationResponse>((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    const client = baseClient({
      createSession,
      getSecurityCapabilities: vi.fn(async () => capabilities()),
      getWorkspaceSecurityCapabilities: vi.fn(async () =>
        workspaceCapabilities({ WORKSPACE_WRITE: "PREPARATION_REQUIRED" }, REQUIRED_PREPARATION),
      ),
      prepareWorkspaceSecurity,
    });
    const manager = new WebSessionManager({ client, workspace, info: info() });

    await manager.loadSessions();
    manager.beginDraft();
    const preparation = manager.preparePermissionPreset({
      id: "WORKSPACE_WRITE",
      expectedVersion: 1,
    });

    expect(manager.getSnapshot()).toMatchObject({
      requestedPreset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
      preparingPreset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
      selectedPreset: { id: "VIEW_ONLY", expectedVersion: 1 },
    });
    await expect(manager.submitPrompt("run while preparation is pending")).resolves.toBe(false);
    expect(createSession).not.toHaveBeenCalled();

    resolvePreparation?.({
      schemaVersion: 1,
      workspaceId: workspace.id,
      preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
      status: "FAILED",
      reasonCode: "WINDOWS_ACL_APPLY_FAILED",
    });
    await expect(preparation).resolves.toBe(false);
    expect(manager.getSnapshot().preparingPreset).toBeUndefined();
    manager.dispose();
  });
});
