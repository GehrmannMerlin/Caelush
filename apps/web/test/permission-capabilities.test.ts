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
        displayName: "仅可查看",
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
        displayName: "工作区内修改",
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
        displayName: "完全权限",
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

function workspaceCapabilities(
  fullStatus: "AVAILABLE" | "UNAVAILABLE" = "AVAILABLE",
): WorkspaceSecurityCapabilitiesResponse {
  return {
    schemaVersion: 1,
    workspaceId,
    presets: [
      { id: "VIEW_ONLY", version: 1, status: "AVAILABLE" },
      { id: "WORKSPACE_WRITE", version: 1, status: "AVAILABLE" },
      { id: "FULL_ACCESS", version: 1, status: fullStatus },
    ],
    preparation: { supported: false, status: "NOT_REQUIRED" },
  };
}

describe("Web permission preset projections", () => {
  it("keeps the three server labels and exposes partial enforcement accurately", () => {
    const views = projectPermissionPresetViewModels(capabilities(), workspaceCapabilities());

    expect(views.map((item) => item.displayName)).toEqual(["仅可查看", "工作区内修改", "完全权限"]);
    expect(views.slice(0, 2).every((item) => item.sandboxEnforcement === "PARTIAL")).toBe(true);
  });

  it("defaults to Workspace Write and never promotes an unavailable preset to Full Access", () => {
    const views = projectPermissionPresetViewModels(
      capabilities(),
      workspaceCapabilities("UNAVAILABLE"),
    );

    expect(choosePermissionPreset(views)).toEqual({ id: "WORKSPACE_WRITE", expectedVersion: 1 });
    expect(choosePermissionPreset(views, "FULL_ACCESS")).toBeUndefined();
  });
});
