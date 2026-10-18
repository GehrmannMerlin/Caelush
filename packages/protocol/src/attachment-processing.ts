import { z } from "zod";
import {
  AttachmentIdSchema,
  AttachmentMediaTypeSchema,
  AttachmentSha256Schema,
  AttachmentVisualRequirementSchema,
} from "./attachment.js";

export const MAX_ATTACHMENT_DOCUMENT_PAGES = 250;
export const MAX_ATTACHMENT_DOCUMENT_BLOCKS = 5_000;
export const MAX_ATTACHMENT_WORKSHEETS = 128;
export const MAX_ATTACHMENT_READ_RESULT_BYTES = 256 * 1024;
export const MAX_ATTACHMENT_DOCUMENT_TEXT_BYTES = 64 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_LINES = 1_000_000;
export const MAX_ATTACHMENT_READ_ITEMS = 256;
export const MAX_ATTACHMENT_XLSX_RANGE_CELLS = 2_000;

const ProcessingManifestBaseSchema = z.object({
  artifactId: AttachmentIdSchema,
  sha256: AttachmentSha256Schema,
  mediaType: AttachmentMediaTypeSchema,
  processorVersion: z.string().min(1).max(128),
  visualRequirement: AttachmentVisualRequirementSchema,
});

const AttachmentTextProcessingManifestSchema = ProcessingManifestBaseSchema.extend({
  kind: z.literal("TEXT"),
  encoding: z.enum(["UTF-8", "UTF-16LE", "UTF-16BE", "WINDOWS-1252"]),
  lineCount: z.number().int().min(0).max(MAX_ATTACHMENT_TEXT_LINES),
  characterCount: z.number().int().min(0).max(25_000_000),
}).strict();

const AttachmentImageProcessingManifestSchema = ProcessingManifestBaseSchema.extend({
  kind: z.literal("IMAGE"),
  width: z.number().int().min(1).max(100_000),
  height: z.number().int().min(1).max(100_000),
  frameCount: z.number().int().min(1).max(10_000),
  animated: z.boolean(),
})
  .strict()
  .refine((manifest) => manifest.width * manifest.height <= 12_000_000, {
    message: "Image pixel count exceeds the attachment limit.",
  });

const AttachmentPdfPageManifestSchema = z
  .object({
    pageNumber: z.number().int().min(1).max(MAX_ATTACHMENT_DOCUMENT_PAGES),
    textAvailable: z.boolean(),
    visualContentAvailable: z.boolean(),
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000),
  })
  .strict();

const AttachmentPdfProcessingManifestSchema = ProcessingManifestBaseSchema.extend({
  kind: z.literal("PDF"),
  pageCount: z.number().int().min(1).max(MAX_ATTACHMENT_DOCUMENT_PAGES),
  pages: z.array(AttachmentPdfPageManifestSchema).min(1).max(MAX_ATTACHMENT_DOCUMENT_PAGES),
})
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.pages.length !== manifest.pageCount) {
      context.addIssue({ code: "custom", message: "PDF page metadata does not match page count." });
    }
    if (manifest.pages.some((page, index) => page.pageNumber !== index + 1)) {
      context.addIssue({ code: "custom", message: "PDF page metadata must be ordered." });
    }
  });

const AttachmentDocxBlockManifestSchema = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_ATTACHMENT_DOCUMENT_BLOCKS - 1),
    kind: z.enum(["PARAGRAPH", "TABLE", "IMAGE"]),
    textLength: z.number().int().min(0).max(MAX_ATTACHMENT_DOCUMENT_TEXT_BYTES).optional(),
    rowCount: z.number().int().min(0).max(100_000).optional(),
    columnCount: z.number().int().min(0).max(16_384).optional(),
    imageIndices: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(MAX_ATTACHMENT_DOCUMENT_BLOCKS - 1),
      )
      .max(256)
      .optional(),
  })
  .strict();

const AttachmentDocxProcessingManifestSchema = ProcessingManifestBaseSchema.extend({
  kind: z.literal("DOCX"),
  blockCount: z.number().int().min(0).max(MAX_ATTACHMENT_DOCUMENT_BLOCKS),
  paragraphCount: z.number().int().min(0).max(MAX_ATTACHMENT_DOCUMENT_BLOCKS),
  tableCount: z.number().int().min(0).max(MAX_ATTACHMENT_DOCUMENT_BLOCKS),
  imageCount: z.number().int().min(0).max(MAX_ATTACHMENT_DOCUMENT_BLOCKS),
  blocks: z.array(AttachmentDocxBlockManifestSchema).max(MAX_ATTACHMENT_DOCUMENT_BLOCKS),
}).strict();

const AttachmentXlsxSheetManifestSchema = z
  .object({
    name: z.string().min(1).max(31),
    state: z.enum(["VISIBLE", "HIDDEN", "VERY_HIDDEN"]),
    rowCount: z.number().int().min(0).max(1_048_576),
    columnCount: z.number().int().min(0).max(16_384),
    imageAnchors: z.array(z.string().regex(/^[A-Z]{1,3}[1-9][0-9]*$/)).max(256),
  })
  .strict();

