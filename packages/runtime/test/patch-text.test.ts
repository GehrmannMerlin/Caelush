import { describe, expect, it } from "vitest";
import { applyPatchHunks, decodePatchText, encodePatchedText } from "../src/patch/text.js";
import { RuntimePatchError } from "../src/index.js";

const encoder = new TextEncoder();

describe("patch text handling", () => {
  it("preserves BOM, dominant newline, tie-first newline, and final newline", () => {
    const source = encoder.encode("\uFEFFone\r\ntwo\rthree\r\n");
    const decoded = decodePatchText("notes.txt", source);
    expect(decoded).toMatchObject({ bom: true, newline: "CRLF", finalNewline: true });
    expect(encodePatchedText(decoded, "one\ntwo\nthree changed")).toEqual(
      encoder.encode("\uFEFFone\r\ntwo\rthree changed\r\n"),
    );

    const tie = decodePatchText("tie.txt", encoder.encode("a\nb\r\nc"));
    expect(tie.newline).toBe("LF");
  });

  it("rejects binary and invalid UTF-8 content", () => {
    expect(() => decodePatchText("image.png", Uint8Array.from([1, 2, 3]))).toThrowError(
      expect.objectContaining({ code: "BINARY_FILE" }),
    );
    expect(() => decodePatchText("text.txt", Uint8Array.from([0xc3, 0x28]))).toThrowError(
      expect.objectContaining({ code: "INVALID_UTF8" }),
    );
  });

  it("requires one exact hunk match and applies multiple hunks to one in-memory result", () => {
    const updated = applyPatchHunks("a\nb\nc\nd", [
      {
        endOfFile: false,
        lines: [
          { kind: "CONTEXT", text: "a" },
          { kind: "REMOVE", text: "b" },
          { kind: "ADD", text: "B" },
        ],
      },
      {
        endOfFile: true,
        lines: [
          { kind: "REMOVE", text: "d" },
          { kind: "ADD", text: "D" },
        ],
      },
    ]);
    expect(updated).toBe("a\nB\nc\nD");

    expect(() =>
      applyPatchHunks("same\nsame", [
        {
          endOfFile: false,
          lines: [
            { kind: "CONTEXT", text: "same" },
            { kind: "ADD", text: "x" },
          ],
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "PATCH_CONTEXT_AMBIGUOUS" }));
    expect(() =>
      applyPatchHunks("different", [
        {
          endOfFile: false,
          lines: [
            { kind: "CONTEXT", text: "missing" },
            { kind: "ADD", text: "x" },
          ],
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "PATCH_CONTEXT_MISMATCH" }));
  });

  it("rejects invalid hunk shapes instead of guessing an insertion point", () => {
    expect(() =>
      applyPatchHunks("content", [{ endOfFile: false, lines: [{ kind: "ADD", text: "guess" }] }]),
    ).toThrow(RuntimePatchError);
  });
});
