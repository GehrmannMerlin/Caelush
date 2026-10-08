import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCaelushMigrationsFolder } from "../src/migrate.js";

describe("production migration assets", () => {
  it("resolves a non-empty migration directory next to the storage package", () => {
    const folder = getCaelushMigrationsFolder();
    expect(existsSync(folder)).toBe(true);
    expect(readdirSync(folder, { withFileTypes: true }).some((entry) => entry.isDirectory())).toBe(
      true,
    );
    const promptSurfaceMigration = path.join(
      folder,
      "20261006100000_prompt_surface",
      "migration.sql",
    );
    expect(existsSync(promptSurfaceMigration)).toBe(true);
    const promptSurfaceSameStepMigration = path.join(
      folder,
      "20261006110000_prompt_surface_same_step_epochs",
      "migration.sql",
    );
    expect(existsSync(promptSurfaceSameStepMigration)).toBe(true);
    expect(existsSync(path.join(folder, "20261008100000_prompt_surface_v3", "migration.sql"))).toBe(
      true,
    );
  });
});
