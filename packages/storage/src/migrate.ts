import { fileURLToPath } from "node:url";
import { StorageMigrationError } from "./errors.js";
import type { CaelushDatabase } from "./database.js";
import {
  finalizeAgentMessages,
  migratePostMessageV2Storage,
  migratePublishedStorage,
} from "./messages/migration/finalize-agent-messages.js";
import { finalizeRunSecurityPolicies } from "./security-policy-migration.js";

export function getCaelushMigrationsFolder(): string {
  return fileURLToPath(new URL("../drizzle", import.meta.url));
}

export async function migrateCaelushDatabase(database: CaelushDatabase): Promise<void> {
  try {
    const migrationsFolder = getCaelushMigrationsFolder();
    migratePublishedStorage(database, migrationsFolder);
    finalizeAgentMessages(database, migrationsFolder);
    migratePostMessageV2Storage(database, migrationsFolder);
    finalizeRunSecurityPolicies(database);
  } catch (error) {
    if (error instanceof StorageMigrationError) throw error;
    throw new StorageMigrationError("Caelush database migration failed", { cause: error });
  }
}
