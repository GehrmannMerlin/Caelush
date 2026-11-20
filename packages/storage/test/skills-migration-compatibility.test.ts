import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { openCaelushDatabase } from "../src/database.js";
import { getCaelushMigrationsFolder } from "../src/migrate.js";
import { finalizeRunSecurityPolicies } from "../src/security-policy-migration.js";
import {
  finalizeAgentMessages,
  migratePublishedStorage,
} from "../src/messages/migration/finalize-agent-messages.js";
import { makeRun, makeSession } from "./support/fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Phase 08 Skill migration compatibility", () => {
  it("A35 upgrades a pre-Skill database idempotently without inventing Skill facts for old Runs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-phase08-skill-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const priorMigrationsFolder = path.join(directory, "prior-migrations");
    await mkdir(priorMigrationsFolder);

    const publishedFolders = await readdir(getCaelushMigrationsFolder(), {
      withFileTypes: true,
    });
    for (const entry of publishedFolders) {
      if (
        !entry.isDirectory() ||
        entry.name === "20261114120000_skill_settings" ||
        entry.name === "20261115120000_run_workflow_resources" ||
        entry.name === "20261116140000_prepared_input_resource_receipts"
      ) {
        continue;
      }
      await cp(
        path.join(getCaelushMigrationsFolder(), entry.name),
        path.join(priorMigrationsFolder, entry.name),
        { recursive: true },
      );
    }

    const prior = await openCaelushDatabase({ path: databasePath });
    const session = makeSession();
    const legacyRun = makeRun(session.id, { status: "COMPLETED" });
    try {
      migratePublishedStorage(prior, priorMigrationsFolder);
      finalizeAgentMessages(prior, priorMigrationsFolder);
      finalizeRunSecurityPolicies(prior);
      prior.client
        .prepare(
          "INSERT INTO agent_sessions (id, protocol_version, created_at_ms, updated_at_ms, data_json) VALUES (?, 1, ?, ?, ?)",
        )
        .run(session.id, session.createdAt, session.updatedAt, JSON.stringify(session));
      prior.client
        .prepare(
          "INSERT INTO agent_runs (id, session_id, protocol_version, status, created_at_ms, data_json) VALUES (?, ?, 1, ?, ?, ?)",
        )
        .run(
          legacyRun.id,
          legacyRun.sessionId,
          legacyRun.status,
          legacyRun.createdAt,
          JSON.stringify(legacyRun),
        );
    } finally {
      prior.close();
    }

    const upgraded = await openCaelushStorage({ path: databasePath });
    try {
      await expect(upgraded.runs.get(legacyRun.id)).resolves.toMatchObject({
        id: legacyRun.id,
        status: "COMPLETED",
      });
      await expect(upgraded.runs.readWorkflowProfile?.(legacyRun.id)).resolves.toBeNull();
      await expect(upgraded.runs.readPreparedResources?.(legacyRun.id)).resolves.toEqual([]);
      await expect(upgraded.runs.readPreparedInputReceipts?.(legacyRun.id)).resolves.toEqual([]);
    } finally {
      await upgraded.close();
    }

    const onceMigrated = new DatabaseSync(databasePath, { readOnly: true });
    let migrationCount: number;
    try {
      migrationCount = Number(
        (
          onceMigrated.prepare('SELECT COUNT(*) AS count FROM "__drizzle_migrations"').get() as {
            count: number;
          }
        ).count,
      );
    } finally {
      onceMigrated.close();
    }

    const reopened = await openCaelushStorage({ path: databasePath });
    try {
      await expect(reopened.runs.readWorkflowProfile?.(legacyRun.id)).resolves.toBeNull();
      const verification = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          (
            verification.prepare('SELECT COUNT(*) AS count FROM "__drizzle_migrations"').get() as {
              count: number;
            }
          ).count,
        ).toBe(migrationCount);
      } finally {
        verification.close();
      }
    } finally {
      await reopened.close();
    }
  }, 30_000);
});
