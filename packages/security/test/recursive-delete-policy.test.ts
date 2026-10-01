import { describe, expect, it } from "vitest";
import { classifyRecursiveDelete } from "../src/index.js";

describe("recursive delete policy", () => {
  it.each(["DYNAMIC", "UNKNOWN"] as const)(
    "denies unresolved recursive deletion: %s",
    (resolution) => {
      expect(
        classifyRecursiveDelete({
          recursive: true,
          resolution,
          relation: "WORKSPACE",
        }),
      ).toMatchObject({ kind: "DENY", reasonCode: "RECURSIVE_DELETE_UNRESOLVED" });
    },
  );

  it("allows an exact non-protected target to continue to the preset boundary", () => {
    expect(
      classifyRecursiveDelete({
        recursive: true,
        resolution: "EXACT",
        relation: "OUTSIDE_WORKSPACE",
      }),
    ).toMatchObject({ kind: "ALLOW" });
  });
});
