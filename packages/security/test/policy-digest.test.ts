import { describe, expect, it } from "vitest";
import { computePolicyDigest, expandPermissionPreset, verifyPolicyDigest } from "../src/index.js";

describe("Security policy digest wrapper", () => {
  it("uses the shared Protocol canonical digest and excludes policyDigest", () => {
    const snapshot = expandPermissionPreset({
      presetId: "WORKSPACE_WRITE",
      expectedVersion: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const reordered = {
      policyDigest: "f".repeat(64),
      createdAt: snapshot.createdAt,
      secretPolicyVersion: snapshot.secretPolicyVersion,
      commandPolicyVersion: snapshot.commandPolicyVersion,
      hardSafetyPolicyVersion: snapshot.hardSafetyPolicyVersion,
      requiredEnforcement: snapshot.requiredEnforcement,
      processBoundary: snapshot.processBoundary,
      filesystemBoundary: snapshot.filesystemBoundary,
      approvalPolicy: snapshot.approvalPolicy,
      permissionProfile: snapshot.permissionProfile,
      preset: snapshot.preset,
      schemaVersion: snapshot.schemaVersion,
    };
    expect(computePolicyDigest(reordered)).toBe(snapshot.policyDigest);
    expect(() => verifyPolicyDigest({ ...snapshot, policyDigest: "0".repeat(64) })).toThrow(
      /digest/i,
    );
    expect(computePolicyDigest({ ...snapshot, createdAt: "2026-10-01T00:00:00+08:00" })).not.toBe(
      snapshot.policyDigest,
    );
  });
});
