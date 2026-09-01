import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { StorageMigrationError } from "./errors.js";
import type { CaelushDatabase } from "./database.js";

export function getCaelushMigrationsFolder(): string {
  return fileURLToPath(new URL("../drizzle", import.meta.url));
}

export async function migrateCaelushDatabase(database: CaelushDatabase): Promise<void> {
  try {
    migrate(database.drizzle, { migrationsFolder: getCaelushMigrationsFolder() });
  } catch (error) {
    throw new StorageMigrationError("Caelush database migration failed", { cause: error });
  }
}
