import { describe, expect, it } from "vitest";
import {
  PermissionPresetDescriptorSchema,
  RunSecurityPolicySnapshotV1Schema,
  SecurityCapabilitiesResponseSchema,
  WorkspaceSecurityCapabilitiesResponseSchema,
  computeSecurityPolicyDigest,
  verifySecurityPolicyDigest,
  createWorkspaceId,
} from "../src/index.js";

const snapshotWithoutDigest = {
  schemaVersion: 1 as const,
  preset: { id: "VIEW_ONLY" as const, version: 1 },
  permissionProfile: "READ_ONLY" as const,
  approvalPolicy: "ON_BOUNDARY" as const,
  filesystemBoundary: "WORKSPACE_READ_ONLY" as const,
  processBoundary: "READ_ONLY" as const,
  requiredEnforcement: "OS_RESTRICTED" as const,
  hardSafetyPolicyVersion: "hard-safety@1",
  commandPolicyVersion: "command-policy@1",
  secretPolicyVersion: "secret-policy@1",
  createdAt: "2026-10-01T00:00:00.000Z",
};

function descriptor(
  id: "VIEW_ONLY" | "WORKSPACE_WRITE" | "FULL_ACCESS",
  permissionProfile: "READ_ONLY" | "PROJECT_ACCESS" | "FULL_ACCESS",
  approvalPolicy: "ON_BOUNDARY" | "NEVER_ASK",
  filesystemBoundary: "WORKSPACE_READ_ONLY" | "WORKSPACE_READ_WRITE" | "HOST_USER_SCOPE",
  processBoundary: "READ_ONLY" | "WORKSPACE_WRITE" | "UNRESTRICTED",
  requiredEnforcement: "OS_RESTRICTED" | "HARD_SAFETY_ONLY",
) {
  return {
    id,
    version: 1,
    displayName: id,
    description: `${id} permissions`,
    permissionProfile,
    approvalPolicy,
    filesystemBoundary,
    processBoundary,
    requiredEnforcement,
    requiresConfirmation: id === "FULL_ACCESS",
  } as const;
}

