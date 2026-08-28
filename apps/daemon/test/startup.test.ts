import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultDatabasePath } from "../src/main.js";

describe("daemon command startup", () => {
  it("derives the default database path cross-platform", () => {
    expect(getDefaultDatabasePath()).toBe(join(homedir(), ".caelush", "caelush.db"));
  });

  it("can be imported without opening a listener", async () => {
    const module = await import("../src/main.js");
    expect(module.main).toBeTypeOf("function");
  });
});
