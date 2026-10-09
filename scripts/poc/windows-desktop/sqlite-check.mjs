import { DatabaseSync } from "node:sqlite";

const databasePath = process.argv[2];
if (typeof databasePath !== "string" || databasePath.length === 0) {
  process.exitCode = 2;
} else {
  const database = new DatabaseSync(databasePath);
  try {
    const result = database.prepare("PRAGMA integrity_check").get();
    const tables = database
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'")
      .get();
    if (result?.integrity_check !== "ok") throw new Error("SQLITE_INTEGRITY_FAILED");
    process.stdout.write(
      `${JSON.stringify({ integrity: result.integrity_check, tables: tables?.count })}\n`,
    );
  } finally {
    database.close();
  }
}
