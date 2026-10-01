import {
  PermissionPresetDescriptorSchema,
  RunSecurityPolicySnapshotV1Schema,
  computeSecurityPolicyDigest,
  type PermissionPresetDescriptor,
  type RunSecurityPolicySnapshotV1,
  type SelectablePermissionPresetId,
} from "@caelush/protocol";
import { SecurityPolicyInvariantError } from "./errors.js";

export interface PermissionPresetHostConstraints {
  readonly fullAccessAvailable?: boolean;
  readonly restrictedExecutionAvailable?: boolean;
}

export type PermissionPresetTemplate = PermissionPresetDescriptor;

const PRESET_CATALOG: readonly PermissionPresetTemplate[] = Object.freeze([
  Object.freeze({
    id: "VIEW_ONLY",
    version: 1,
    displayName: "View only",
    description: "Read project files and repository metadata without modifying the workspace.",
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ON_BOUNDARY",
    filesystemBoundary: "WORKSPACE_READ_ONLY",
    processBoundary: "READ_ONLY",
    requiredEnforcement: "OS_RESTRICTED",
    requiresConfirmation: false,
  }),
  Object.freeze({
    id: "WORKSPACE_WRITE",
    version: 1,
    displayName: "Workspace write",
    description: "Modify files and run project work inside the selected workspace boundary.",
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "ON_BOUNDARY",
    filesystemBoundary: "WORKSPACE_READ_WRITE",
    processBoundary: "WORKSPACE_WRITE",
    requiredEnforcement: "OS_RESTRICTED",
    requiresConfirmation: false,
  }),
  Object.freeze({
    id: "FULL_ACCESS",
    version: 1,
    displayName: "Full access",
    description:
      "Allow host-user-scope work without approval waits, while retaining hard safety denials.",
    permissionProfile: "FULL_ACCESS",
    approvalPolicy: "NEVER_ASK",
    filesystemBoundary: "HOST_USER_SCOPE",
    processBoundary: "UNRESTRICTED",
    requiredEnforcement: "HARD_SAFETY_ONLY",
    requiresConfirmation: true,
  }),
]);

export function getPermissionPresetCatalog(
  _hostConstraints?: PermissionPresetHostConstraints,
): readonly PermissionPresetTemplate[] {
  void _hostConstraints;
  // Availability is reported separately by the daemon. Returning a stable catalog here prevents
  // a host probe from changing the policy composition that a client can request.
  return PRESET_CATALOG;
}

export interface ExpandPermissionPresetInput {
  readonly presetId: SelectablePermissionPresetId;
  readonly expectedVersion: number;
  readonly createdAt: string;
}

export function expandPermissionPreset(
  input: ExpandPermissionPresetInput,
): RunSecurityPolicySnapshotV1 {
  const preset = PRESET_CATALOG.find((candidate) => candidate.id === input.presetId);
  if (preset === undefined) {
    throw new SecurityPolicyInvariantError(`Unknown permission preset: ${String(input.presetId)}.`);
  }
  if (input.expectedVersion !== preset.version) {
    throw new SecurityPolicyInvariantError(
      `Permission preset ${preset.id} version ${input.expectedVersion} is stale; expected ${preset.version}.`,
    );
  }
  if (typeof input.createdAt !== "string" || input.createdAt.length === 0) {
    throw new SecurityPolicyInvariantError("Permission preset creation time is invalid.");
  }

  const withoutDigest = {
    schemaVersion: 1 as const,
    preset: { id: preset.id, version: preset.version },
    permissionProfile: preset.permissionProfile,
    approvalPolicy: preset.approvalPolicy,
    filesystemBoundary: preset.filesystemBoundary,
    processBoundary: preset.processBoundary,
    requiredEnforcement: preset.requiredEnforcement,
    hardSafetyPolicyVersion: "hard-safety@1",
    commandPolicyVersion: "command-policy@1",
    secretPolicyVersion: "secret-policy@1",
    createdAt: input.createdAt,
  };
  const snapshot = {
    ...withoutDigest,
    policyDigest: computeSecurityPolicyDigest(withoutDigest),
  };
  const parsed = RunSecurityPolicySnapshotV1Schema.safeParse(snapshot);
  if (!parsed.success) {
    throw new SecurityPolicyInvariantError(
      "Expanded permission preset produced an invalid snapshot.",
    );
  }
  return Object.freeze(parsed.data);
}

export function assertPermissionPresetDescriptor(
  descriptor: PermissionPresetDescriptor,
): PermissionPresetDescriptor {
  const parsed = PermissionPresetDescriptorSchema.safeParse(descriptor);
  if (!parsed.success)
    throw new SecurityPolicyInvariantError("Permission preset descriptor is invalid.");
  return parsed.data;
}