const AttachmentXlsxProcessingManifestSchema = ProcessingManifestBaseSchema.extend({
  kind: z.literal("XLSX"),
  sheets: z.array(AttachmentXlsxSheetManifestSchema).min(1).max(MAX_ATTACHMENT_WORKSHEETS),
}).strict();

export const AttachmentProcessingManifestSchema = z.discriminatedUnion("kind", [
  AttachmentTextProcessingManifestSchema,
  AttachmentImageProcessingManifestSchema,
  AttachmentPdfProcessingManifestSchema,
  AttachmentDocxProcessingManifestSchema,
  AttachmentXlsxProcessingManifestSchema,
]);
export type AttachmentProcessingManifest = z.infer<typeof AttachmentProcessingManifestSchema>;

const xlsxRangeCellCount = (range: string): number | null => {
  const match = /^\$?([A-Z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Z]{1,3})\$?([1-9][0-9]*))?$/u.exec(
    range,
  );
  if (match === null) return null;
  const columnNumber = (letters: string): number =>
    [...letters].reduce((number, char) => number * 26 + char.charCodeAt(0) - 64, 0);
  const startColumn = columnNumber(match[1]!);
  const startRow = Number(match[2]);
  const endColumn = columnNumber(match[3] ?? match[1]!);
  const endRow = Number(match[4] ?? match[2]);
  if (endColumn > 16_384 || endRow > 1_048_576 || endColumn < startColumn || endRow < startRow) {
    return null;
  }
  return (endColumn - startColumn + 1) * (endRow - startRow + 1);
};

export const AttachmentReadRangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("MANIFEST") }).strict(),
  z
    .object({
      kind: z.literal("TEXT_LINES"),
      startLine: z.number().int().min(1).max(MAX_ATTACHMENT_TEXT_LINES),
      lineCount: z.number().int().min(1).max(500),
      startCharacter: z.number().int().min(0).max(MAX_ATTACHMENT_DOCUMENT_TEXT_BYTES).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("SEARCH"),
      query: z.string().min(1).max(512),
      maxMatches: z.number().int().min(1).max(100),
      startMatch: z.number().int().min(0).max(100_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("PDF_PAGE"),
      pageNumber: z.number().int().min(1).max(MAX_ATTACHMENT_DOCUMENT_PAGES),
      textOffset: z.number().int().min(0).max(MAX_ATTACHMENT_DOCUMENT_TEXT_BYTES).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("DOCX_BLOCKS"),
      startIndex: z
        .number()
        .int()
        .min(0)
        .max(MAX_ATTACHMENT_DOCUMENT_BLOCKS - 1),
      blockCount: z.number().int().min(1).max(100),
      tableRow: z.number().int().min(0).max(100_000).optional(),
      tableColumn: z.number().int().min(0).max(16_384).optional(),
      textOffset: z.number().int().min(0).max(MAX_ATTACHMENT_DOCUMENT_TEXT_BYTES).optional(),
      imageIndex: z
        .number()
        .int()
        .min(0)
        .max(MAX_ATTACHMENT_DOCUMENT_BLOCKS - 1)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("XLSX_RANGE"),
      sheetName: z.string().min(1).max(31),
      range: z
        .string()
        .min(1)
        .max(32)
        .regex(/^\$?[A-Z]{1,3}\$?[1-9][0-9]*(?::\$?[A-Z]{1,3}\$?[1-9][0-9]*)?$/u),
      startCell: z
        .string()
        .regex(/^[A-Z]{1,3}[1-9][0-9]*$/u)
        .optional(),
      startImageIndex: z.number().int().min(0).max(256).optional(),
      skipCell: z.boolean().optional(),
      textOffset: z.number().int().min(0).max(MAX_ATTACHMENT_DOCUMENT_TEXT_BYTES).optional(),
    })
    .strict()
    .refine((range) => {
      const count = xlsxRangeCellCount(range.range);
      return count !== null && count <= MAX_ATTACHMENT_XLSX_RANGE_CELLS;
    }, "Spreadsheet read range exceeds its cell limit."),
  z.object({ kind: z.literal("IMAGE") }).strict(),
]);
export type AttachmentReadRange = z.infer<typeof AttachmentReadRangeSchema>;

