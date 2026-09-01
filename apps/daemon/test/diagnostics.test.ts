import { describe, expect, it } from "vitest";
import { checkNodePtyLoadability, inspectMigrationAssets } from "../src/diagnostics.js";

describe("daemon production diagnostics", () => {
  it("can load the real node-pty dependency through the runtime package", async () => {
    await expect(checkNodePtyLoadability()).resolves.toEqual({ available: true });
  });

  it("reports migration assets without exposing database internals", () => {
    const result = inspectMigrationAssets();
    expect(result.available).toBe(true);
    expect(result.migrationCount).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("database");
  });
});
