import { describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";

describe("Caelush database lifecycle", () => {
  it("opens an explicit in-memory database with SQLite safety pragmas", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });

    expect(database.drizzle).toBeDefined();

    database.close();
  });

  it("enables foreign keys and does not open a database during module import", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });

    expect(database.client.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.client.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });

    database.close();
  });
});
