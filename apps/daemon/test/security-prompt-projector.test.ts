import { expandPermissionPreset } from "@caelush/security";
import { RunSecurityPolicySnapshotV1Schema, computeSecurityPolicyDigest } from "@caelush/protocol";
import type { RunSecurityPolicySnapshotV1 } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { RunSecurityPromptProjector } from "../src/services/run-security-prompt-projector.js";

const PROJECTOR = new RunSecurityPromptProjector();
const RUNTIME_FACTS = {
  runtimeKind: "local",
  sandboxProvider: "unrestricted",
  enforcement: "NONE" as const,
  ttySupported: false,
};

function fingerprint(text: string): string {
  const value = text.match(/^policy_semantic_fingerprint=(sha256:[0-9a-f]{64})$/m)?.[1];
  if (value === undefined) throw new Error("Security prompt omitted its semantic fingerprint.");
  return value;
}

function policyAt(createdAt: string) {
  return expandPermissionPreset({
    presetId: "FULL_ACCESS",
    expectedVersion: 1,
    createdAt,
  });
}

function policyWith(
  policy: RunSecurityPolicySnapshotV1,
  changes: Partial<Omit<RunSecurityPolicySnapshotV1, "policyDigest">>,
): RunSecurityPolicySnapshotV1 {
  const unsigned = { ...policy, ...changes };
  return RunSecurityPolicySnapshotV1Schema.parse({
    ...unsigned,
    policyDigest: computeSecurityPolicyDigest(unsigned),
  });
}

describe("RunSecurityPromptProjector", () => {
  it("projects the immutable policy and runtime facts as bounded synthetic context", () => {
    const policy = expandPermissionPreset({
      presetId: "FULL_ACCESS",
      expectedVersion: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const block = new RunSecurityPromptProjector().project(policy, {
      runtimeKind: "local",
      sandboxProvider: "unrestricted",
      enforcement: "NONE",
      ttySupported: false,
    });

    expect(block).toMatchObject({
      id: "agent.security-policy",
      sensitivity: "PUBLIC",
      source: "RUN_SECURITY_POLICY",
    });
    expect(block.text).toContain("FULL_ACCESS");
    expect(block.text).toContain("do not wait for approval");
    expect(block.text).toContain("hard safety denials");
    expect(block.text).toContain("opaque third-party binaries");
    expect(block.text).not.toContain("C:/");
    expect(block.text).not.toContain("D:/");
  });

  it("keeps the model prompt stable when only the audited snapshot creation time changes", () => {
    const first = policyAt("2026-10-01T00:00:00.000Z");
    const second = policyAt("2026-10-09T03:04:05.006Z");

    expect(first.policyDigest).not.toBe(second.policyDigest);
    const firstText = PROJECTOR.project(first, RUNTIME_FACTS).text;
    const secondText = PROJECTOR.project(second, RUNTIME_FACTS).text;
    expect(secondText).toBe(firstText);
    expect(fingerprint(secondText)).toBe(fingerprint(firstText));
    expect(firstText).toContain("policy_semantic_fingerprint=sha256:");
    expect(firstText).not.toContain("policy_digest=");
  });

  it("changes the semantic prompt for every policy and runtime capability change", () => {
    const base = policyAt("2026-10-01T00:00:00.000Z");
    const baseText = PROJECTOR.project(base, RUNTIME_FACTS).text;
    const policyVariants = [
      expandPermissionPreset({
        presetId: "VIEW_ONLY",
        expectedVersion: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
      }),
      expandPermissionPreset({
        presetId: "WORKSPACE_WRITE",
        expectedVersion: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
      }),
      policyWith(base, { approvalPolicy: "ON_BOUNDARY" }),
      policyWith(base, { filesystemBoundary: "WORKSPACE_READ_WRITE" }),
      policyWith(base, { processBoundary: "WORKSPACE_WRITE" }),
      policyWith(base, { requiredEnforcement: "OS_RESTRICTED" }),
      policyWith(base, { hardSafetyPolicyVersion: "hard-safety@2" }),
      policyWith(base, { commandPolicyVersion: "command-policy@2" }),
      policyWith(base, { secretPolicyVersion: "secret-policy@2" }),
    ];
    const runtimeVariants = [
      { ...RUNTIME_FACTS, runtimeKind: "container" },
      { ...RUNTIME_FACTS, sandboxProvider: "fixture-restricted" },
      { ...RUNTIME_FACTS, enforcement: "HARD" as const },
      { ...RUNTIME_FACTS, ttySupported: true },
    ];

    for (const policy of policyVariants) {
      const variantText = PROJECTOR.project(policy, RUNTIME_FACTS).text;
      expect(variantText).not.toBe(baseText);
      expect(fingerprint(variantText)).not.toBe(fingerprint(baseText));
    }
    for (const facts of runtimeVariants) {
      const variantText = PROJECTOR.project(base, facts).text;
      expect(variantText).not.toBe(baseText);
      expect(fingerprint(variantText)).not.toBe(fingerprint(baseText));
    }
  });

  it("uses a field-order-independent fingerprint without exposing snapshot identity", () => {
    const policy = policyAt("2026-10-01T00:00:00.000Z");
    const reordered = {
      policyDigest: policy.policyDigest,
      createdAt: policy.createdAt,
      secretPolicyVersion: policy.secretPolicyVersion,
      commandPolicyVersion: policy.commandPolicyVersion,
      hardSafetyPolicyVersion: policy.hardSafetyPolicyVersion,
      requiredEnforcement: policy.requiredEnforcement,
      processBoundary: policy.processBoundary,
      filesystemBoundary: policy.filesystemBoundary,
      approvalPolicy: policy.approvalPolicy,
      permissionProfile: policy.permissionProfile,
      preset: policy.preset,
      schemaVersion: policy.schemaVersion,
    } satisfies RunSecurityPolicySnapshotV1;

    const originalText = PROJECTOR.project(policy, RUNTIME_FACTS).text;
    expect(PROJECTOR.project(reordered, RUNTIME_FACTS).text).toBe(originalText);
    expect(fingerprint(PROJECTOR.project(reordered, RUNTIME_FACTS).text)).toBe(
      fingerprint(originalText),
    );
    expect(originalText).not.toContain(policy.policyDigest);
    expect(originalText).not.toContain(policy.createdAt);
  });
});
