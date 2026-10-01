import { describe, expect, it } from "vitest";
import {
  createWorkspaceId,
  type SecurityCapabilitiesResponse,
  type WorkspaceSecurityCapabilitiesResponse,
} from "@caelush/protocol";
import {
  choosePermissionPreset,
  projectPermissionPresetViewModels,
} from "../src/application/permission-presets.js";

const workspaceId = createWorkspaceId();

function capabilities(): SecurityCapabilitiesResponse {
  return {
    schemaVersion: 1,
    defaultPreset: "WORKSPACE_WRITE",
    presets: [
      {
        id: "VIEW_ONLY",
        version: 1,
        displayName: "View only",
        description: "只读访问。",
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
        displayName: "Workspace write",
        description: "可以修改当前工作区。",
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
        displayName: "Full access",
        description: "在硬安全规则内使用主机用户权限。",
        permissionProfile: "FULL_ACCESS",
        approvalPolicy: "NEVER_ASK",
        filesystemBoundary: "HOST_USER_SCOPE",
        processBoundary: "UNRESTRICTED",
        requiredEnforcement: "HARD_SAFETY_ONLY",
        requiresConfirmation: true,
      },
    ],
    processSandbox: { status: "AVAILABLE", enforcement: "PARTIAL", provider: "fixture" },
    ttySupported: true,
    workspacePreparationSupported: false,
  };
}

type PresetStatus = "AVAILABLE" | "PREPARATION_REQUIRED" | "UNAVAILABLE";

function workspaceCapabilities(
  statuses: Partial<
    Readonly<Record<"VIEW_ONLY" | "WORKSPACE_WRITE" | "FULL_ACCESS", PresetStatus>>
  > = {},
): WorkspaceSecurityCapabilitiesResponse {
  return {
    schemaVersion: 1,
    workspaceId,
    presets: [
      { id: "VIEW_ONLY", version: 1, status: statuses.VIEW_ONLY ?? "AVAILABLE" },
      {
        id: "WORKSPACE_WRITE",
        version: 1,
        status: statuses.WORKSPACE_WRITE ?? "AVAILABLE",
      },
      { id: "FULL_ACCESS", version: 1, status: statuses.FULL_ACCESS ?? "AVAILABLE" },
    ],
    preparation: { supported: false, status: "NOT_REQUIRED" },
  };
}

describe("Web permission preset projections", () => {
  it("projects stable Chinese labels instead of server-provided English names", () => {
    const views = projectPermissionPresetViewModels(capabilities(), workspaceCapabilities());

    expect(views.map((item) => item.displayName)).toEqual(["仅可查看", "工作区内修改", "完全权限"]);
    expect(views.slice(0, 2).every((item) => item.sandboxEnforcement === "PARTIAL")).toBe(true);
  });

  it("defaults to Workspace Write and safely falls back from unavailable Full Access", () => {
    const views = projectPermissionPresetViewModels(
      capabilities(),
      workspaceCapabilities({ FULL_ACCESS: "UNAVAILABLE" }),
    );

    expect(choosePermissionPreset(views)).toEqual({ id: "WORKSPACE_WRITE", expectedVersion: 1 });
    expect(choosePermissionPreset(views, "FULL_ACCESS")).toEqual({
      id: "WORKSPACE_WRITE",
      expectedVersion: 1,
    });
  });

  it("falls back to the first available non-confirming preset", () => {
    const views = projectPermissionPresetViewModels(
      capabilities(),
      workspaceCapabilities({ WORKSPACE_WRITE: "UNAVAILABLE" }),
    );

    expect(choosePermissionPreset(views)).toEqual({ id: "VIEW_ONLY", expectedVersion: 1 });
  });

  it("does not automatically select Full Access when it is the only available preset", () => {
    const views = projectPermissionPresetViewModels(
      capabilities(),
      workspaceCapabilities({ VIEW_ONLY: "UNAVAILABLE", WORKSPACE_WRITE: "UNAVAILABLE" }),
    );

    expect(choosePermissionPreset(views)).toBeUndefined();
    expect(choosePermissionPreset(views, "FULL_ACCESS")).toBeUndefined();
  });
});
