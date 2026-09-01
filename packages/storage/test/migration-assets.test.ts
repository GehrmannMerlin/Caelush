import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getCaelushMigrationsFolder } from "../src/migrate.js";

describe("production migration assets", () => {
  it("resolves a non-empty migration directory next to the storage package", () => {
    const folder = getCaelushMigrationsFolder();
    expect(existsSync(folder)).toBe(true);
    expect(readdirSync(folder, { withFileTypes: true }).some((entry) => entry.isDirectory())).toBe(
      true,
    );
  });
});
