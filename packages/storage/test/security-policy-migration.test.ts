import {
  AgentRunSchema,
  RunSecurityPolicySnapshotV1Schema,
  computeSecurityPolicyDigest,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  assertFinalizedRunSecurityPolicies,
  finalizeRunSecurityPolicies,
  migrateLegacyRunSecurityPolicy,
  verifyRunSecurityPolicySnapshot,
} from "../src/security-policy-migration.js";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { StorageMigrationError, StorageSecurityPolicyError } from "../src/errors.js";
import { legacySecurityPolicyFixtures } from "./security-policy-fixtures.js";

function legacyRun(
  permissionProfile: "READ_ONLY" | "PROJECT_ACCESS" | "FULL_ACCESS",
  approvalPolicy: "ALWAYS_ASK" | "DANGEROUS_ONLY" | "NEVER_ASK",
) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "migrate security policy",
    status: "WAITING_APPROVAL",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile,
    approvalPolicy,
    limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
    createdAt: createTimestampMs(1_700_000_000_000),
  });
}

describe("Run security policy migration", () => {
  it("maps known legacy combinations without upgrading authority", () => {
    const cases = [
      [legacySecurityPolicyFixtures.readOnlyDangerousOnly, "VIEW_ONLY", "WORKSPACE_READ_ONLY"],
      [
        legacySecurityPolicyFixtures.projectAccessDangerousOnly,
        "WORKSPACE_WRITE",
        "WORKSPACE_READ_WRITE",
      ],
      [legacySecurityPolicyFixtures.fullAccessNeverAsk, "FULL_ACCESS", "HOST_USER_SCOPE"],
    ] as const;

    for (const [{ permissionProfile, approvalPolicy }, presetId, filesystemBoundary] of cases) {
      const migrated = migrateLegacyRunSecurityPolicy(legacyRun(permissionProfile, approvalPolicy));
      expect(migrated.securityPolicy).toMatchObject({
        preset: { id: presetId, version: 1 },
        filesystemBoundary,
      });
      if (migrated.securityPolicy === undefined) throw new Error("migration omitted policy");
      expect(() => verifyRunSecurityPolicySnapshot(migrated.securityPolicy!)).not.toThrow();
      expect(migrated.securityPolicy.permissionProfile).toBe(permissionProfile);
    }
  });

  it("marks ambiguous legacy combinations as recovery-blocked LEGACY_CUSTOM", () => {
    const migrated = migrateLegacyRunSecurityPolicy(
      legacyRun(
        legacySecurityPolicyFixtures.ambiguousNeverAsk.permissionProfile,
        legacySecurityPolicyFixtures.ambiguousNeverAsk.approvalPolicy,
      ),
    );

    expect(migrated.securityPolicy?.preset.id).toBe("LEGACY_CUSTOM");
    expect(migrated.securityPolicy?.approvalPolicy).toBe("NEVER_ASK");
    expect(() => verifyRunSecurityPolicySnapshot(migrated.securityPolicy!)).not.toThrow();
  });

  it("is idempotent and refuses malformed JSON or a digest mismatch", () => {
    const migrated = migrateLegacyRunSecurityPolicy(legacyRun("PROJECT_ACCESS", "DANGEROUS_ONLY"));
    expect(migrateLegacyRunSecurityPolicy(migrated)).toEqual(migrated);
    expect(() => migrateLegacyRunSecurityPolicy({ data_json: "{" })).toThrow(
      StorageSecurityPolicyError,
    );

    const valid = RunSecurityPolicySnapshotV1Schema.parse(migrated.securityPolicy);
    expect(() =>
      verifyRunSecurityPolicySnapshot({ ...valid, policyDigest: "0".repeat(64) }),
    ).toThrow(StorageSecurityPolicyError);
    expect(computeSecurityPolicyDigest(valid)).toBe(valid.policyDigest);
  });

  it("finalizes persisted rows transactionally and is safe to rerun", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    try {
      await migrateCaelushDatabase(database);
      const legacy = legacyRun("READ_ONLY", "DANGEROUS_ONLY");
      database.client
        .prepare(
          "INSERT INTO agent_sessions (id, protocol_version, created_at_ms, updated_at_ms, data_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(legacy.sessionId, 1, 1, 1, "{}");
      database.client
        .prepare(
          "INSERT INTO agent_runs (id, session_id, protocol_version, status, created_at_ms, data_json) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          legacy.id,
          legacy.sessionId,
          1,
          legacy.status,
          legacy.createdAt,
          JSON.stringify(legacy),
        );

      finalizeRunSecurityPolicies(database);
      const first = database.client
        .prepare("SELECT data_json FROM agent_runs WHERE id = ?")
        .get(legacy.id) as { data_json: string };
      finalizeRunSecurityPolicies(database);
      const second = database.client
        .prepare("SELECT data_json FROM agent_runs WHERE id = ?")
        .get(legacy.id) as { data_json: string };

      expect(JSON.parse(first.data_json).securityPolicy.preset.id).toBe("VIEW_ONLY");
      expect(second.data_json).toBe(first.data_json);
      expect(() => assertFinalizedRunSecurityPolicies(database)).not.toThrow();

      database.client
        .prepare("UPDATE agent_runs SET data_json = ? WHERE id = ?")
        .run(JSON.stringify(legacy), legacy.id);
      expect(() => assertFinalizedRunSecurityPolicies(database)).toThrow(StorageMigrationError);
    } finally {
      database.close();
    }
  });
});
