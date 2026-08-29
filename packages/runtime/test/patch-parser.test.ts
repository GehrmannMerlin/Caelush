import { describe, expect, it } from "vitest";
import { parsePatch, RuntimePatchError } from "../src/index.js";

describe("parsePatch", () => {
  it("parses ordered add, update, move, and delete operations without touching a filesystem", () => {
    const document = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: src/new.ts",
        "+const answer = 42;",
        "*** Update File: src/old.ts",
        "*** Move to: src/renamed.ts",
        "@@",
        " const before = true;",
        "-const value = 1;",
        "+const value = 2;",
        "*** Delete File: src/remove.ts",
        "*** End Patch",
      ].join("\n"),
    );

    expect(document.operations).toEqual([
      { kind: "ADD", path: "src/new.ts", lines: ["const answer = 42;"] },
      {
        kind: "UPDATE",
        path: "src/old.ts",
        moveTo: "src/renamed.ts",
        hunks: [
          {
            lines: [
              { kind: "CONTEXT", text: "const before = true;" },
              { kind: "REMOVE", text: "const value = 1;" },
              { kind: "ADD", text: "const value = 2;" },
            ],
            endOfFile: false,
          },
        ],
      },
      { kind: "DELETE", path: "src/remove.ts" },
    ]);
  });

  it("supports a move-only update and an explicit end-of-file hunk marker", () => {
    const document = parsePatch(
      [
        "*** Begin Patch",
        "*** Update File: README.md",
        "*** Move to: docs/README.md",
        "*** End Patch",
      ].join("\n"),
    );
    expect(document.operations[0]).toEqual({
      kind: "UPDATE",
      path: "README.md",
      moveTo: "docs/README.md",
      hunks: [],
    });

    const eofDocument = parsePatch(
      [
        "*** Begin Patch",
        "*** Update File: README.md",
        "@@",
        "-old",
        "+new",
        "*** End of File",
        "*** End Patch",
      ].join("\n"),
    );
    expect(eofDocument.operations[0]).toMatchObject({
      kind: "UPDATE",
      hunks: [{ endOfFile: true }],
    });
  });

  it.each([
    ["missing begin marker", "*** Add File: a\n+x\n*** End Patch"],
    ["missing end marker", "*** Begin Patch\n*** Add File: a\n+x"],
    ["empty patch", "*** Begin Patch\n*** End Patch"],
    ["unknown directive", "*** Begin Patch\n*** Rename File: a\n*** End Patch"],
    ["malformed hunk line", "*** Begin Patch\n*** Update File: a\n@@\n?bad\n*** End Patch"],
    ["duplicate source", "*** Begin Patch\n*** Delete File: a\n*** Delete File: a\n*** End Patch"],
    [
      "duplicate move destination",
      "*** Begin Patch\n*** Update File: a\n*** Move to: c\n*** Update File: b\n*** Move to: c\n*** End Patch",
    ],
  ])("rejects %s", (_name, patch) => {
    expect(() => parsePatch(patch)).toThrow(RuntimePatchError);
  });

  it("normalizes CRLF input while counting hunks and preserving line text", () => {
    const document = parsePatch(
      "*** Begin Patch\r\n*** Update File: file.txt\r\n@@\r\n-old\r\n+new\r\n*** End Patch\r\n",
    );
    expect(document.hunkCount).toBe(1);
    expect(document.operations[0]).toMatchObject({ path: "file.txt" });
  });

  it("enforces patch byte and operation budgets", () => {
    expect(() => parsePatch("x".repeat(256 * 1024 + 1))).toThrowError(
      expect.objectContaining({ code: "PATCH_TOO_LARGE" }),
    );
    const tooManyFiles = [
      "*** Begin Patch",
      ...Array.from({ length: 101 }, (_, i) => [`*** Delete File: ${i}.txt`]).flat(),
      "*** End Patch",
    ].join("\n");
    expect(() => parsePatch(tooManyFiles)).toThrowError(
      expect.objectContaining({ code: "TOO_MANY_FILES" }),
    );
  });
});
