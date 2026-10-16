import type { CaelushDatabase } from "../database.js";

/** All work in the callback is synchronous; no external operation may hold this transaction. */
export function archiveTransaction<T>(
  database: CaelushDatabase,
  write: boolean,
  operation: () => T,
): T {
  database.client.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = operation();
    database.client.exec("COMMIT");
    return result;
  } catch (error) {
    database.client.exec("ROLLBACK");
    throw error;
  }
}
