import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AttachmentIdSchema } from "@caelush/protocol";
import { createDocumentProcessor } from "../../src/attachments/document-processor.js";

const processor = createDocumentProcessor();

async function fixture(name: string) {
  return new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));
}

function artifactId(value: string) {
  return AttachmentIdSchema.parse(`att_${value.padEnd(12, "0")}`);
}

describe("bounded conversation document processing", () => {
  it("extracts PDF text and renders a page image", async () => {
    const bytes = await fixture("text.pdf");
    const manifest = await processor.inspect({
      artifactId: artifactId("pdf"),
      bytes,
      name: "brief.pdf",
      detectedMediaType: "application/octet-stream",
    });

    expect(manifest).toMatchObject({
      kind: "PDF",
      mediaType: "application/pdf",
      pageCount: 1,
      pages: [{ pageNumber: 1, textAvailable: true }],
    });

    const result = await processor.read({
      bytes,
      manifest,
      range: { kind: "PDF_PAGE", pageNumber: 1 },
    });
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "TEXT",
          text: expect.stringContaining("Synthetic PDF fixture"),
        }),
        expect.objectContaining({
          type: "IMAGE",
          mediaType: "image/png",
          location: { kind: "PDF_PAGE", pageNumber: 1 },
        }),
      ]),
    );
  });

  it("marks scanned PDF pages as visually required and renders their first page", async () => {
    const bytes = await fixture("scanned.pdf");
    const manifest = await processor.inspect({
      artifactId: artifactId("scanned"),
      bytes,
      name: "scan.pdf",
      detectedMediaType: "application/pdf",
    });
    expect(manifest).toMatchObject({
      kind: "PDF",
      visualRequirement: "REQUIRED",
      pages: [{ textAvailable: false, visualContentAvailable: true }],
    });
    const result = await processor.read({
      bytes,
      manifest,
      range: { kind: "PDF_PAGE", pageNumber: 1 },
    });
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "IMAGE",
          location: { kind: "PDF_PAGE", pageNumber: 1 },
        }),
      ]),
    );
  }, 15_000);

  it("validates and scales an uploaded raster image for visual reading", async () => {
    const bytes = await fixture("pixel.png");
    const manifest = await processor.inspect({
      artifactId: artifactId("image"),
      bytes,
      name: "pixel.png",
      detectedMediaType: "application/octet-stream",
    });
    expect(manifest).toMatchObject({
      kind: "IMAGE",
      mediaType: "image/png",
      width: 1,
      height: 1,
      visualRequirement: "REQUIRED",
    });
    const result = await processor.read({ bytes, manifest, range: { kind: "IMAGE" } });
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "IMAGE", mediaType: "image/png", width: 1, height: 1 }),
      ]),
    );
  }, 15_000);

  it("extracts DOCX paragraphs, table cells and embedded images in order", async () => {
    const bytes = await fixture("synthetic.docx");
    const manifest = await processor.inspect({
      artifactId: artifactId("docx"),
      bytes,
      name: "brief.docx",
      detectedMediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(manifest).toMatchObject({
      kind: "DOCX",
      paragraphCount: 2,
      tableCount: 1,
      imageCount: 1,
    });
    const result = await processor.read({
      bytes,
      manifest,
      range: { kind: "DOCX_BLOCKS", startIndex: 0, blockCount: 10 },
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "TEXT", text: "Synthetic DOCX first paragraph" }),
        expect.objectContaining({ type: "TEXT", text: "Alpha" }),
        expect.objectContaining({ type: "TEXT", text: "Beta" }),
        expect.objectContaining({ type: "IMAGE", mediaType: "image/png" }),
      ]),
    );
  });

  it("extracts XLSX formula caches, hidden sheets and anchored images", async () => {
    const bytes = await fixture("synthetic.xlsx");
    const manifest = await processor.inspect({
      artifactId: artifactId("xlsx"),
      bytes,
      name: "report.xlsx",
      detectedMediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(manifest).toMatchObject({
      kind: "XLSX",
      sheets: [
        { name: "Summary", state: "VISIBLE", imageAnchors: ["C1"] },
        { name: "Archive", state: "HIDDEN" },
      ],
    });
    const result = await processor.read({
      bytes,
      manifest,
      range: { kind: "XLSX_RANGE", sheetName: "Summary", range: "A1:C3" },
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "CELL",
          location: { kind: "XLSX_CELL", sheetName: "Summary", address: "B1" },
          formula: "SUM(B2:B3)",
          value: 42,
        }),
        expect.objectContaining({
          type: "IMAGE",
          location: { kind: "XLSX_IMAGE", sheetName: "Summary", cellAddress: "C1" },
        }),
      ]),
    );
  });

  it("starts and continues a document without any format-specific field", async () => {
    const bytes = await fixture("many-lines.txt");
    const manifest = await processor.inspect({
      artifactId: artifactId("auto"),
      bytes,
      name: "many.txt",
      detectedMediaType: "text/plain",
    });

    const first = await processor.read({ bytes, manifest, range: { kind: "AUTO" } });
    expect(first.range).toEqual({ kind: "TEXT_LINES", startLine: 1, lineCount: 500 });
    expect(first.truncated).toBe(true);

    const next = first.nextRange;
    if (next?.kind !== "TEXT_LINES") throw new Error("Expected a text continuation range.");
    const second = await processor.read({
      bytes,
      manifest,
      range: { kind: "CONTINUE", cursor: JSON.stringify(next) },
    });
    expect(second.items[0]).toMatchObject({
      type: "TEXT",
      location: { kind: "TEXT_LINES", startLine: next.startLine },
    });
  }, 20_000);

  it("resolves a format-neutral first read from each manifest kind", async () => {
    const pdf = await fixture("text.pdf");
    const pdfManifest = await processor.inspect({
      artifactId: artifactId("autopdf"),
      bytes: pdf,
      name: "brief.pdf",
      detectedMediaType: "application/pdf",
    });
    await expect(
      processor.read({ bytes: pdf, manifest: pdfManifest, range: { kind: "AUTO" } }),
    ).resolves.toMatchObject({ range: { kind: "PDF_PAGE", pageNumber: 1 } });

    const docx = await fixture("synthetic.docx");
    const docxManifest = await processor.inspect({
      artifactId: artifactId("autodocx"),
      bytes: docx,
      name: "brief.docx",
      detectedMediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const docxAuto = await processor.read({
      bytes: docx,
      manifest: docxManifest,
      range: { kind: "AUTO" },
    });
    expect(docxAuto.range).toEqual({
      kind: "DOCX_BLOCKS",
      startIndex: 0,
      blockCount: Math.min(50, docxManifest.kind === "DOCX" ? docxManifest.blockCount : 0),
    });
  }, 20_000);

  it("rejects an AUTO range nested inside a continuation cursor", async () => {
    const bytes = await fixture("many-lines.txt");
    const manifest = await processor.inspect({
      artifactId: artifactId("cursor"),
      bytes,
      name: "many.txt",
      detectedMediaType: "text/plain",
    });

    await expect(
      processor.read({
        bytes,
        manifest,
        range: { kind: "CONTINUE", cursor: JSON.stringify({ kind: "AUTO" }) },
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  }, 20_000);

  it("rejects encrypted, corrupt and over-expanded documents with stable errors", async () => {
    await expect(
      processor.inspect({
        artifactId: artifactId("encrypted"),
        bytes: await fixture("encrypted.pdf"),
        name: "locked.pdf",
        detectedMediaType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    await expect(
      processor.inspect({
        artifactId: artifactId("corrupt"),
        bytes: await fixture("corrupt.pdf"),
        name: "broken.pdf",
        detectedMediaType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(
      processor.inspect({
        artifactId: artifactId("bomb"),
        bytes: await fixture("zip-bomb.docx"),
        name: "large.docx",
        detectedMediaType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
  });

  it("bounds text output and preserves the exact line continuation", async () => {
    const bytes = await fixture("many-lines.txt");
    const manifest = await processor.inspect({
      artifactId: artifactId("text"),
      bytes,
      name: "source.txt",
      detectedMediaType: "text/plain",
    });
    const result = await processor.read({
      bytes,
      manifest,
      range: { kind: "TEXT_LINES", startLine: 1, lineCount: 500 },
    });

    expect(result.truncated).toBe(true);
    expect(result.nextRange).toMatchObject({
      kind: "TEXT_LINES",
      startLine: expect.any(Number),
      startCharacter: expect.any(Number),
    });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(300_000);
    expect(result.outputBytes).toBe(Buffer.byteLength(JSON.stringify(result), "utf8"));
    expect(result.items[0]).toMatchObject({
      type: "TEXT",
      location: { kind: "TEXT_LINES", startLine: 1 },
    });
    const continuation = result.nextRange;
    if (continuation?.kind !== "TEXT_LINES") throw new Error("Expected a text continuation range.");
    const next = await processor.read({ bytes, manifest, range: continuation });
    const originalLines = Buffer.from(bytes)
      .toString("utf8")
      .split(/\r\n|\n|\r/u);
    const firstText = result.items.find((item) => item.type === "TEXT")?.text ?? "";
    const nextText = next.items.find((item) => item.type === "TEXT")?.text ?? "";
    expect(firstText + nextText).toBe(originalLines.slice(0, 500).join("\n"));
  }, 20_000);

  it("paginates search matches and rejects bytes that no longer match the manifest", async () => {
    const bytes = await fixture("many-lines.txt");
    const manifest = await processor.inspect({
      artifactId: artifactId("search"),
      bytes,
      name: "source.txt",
      detectedMediaType: "text/plain",
    });
    const firstPage = await processor.read({
      bytes,
      manifest,
      range: { kind: "SEARCH", query: "line", maxMatches: 2 },
    });
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.items.map((item) => (item.type === "TEXT" ? item.text : ""))).toEqual([
      expect.stringContaining("line 0001"),
      expect.stringContaining("line 0002"),
    ]);
    const continuation = firstPage.nextRange;
    if (continuation?.kind !== "SEARCH") throw new Error("Expected a search continuation range.");
    const secondPage = await processor.read({ bytes, manifest, range: continuation });
    expect(secondPage.items[0]).toMatchObject({
      type: "TEXT",
      text: expect.stringContaining("line 0003"),
    });

    const modifiedBytes = Uint8Array.from(bytes);
    modifiedBytes[0] = (modifiedBytes[0] ?? 0) ^ 1;
    await expect(
      processor.read({ bytes: modifiedBytes, manifest, range: { kind: "MANIFEST" } }),
    ).rejects.toMatchObject({ code: "CONTENT_HASH_MISMATCH" });
  }, 20_000);
});