describe("versioned security policy contracts", () => {
  it("represents the three exact product preset mappings", () => {
    expect(
      PermissionPresetDescriptorSchema.parse(
        descriptor(
          "VIEW_ONLY",
          "READ_ONLY",
          "ON_BOUNDARY",
          "WORKSPACE_READ_ONLY",
          "READ_ONLY",
          "OS_RESTRICTED",
        ),
      ),
    ).toMatchObject({
      id: "VIEW_ONLY",
      permissionProfile: "READ_ONLY",
      approvalPolicy: "ON_BOUNDARY",
      filesystemBoundary: "WORKSPACE_READ_ONLY",
      processBoundary: "READ_ONLY",
      requiredEnforcement: "OS_RESTRICTED",
      requiresConfirmation: false,
    });
    expect(
      PermissionPresetDescriptorSchema.parse(
        descriptor(
          "WORKSPACE_WRITE",
          "PROJECT_ACCESS",
          "ON_BOUNDARY",
          "WORKSPACE_READ_WRITE",
          "WORKSPACE_WRITE",
          "OS_RESTRICTED",
        ),
      ),
    ).toMatchObject({
      id: "WORKSPACE_WRITE",
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "ON_BOUNDARY",
      filesystemBoundary: "WORKSPACE_READ_WRITE",
      processBoundary: "WORKSPACE_WRITE",
      requiredEnforcement: "OS_RESTRICTED",
      requiresConfirmation: false,
    });
    expect(
      PermissionPresetDescriptorSchema.parse(
        descriptor(
          "FULL_ACCESS",
          "FULL_ACCESS",
          "NEVER_ASK",
          "HOST_USER_SCOPE",
          "UNRESTRICTED",
          "HARD_SAFETY_ONLY",
        ),
      ),
    ).toMatchObject({
      id: "FULL_ACCESS",
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "NEVER_ASK",
      filesystemBoundary: "HOST_USER_SCOPE",
      processBoundary: "UNRESTRICTED",
      requiredEnforcement: "HARD_SAFETY_ONLY",
      requiresConfirmation: true,
    });
  });

  it("accepts ON_BOUNDARY and rejects unknown snapshot fields", () => {
    const digest = computeSecurityPolicyDigest(snapshotWithoutDigest);
    const snapshot = RunSecurityPolicySnapshotV1Schema.parse({
      ...snapshotWithoutDigest,
      policyDigest: digest,
    });

    expect(snapshot.approvalPolicy).toBe("ON_BOUNDARY");
    expect(
      RunSecurityPolicySnapshotV1Schema.safeParse({ ...snapshot, hostPath: "C:\\secret" }).success,
    ).toBe(false);
    expect(verifySecurityPolicyDigest(snapshot)).toBe(true);
  });

  it("excludes policyDigest from the canonical digest and is stable across key order", () => {
    const first = computeSecurityPolicyDigest(snapshotWithoutDigest);
    const second = computeSecurityPolicyDigest({
      createdAt: snapshotWithoutDigest.createdAt,
      secretPolicyVersion: snapshotWithoutDigest.secretPolicyVersion,
      commandPolicyVersion: snapshotWithoutDigest.commandPolicyVersion,
      hardSafetyPolicyVersion: snapshotWithoutDigest.hardSafetyPolicyVersion,
      requiredEnforcement: snapshotWithoutDigest.requiredEnforcement,
      processBoundary: snapshotWithoutDigest.processBoundary,
      filesystemBoundary: snapshotWithoutDigest.filesystemBoundary,
      approvalPolicy: snapshotWithoutDigest.approvalPolicy,
      permissionProfile: snapshotWithoutDigest.permissionProfile,
      preset: snapshotWithoutDigest.preset,
      schemaVersion: snapshotWithoutDigest.schemaVersion,
      policyDigest: "ignored",
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(
      verifySecurityPolicyDigest({ ...snapshotWithoutDigest, policyDigest: "0".repeat(64) }),
    ).toBe(false);
  });

  it("keeps capability responses strict and free of host paths", () => {
    const descriptors = [
      descriptor(
        "VIEW_ONLY",
        "READ_ONLY",
        "ON_BOUNDARY",
        "WORKSPACE_READ_ONLY",
        "READ_ONLY",
        "OS_RESTRICTED",
      ),
      descriptor(
        "WORKSPACE_WRITE",
        "PROJECT_ACCESS",
        "ON_BOUNDARY",
        "WORKSPACE_READ_WRITE",
        "WORKSPACE_WRITE",
        "OS_RESTRICTED",
      ),
      descriptor(
        "FULL_ACCESS",
        "FULL_ACCESS",
        "NEVER_ASK",
        "HOST_USER_SCOPE",
        "UNRESTRICTED",
        "HARD_SAFETY_ONLY",
      ),
    ];
    expect(
      SecurityCapabilitiesResponseSchema.parse({
        schemaVersion: 1,
        presets: descriptors,
        defaultPreset: "WORKSPACE_WRITE",
        processSandbox: { status: "AVAILABLE", enforcement: "HARD", provider: "test" },
        ttySupported: true,
        workspacePreparationSupported: true,
      }),
    ).toBeTruthy();

    expect(
      WorkspaceSecurityCapabilitiesResponseSchema.parse({
        schemaVersion: 1,
        workspaceId: createWorkspaceId(),
        presets: [
          { id: "VIEW_ONLY", version: 1, status: "AVAILABLE" },
          { id: "WORKSPACE_WRITE", version: 1, status: "PREPARATION_REQUIRED" },
          { id: "FULL_ACCESS", version: 1, status: "UNAVAILABLE", reasonCode: "HOST_POLICY" },
        ],
        preparation: { supported: true, status: "REQUIRED" },
      }),
    ).toBeTruthy();
    expect(
      WorkspaceSecurityCapabilitiesResponseSchema.safeParse({
        schemaVersion: 1,
        workspaceId: createWorkspaceId(),
        hostPath: "C:\\Users\\private",
      }).success,
    ).toBe(false);
  });
});
