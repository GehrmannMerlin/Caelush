import { describe, expect, it } from "vitest";
import {
  AttachmentProcessingManifestSchema,
  AttachmentReadRangeSchema,
  AttachmentReadResultSchema,
} from "../src/index.js";

const baseManifest = {
  artifactId: "att_1234567890ab",
  sha256: "a".repeat(64),
  mediaType: "application/pdf",
  processorVersion: "attachments-v1",
  visualRequirement: "POSSIBLE",
};

describe("attachment processing contracts", () => {
  it("accepts bounded PDF page metadata without exposing paths or bytes", () => {
    expect(
      AttachmentProcessingManifestSchema.parse({
        ...baseManifest,
        kind: "PDF",
        pageCount: 1,
        pages: [
          {
            pageNumber: 1,
            textAvailable: true,
            visualContentAvailable: false,
            width: 612,
            height: 792,
          },
        ],
      }),
    ).toMatchObject({ kind: "PDF", pageCount: 1 });
    expect(
      AttachmentProcessingManifestSchema.safeParse({
        ...baseManifest,
        kind: "PDF",
        path: "C:/private/document.pdf",
        bytes: "AA==",
        pageCount: 1,
        pages: [],
      }).success,
    ).toBe(false);
  });

  it("limits sheet metadata and validates read ranges without arbitrary paths", () => {
    expect(
      AttachmentProcessingManifestSchema.parse({
        ...baseManifest,
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        kind: "XLSX",
        sheets: [
          {
            name: "Summary",
            state: "VISIBLE",
            rowCount: 3,
            columnCount: 2,
            imageAnchors: ["C1"],
          },
        ],
      }),
    ).toMatchObject({ kind: "XLSX", sheets: [{ name: "Summary" }] });
    expect(
      AttachmentReadRangeSchema.safeParse({
        kind: "XLSX_RANGE",
        sheetName: "Summary",
        range: "A1:XFD1048576",
      }).success,
    ).toBe(false);
    expect(
      AttachmentReadRangeSchema.safeParse({ kind: "FILE", path: "../../secrets" }).success,
    ).toBe(false);
  });

  it("validates a bounded typed read result with exact locations", () => {
    expect(
      AttachmentReadResultSchema.parse({
        artifactId: "att_1234567890ab",
        sha256: "a".repeat(64),
        processorVersion: "attachments-v1",
        range: { kind: "PDF_PAGE", pageNumber: 1 },
        items: [
          {
            type: "TEXT",
            location: { kind: "PDF_PAGE", pageNumber: 1 },
            text: "Synthetic page text",
          },
        ],
        truncated: false,
        outputBytes: 20,
      }),
    ).toMatchObject({ items: [{ location: { kind: "PDF_PAGE", pageNumber: 1 } }] });
  });
});