export const AttachmentReadLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("MANIFEST") }).strict(),
  z
    .object({
      kind: z.literal("TEXT_LINES"),
      startLine: z.number().int().min(1).max(MAX_ATTACHMENT_TEXT_LINES),
      endLine: z.number().int().min(1).max(MAX_ATTACHMENT_TEXT_LINES),
    })
    .strict(),
  z
    .object({
      kind: z.literal("PDF_PAGE"),
      pageNumber: z.number().int().min(1).max(MAX_ATTACHMENT_DOCUMENT_PAGES),
    })
    .strict(),
  z
    .object({
      kind: z.literal("DOCX_BLOCK"),
      blockIndex: z
        .number()
        .int()
        .min(0)
        .max(MAX_ATTACHMENT_DOCUMENT_BLOCKS - 1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("DOCX_TABLE_CELL"),
      blockIndex: z
        .number()
        .int()
        .min(0)
        .max(MAX_ATTACHMENT_DOCUMENT_BLOCKS - 1),
      rowIndex: z.number().int().min(0).max(100_000),
      columnIndex: z.number().int().min(0).max(16_384),
    })
    .strict(),
  z
    .object({
      kind: z.literal("DOCX_IMAGE"),
      imageIndex: z
        .number()
        .int()
        .min(0)
        .max(MAX_ATTACHMENT_DOCUMENT_BLOCKS - 1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("XLSX_CELL"),
      sheetName: z.string().min(1).max(31),
      address: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]*$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal("XLSX_IMAGE"),
      sheetName: z.string().min(1).max(31),
      cellAddress: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]*$/u),
    })
    .strict(),
  z.object({ kind: z.literal("IMAGE") }).strict(),
]);
export type AttachmentReadLocation = z.infer<typeof AttachmentReadLocationSchema>;

const AttachmentReadTextItemSchema = z
  .object({
    type: z.literal("TEXT"),
    location: AttachmentReadLocationSchema,
    text: z.string().max(MAX_ATTACHMENT_READ_RESULT_BYTES),
  })
  .strict();

const AttachmentReadCellItemSchema = z
  .object({
    type: z.literal("CELL"),
    location: z
      .object({
        kind: z.literal("XLSX_CELL"),
        sheetName: z.string().min(1).max(31),
        address: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]*$/u),
      })
      .strict(),
    formula: z.string().max(16_384).optional(),
    value: z.union([z.string().max(16_384), z.number(), z.boolean(), z.null()]).optional(),
  })
  .strict();

const AttachmentReadImageItemSchema = z
  .object({
    type: z.literal("IMAGE"),
    location: AttachmentReadLocationSchema,
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    data: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_ATTACHMENT_READ_RESULT_BYTES * 4) / 3)),
    width: z.number().int().min(1).max(100_000),
    height: z.number().int().min(1).max(100_000),
  })
  .strict();

export const AttachmentReadItemSchema = z.discriminatedUnion("type", [
  AttachmentReadTextItemSchema,
  AttachmentReadCellItemSchema,
  AttachmentReadImageItemSchema,
]);
export type AttachmentReadItem = z.infer<typeof AttachmentReadItemSchema>;

export const AttachmentReadResultSchema = z
  .object({
    artifactId: AttachmentIdSchema,
    sha256: AttachmentSha256Schema,
    processorVersion: z.string().min(1).max(128),
    range: AttachmentReadRangeSchema,
    items: z.array(AttachmentReadItemSchema).max(MAX_ATTACHMENT_READ_ITEMS),
    truncated: z.boolean(),
    nextRange: AttachmentReadRangeSchema.optional(),
    outputBytes: z.number().int().min(0).max(MAX_ATTACHMENT_READ_RESULT_BYTES),
  })
  .strict();
export type AttachmentReadResult = z.infer<typeof AttachmentReadResultSchema>;

export const MAX_ATTACHMENT_MODEL_CONTENT_REFERENCES = 8;

const AttachmentModelImageLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PDF_PAGE"), pageNumber: z.number().int().min(1) }).strict(),
  z.object({ kind: z.literal("DOCX_IMAGE"), imageIndex: z.number().int().min(0) }).strict(),
  z
    .object({
      kind: z.literal("XLSX_IMAGE"),
      sheetName: z.string().min(1).max(31),
      cellAddress: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]*$/u),
    })
    .strict(),
  z.object({ kind: z.literal("IMAGE") }).strict(),
]);

/** A durable, bounded reference to one image produced by reading an attachment range. */
export const AttachmentModelContentReferenceSchema = z
  .object({
    artifactId: AttachmentIdSchema,
    sha256: AttachmentSha256Schema,
    range: AttachmentReadRangeSchema,
    location: AttachmentModelImageLocationSchema,
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  })
  .strict()
  .superRefine((reference, context) => {
    const { range, location } = reference;
    const matches =
      (location.kind === "PDF_PAGE" &&
        range.kind === "PDF_PAGE" &&
        location.pageNumber === range.pageNumber) ||
      (location.kind === "IMAGE" && range.kind === "IMAGE") ||
      (location.kind === "DOCX_IMAGE" &&
        range.kind === "DOCX_BLOCKS" &&
        (range.imageIndex === undefined || range.imageIndex === location.imageIndex)) ||
      (location.kind === "XLSX_IMAGE" &&
        range.kind === "XLSX_RANGE" &&
        location.sheetName === range.sheetName);
    if (!matches) {
      context.addIssue({ code: "custom", message: "Image location must match its read range." });
    }
  });
export type AttachmentModelContentReference = z.infer<typeof AttachmentModelContentReferenceSchema>;
