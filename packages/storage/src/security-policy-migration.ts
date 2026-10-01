import {
  AgentRunSchema,
  RunSecurityPolicySnapshotV1Schema,
  computeSecurityPolicyDigest,
  type AgentRun,
  type ApprovalPolicy,
  type FilesystemBoundary,
  type PermissionProfile,
  type ProcessBoundary,
  type RequiredEnforcement,
  type RunSecurityPolicySnapshotV1,
} from "@caelush/protocol";
import type { CaelushDatabase } from "./database.js";
import { StorageMigrationError, StorageSecurityPolicyError } from "./errors.js";

export type LegacyRunSecurityPolicyRow =
  AgentRun | { readonly data_json: string } | { readonly dataJson: string };

function decodeInput(input: LegacyRunSecurityPolicyRow): AgentRun {
  if ("data_json" in input || "dataJson" in input) {
    const json = "data_json" in input ? input.data_json : input.dataJson;
    try {
      return AgentRunSchema.parse(JSON.parse(json) as unknown);
    } catch (error) {
      throw new StorageSecurityPolicyError(
        "MALFORMED",
        "Legacy AgentRun policy JSON is malformed",
        {
          cause: error,
        },
      );
    }
  }
  try {
    return AgentRunSchema.parse(input);
  } catch (error) {
    throw new StorageSecurityPolicyError("MALFORMED", "Legacy AgentRun policy data is malformed", {
      cause: error,
    });
  }
}

function boundaryForProfile(permissionProfile: PermissionProfile): {
  readonly filesystemBoundary: FilesystemBoundary;
  readonly processBoundary: ProcessBoundary;
  readonly requiredEnforcement: RequiredEnforcement;
} {
  switch (permissionProfile) {
    case "READ_ONLY":
      return {
        filesystemBoundary: "WORKSPACE_READ_ONLY",
        processBoundary: "READ_ONLY",
        requiredEnforcement: "OS_RESTRICTED",
      };
    case "PROJECT_ACCESS":
      return {
        filesystemBoundary: "WORKSPACE_READ_WRITE",
        processBoundary: "WORKSPACE_WRITE",
        requiredEnforcement: "OS_RESTRICTED",
      };
    case "FULL_ACCESS":
      return {
        filesystemBoundary: "HOST_USER_SCOPE",
        processBoundary: "UNRESTRICTED",
        requiredEnforcement: "HARD_SAFETY_ONLY",
      };
  }
}

function knownPreset(
  permissionProfile: PermissionProfile,
  approvalPolicy: ApprovalPolicy,
): "VIEW_ONLY" | "WORKSPACE_WRITE" | "FULL_ACCESS" | undefined {
  if (
    permissionProfile === "READ_ONLY" &&
    (approvalPolicy === "ALWAYS_ASK" || approvalPolicy === "DANGEROUS_ONLY")
  ) {
    return "VIEW_ONLY";
  }
  if (
    permissionProfile === "PROJECT_ACCESS" &&
    (approvalPolicy === "ALWAYS_ASK" || approvalPolicy === "DANGEROUS_ONLY")
  ) {
    return "WORKSPACE_WRITE";
  }
  if (permissionProfile === "FULL_ACCESS" && approvalPolicy === "NEVER_ASK") {
    return "FULL_ACCESS";
  }
  return undefined;
}

function createSnapshot(run: AgentRun): RunSecurityPolicySnapshotV1 {
  const permissionProfile = run.permissionProfile;
  const approvalPolicy = run.approvalPolicy;
  const mappedPreset = knownPreset(permissionProfile, approvalPolicy);
  const boundaries = boundaryForProfile(permissionProfile);
  const withoutDigest = {
    schemaVersion: 1 as const,
    preset: { id: mappedPreset ?? "LEGACY_CUSTOM", version: 1 },
    permissionProfile,
    approvalPolicy:
      mappedPreset === undefined
        ? approvalPolicy
        : mappedPreset === "FULL_ACCESS"
          ? "NEVER_ASK"
          : "ON_BOUNDARY",
    ...boundaries,
    hardSafetyPolicyVersion: "hard-safety@1",
    commandPolicyVersion: "command-policy@1",
    secretPolicyVersion: "secret-policy@1",
    createdAt: new Date(Number(run.createdAt)).toISOString(),
  } satisfies Omit<RunSecurityPolicySnapshotV1, "policyDigest">;
  return RunSecurityPolicySnapshotV1Schema.parse({
    ...withoutDigest,
    policyDigest: computeSecurityPolicyDigest(withoutDigest),
  });
}

/**
 * Verify a persisted snapshot without consulting current defaults. A valid LEGACY_CUSTOM snapshot is
 * intentionally accepted here so recovery can report the explicit blocked historical state; Core's
 * execution context rejects it before any Tool can run.
 */
export function verifyRunSecurityPolicySnapshot(
  snapshot: unknown,
): asserts snapshot is RunSecurityPolicySnapshotV1 {
  if (snapshot === undefined || snapshot === null) {
    throw new StorageSecurityPolicyError("MISSING", "Run security policy snapshot is missing");
  }
  const parsed = RunSecurityPolicySnapshotV1Schema.safeParse(snapshot);
  if (!parsed.success) {
    throw new StorageSecurityPolicyError("MALFORMED", "Run security policy snapshot is malformed", {
      cause: parsed.error,
    });
  }
  if (computeSecurityPolicyDigest(parsed.data) !== parsed.data.policyDigest) {
    throw new StorageSecurityPolicyError(
      "DIGEST_MISMATCH",
      "Run security policy snapshot digest does not match its contents",
    );
  }
}

export function migrateLegacyRunSecurityPolicy(input: LegacyRunSecurityPolicyRow): AgentRun {
  const run = decodeInput(input);
  if (run.securityPolicy !== undefined) {
    verifyRunSecurityPolicySnapshot(run.securityPolicy);
    return run;
  }
  return { ...run, securityPolicy: createSnapshot(run) };
}

/** Finalize every old `agent_runs.data_json` row exactly once after published migrations. */
export function finalizeRunSecurityPolicies(database: CaelushDatabase): void {
  const rows = database.client
    .prepare("SELECT id, data_json FROM agent_runs ORDER BY id ASC")
    .all() as Array<{ id: string; data_json: string }>;
  const client = database.client;
  client.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      let migrated: AgentRun;
      try {
        migrated = migrateLegacyRunSecurityPolicy({ data_json: row.data_json });
      } catch (error) {
        throw new StorageMigrationError(`Run security policy migration failed for ${row.id}`, {
          cause: error,
        });
      }
      if (migrated.id !== row.id) {
        throw new StorageMigrationError(`Run security policy identity mismatch for ${row.id}`);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(row.data_json) as unknown;
      } catch {
        throw new StorageMigrationError(`Run security policy JSON is malformed for ${row.id}`);
      }
      if (raw !== null && typeof raw === "object" && Object.hasOwn(raw, "securityPolicy")) {
        // Keep verified rows byte-for-byte intact so the finalizer is idempotent for backup/diff
        // tooling as well as semantically stable.
        continue;
      }
      client
        .prepare("UPDATE agent_runs SET data_json = ? WHERE id = ?")
        .run(JSON.stringify(migrated), row.id);
    }
    client.exec("COMMIT");
  } catch (error) {
    try {
      client.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new StorageMigrationError("Run security policy migration rollback failed", {
        cause: rollbackError,
      });
    }
    if (error instanceof StorageMigrationError) throw error;
    throw new StorageMigrationError("Run security policy migration failed", { cause: error });
  }
}
