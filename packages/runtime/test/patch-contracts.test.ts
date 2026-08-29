import { describe, expect, it } from "vitest";
import { PATCH_LIMITS, type PatchDocument } from "../src/index.js";

describe("patch runtime contracts", () => {
  it("publishes bounded constants without exposing filesystem implementation types", () => {
    expect(PATCH_LIMITS).toEqual({
      maxPatchBytes: 256 * 1024,
      maxFiles: 100,
      maxHunks: 1000,
      maxTargetFileBytes: 8 * 1024 * 1024,
      maxPreparedBytes: 32 * 1024 * 1024,
    });
  });

  it("keeps the patch document JSON-safe", () => {
    const document: PatchDocument = {
      operations: [{ kind: "DELETE", path: "old.txt" }],
      fileCount: 1,
      hunkCount: 0,
    };
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });
});
