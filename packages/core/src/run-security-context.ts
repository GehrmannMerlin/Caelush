import {
  RunSecurityPolicySnapshotV1Schema,
  verifySecurityPolicyDigest,
  type RunSecurityPolicySnapshotV1,
} from "@caelush/protocol";

export interface RunSecurityContext {
  readonly snapshot: RunSecurityPolicySnapshotV1;
  readonly presetId: RunSecurityPolicySnapshotV1["preset"]["id"];
  readonly presetVersion: number;
  readonly permissionProfile: RunSecurityPolicySnapshotV1["permissionProfile"];
  readonly approvalPolicy: RunSecurityPolicySnapshotV1["approvalPolicy"];
  readonly filesystemBoundary: RunSecurityPolicySnapshotV1["filesystemBoundary"];
  readonly processBoundary: RunSecurityPolicySnapshotV1["processBoundary"];
  readonly requiredEnforcement: RunSecurityPolicySnapshotV1["requiredEnforcement"];
  readonly policyDigest: string;
}

export class RunSecurityContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunSecurityContextError";
  }
}

export function createRunSecurityContext(snapshot: unknown): RunSecurityContext {
  if (snapshot === undefined || snapshot === null) {
    throw new RunSecurityContextError("Run security policy snapshot is missing");
  }
  const parsed = RunSecurityPolicySnapshotV1Schema.safeParse(snapshot);
  if (!parsed.success) {
    throw new RunSecurityContextError("Run security policy snapshot is malformed");
  }
  if (!verifySecurityPolicyDigest(parsed.data)) {
    throw new RunSecurityContextError("Run security policy snapshot digest mismatch");
  }
  if (parsed.data.preset.id === "LEGACY_CUSTOM") {
    throw new RunSecurityContextError("LEGACY_CUSTOM Run security policy is recovery-blocked");
  }
  const frozenSnapshot = Object.freeze({
    ...parsed.data,
    preset: Object.freeze({ ...parsed.data.preset }),
  });
  return Object.freeze({
    snapshot: frozenSnapshot,
    presetId: frozenSnapshot.preset.id,
    presetVersion: frozenSnapshot.preset.version,
    permissionProfile: frozenSnapshot.permissionProfile,
    approvalPolicy: frozenSnapshot.approvalPolicy,
    filesystemBoundary: frozenSnapshot.filesystemBoundary,
    processBoundary: frozenSnapshot.processBoundary,
    requiredEnforcement: frozenSnapshot.requiredEnforcement,
    policyDigest: frozenSnapshot.policyDigest,
  });
}
