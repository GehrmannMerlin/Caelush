import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";

export interface CaelushDatabase {
  readonly path: string;
  readonly client: DatabaseSync;
  readonly drizzle: NodeSQLiteDatabase;
  close(): void;
}

export async function openCaelushDatabase(options: { path: string }): Promise<CaelushDatabase> {
  const client = new DatabaseSync(options.path);

  try {
    client.exec("PRAGMA foreign_keys = ON");
    client.exec("PRAGMA busy_timeout = 5000");
    if (options.path !== ":memory:") {
      client.exec("PRAGMA journal_mode = WAL");
    }

    return {
      path: options.path,
      client,
      drizzle: drizzle({ client }),
      close: () => client.close(),
    };
  } catch (error) {
    client.close();
    throw error;
  }
}
