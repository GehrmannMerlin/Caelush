import {
  RunSecurityPolicySnapshotV1Schema,
  computeSecurityPolicyDigest,
  createTimestampMs,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createRunSecurityContext } from "../src/run-security-context.js";

function snapshot(preset: "VIEW_ONLY" | "WORKSPACE_WRITE" | "FULL_ACCESS") {
  const values = {
    VIEW_ONLY: {
      permissionProfile: "READ_ONLY" as const,
      approvalPolicy: "ON_BOUNDARY" as const,
      filesystemBoundary: "WORKSPACE_READ_ONLY" as const,
      processBoundary: "READ_ONLY" as const,
      requiredEnforcement: "OS_RESTRICTED" as const,
    },
    WORKSPACE_WRITE: {
      permissionProfile: "PROJECT_ACCESS" as const,
      approvalPolicy: "ON_BOUNDARY" as const,
      filesystemBoundary: "WORKSPACE_READ_WRITE" as const,
      processBoundary: "WORKSPACE_WRITE" as const,
      requiredEnforcement: "OS_RESTRICTED" as const,
    },
    FULL_ACCESS: {
      permissionProfile: "FULL_ACCESS" as const,
      approvalPolicy: "NEVER_ASK" as const,
      filesystemBoundary: "HOST_USER_SCOPE" as const,
      processBoundary: "UNRESTRICTED" as const,
      requiredEnforcement: "HARD_SAFETY_ONLY" as const,
    },
  }[preset];
  const withoutDigest = {
    schemaVersion: 1 as const,
    preset: { id: preset, version: 1 },
    ...values,
    hardSafetyPolicyVersion: "hard-safety@1",
    commandPolicyVersion: "command-policy@1",
    secretPolicyVersion: "secret-policy@1",
    createdAt: new Date(Number(createTimestampMs(1_700_000_000_000))).toISOString(),
  };
  return RunSecurityPolicySnapshotV1Schema.parse({
    ...withoutDigest,
    policyDigest: computeSecurityPolicyDigest(withoutDigest),
  });
}

describe("Run security context", () => {
  it("projects a frozen snapshot without rebuilding it from defaults", () => {
    const policy = snapshot("WORKSPACE_WRITE");
    const context = createRunSecurityContext(policy);

    expect(context).toMatchObject({
      presetId: "WORKSPACE_WRITE",
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "ON_BOUNDARY",
      filesystemBoundary: "WORKSPACE_READ_WRITE",
      processBoundary: "WORKSPACE_WRITE",
      policyDigest: policy.policyDigest,
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => createRunSecurityContext({ ...policy, policyDigest: "0".repeat(64) })).toThrow(
      /digest/i,
    );
  });

  it("fails closed for a missing or legacy-custom policy", () => {
    expect(() => createRunSecurityContext(undefined)).toThrow(/missing/i);
    const policy = snapshot("VIEW_ONLY");
    const legacyWithoutDigest = { ...policy, preset: { id: "LEGACY_CUSTOM" as const, version: 1 } };
    expect(() =>
      createRunSecurityContext({
        ...legacyWithoutDigest,
        policyDigest: computeSecurityPolicyDigest(legacyWithoutDigest),
      }),
    ).toThrow(/legacy/i);
  });
});
