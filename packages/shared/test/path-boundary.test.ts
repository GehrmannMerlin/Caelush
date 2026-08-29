import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathInsideOrEqual } from "../src/index.js";

describe("isPathInsideOrEqual", () => {
  it("accepts the root and descendants but rejects prefix siblings and parents", () => {
    const root = path.join(path.sep, "workspace", "app");

    expect(isPathInsideOrEqual(root, root)).toBe(true);
    expect(isPathInsideOrEqual(root, path.join(root, "src", "index.ts"))).toBe(true);
    expect(isPathInsideOrEqual(root, path.join(path.dirname(root), "app-other"))).toBe(false);
    expect(isPathInsideOrEqual(root, path.join(root, "..", "secret.txt"))).toBe(false);
  });

  it("normalizes Windows separators for cross-platform containment checks", () => {
    expect(isPathInsideOrEqual("C:\\workspace\\app", "C:\\workspace\\app\\src\\a.ts")).toBe(true);
    expect(isPathInsideOrEqual("C:\\workspace\\app", "C:\\workspace\\other\\a.ts")).toBe(false);
  });
});
