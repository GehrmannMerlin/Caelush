import {
  createSessionId,
  createWorkspaceId,
  type DaemonInfo,
  type SecurityCapabilitiesResponse,
  type WorkspaceSecurityCapabilitiesResponse,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/bootstrap/cli-args.js";
import {
  CliConversationController,
  type CliDaemonClient,
} from "../src/application/cli-controller.js";

describe("CLI permission preset selection", () => {
  it.each([
    ["view-only", "VIEW_ONLY"],
    ["workspace-write", "WORKSPACE_WRITE"],
    ["full-access", "FULL_ACCESS"],
  ] as const)("parses --permission %s as %s", (value, id) => {
    expect(parseCliArgs(["--permission", value])).toEqual({
      kind: "NEW",
      permissionPresetId: id,
    });
  });

  it("fails closed when a non-interactive session has no approval channel", async () => {
    const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
    const info: DaemonInfo = {
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
    };
    const capabilities = {
      schemaVersion: 1,
      defaultPreset: "WORKSPACE_WRITE",
      presets: [
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
      ],
      processSandbox: { status: "AVAILABLE", enforcement: "HARD", provider: "fixture" },
      ttySupported: false,
      workspacePreparationSupported: false,
    } satisfies SecurityCapabilitiesResponse;
    const workspaceCapabilities = {
      schemaVersion: 1,
      workspaceId: workspace.id,
      presets: [{ id: "WORKSPACE_WRITE", version: 1, status: "AVAILABLE" }],
      preparation: { supported: false, status: "NOT_REQUIRED" },
    } satisfies WorkspaceSecurityCapabilitiesResponse;
    const client = {
      getHealth: async () => ({
        service: "caelush-daemon",
        status: "ready",
        apiVersion: "v1",
        protocolVersion: 1,
      }),
      getInfo: async () => info,
      getSecurityCapabilities: async () => capabilities,
      getWorkspaceSecurityCapabilities: async () => workspaceCapabilities,
      createSession: async () => ({
        id: createSessionId(),
        defaultWorkspace: workspace,
        createdAt: 1,
        updatedAt: 1,
        metadata: {},
      }),
      listRuns: async () => ({ items: [] }),
      getSessionTranscript: async () => ({ items: [] }),
    } as unknown as CliDaemonClient;
    const controller = new CliConversationController({
      client,
      workspacePath: workspace.path,
      approvalChannelAvailable: false,
    });

    await controller.bootstrap();

    expect(controller.getState().bootstrap).toBe("BOOTSTRAP_ERROR");
    expect(controller.getState().fatalError).toContain("no approval channel");
    controller.dispose();
  });
});
