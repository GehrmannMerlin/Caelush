import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import {
  createCanvas,
  DOMMatrix,
  ImageData,
  Path2D,
  loadImage,
  type Canvas,
} from "@napi-rs/canvas";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as yauzl from "yauzl";
import {
  AttachmentProcessingManifestSchema,
  AttachmentReadRangeSchema,
  AttachmentReadResultSchema,
  MAX_ATTACHMENT_READ_ITEMS,
  MAX_ATTACHMENT_READ_RESULT_BYTES,
  MAX_ATTACHMENT_TEXT_LINES,
  type AttachmentProcessingManifest,
  type AttachmentReadItem,
  type AttachmentReadRange,
  type AttachmentReadResult,
} from "@caelush/protocol";

type ErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "INVALID_DOCUMENT"
  | "PASSWORD_REQUIRED"
  | "RESOURCE_LIMIT"
  | "CONTENT_HASH_MISMATCH"
  | "PROCESSOR_FAILED";

interface WorkerCommand {
  readonly operation: "INSPECT" | "READ";
  readonly artifactId?: string;
  readonly bytes: Uint8Array;
  readonly name?: string;
  readonly detectedMediaType?: string;
  readonly manifest?: AttachmentProcessingManifest;
  readonly range?: AttachmentReadRange;
  readonly limits?: ProcessorLimits;
}

interface ProcessorLimits {
  readonly maxInputBytes: number;
  readonly maxArchiveEntries: number;
  readonly maxArchiveEntryBytes: number;
  readonly maxArchiveUncompressedBytes: number;
  readonly maxDocumentPages: number;
  readonly maxDocumentBlocks: number;
  readonly maxWorksheets: number;
  readonly maxXlsxCells: number;
  readonly maxImagePixels: number;
  readonly maxRenderPixels: number;
  readonly maxRenderDimension: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly heapMb: number;
}

interface WorkerReply {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly code?: ErrorCode;
}

class ProcessingFailure extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

interface TextDocument {
  readonly text: string;
  readonly lines: readonly string[];
  readonly encoding: "UTF-8" | "UTF-16LE" | "UTF-16BE" | "WINDOWS-1252";
}

interface ImageInfo {
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
}

interface ProcessedImage {
  readonly data: string;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
}

interface Archive {
  readonly entries: ReadonlyMap<string, Buffer>;
}

interface DocxBlock {
  readonly kind: "PARAGRAPH" | "TABLE" | "IMAGE";
  readonly text?: string;
  readonly rows?: readonly (readonly string[])[];
  readonly imageIndices: readonly number[];
}

interface DocxDocument {
  readonly blocks: readonly DocxBlock[];
  readonly images: readonly Buffer[];
}

const command = workerData as WorkerCommand;
const parent = parentPort;
const pdfDestroyers = new WeakMap<pdfjs.PDFDocumentProxy, () => Promise<void>>();
const limits: ProcessorLimits = command.limits ?? {
  maxInputBytes: 25 * 1024 * 1024,
  maxArchiveEntries: 5_000,
  maxArchiveEntryBytes: 32 * 1024 * 1024,
  maxArchiveUncompressedBytes: 64 * 1024 * 1024,
  maxDocumentPages: 250,
  maxDocumentBlocks: 5_000,
  maxWorksheets: 128,
  maxXlsxCells: 100_000,
  maxImagePixels: 12_000_000,
  maxRenderPixels: 4_000_000,
  maxRenderDimension: 8_192,
  maxOutputBytes: 256 * 1024,
  timeoutMs: 20_000,
  heapMb: 256,
};
const ATTACHMENT_PROCESSOR_VERSION = "attachments-v1";
const MAX_ARCHIVE_ENTRIES = limits.maxArchiveEntries;
const MAX_ARCHIVE_ENTRY_BYTES = limits.maxArchiveEntryBytes;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = limits.maxArchiveUncompressedBytes;
const MAX_DOCUMENT_BLOCKS = limits.maxDocumentBlocks;
const MAX_DOCUMENT_OUTPUT_BYTES = limits.maxOutputBytes;
const MAX_DOCUMENT_PAGES = limits.maxDocumentPages;
const MAX_IMAGE_PIXELS = limits.maxImagePixels;
const MAX_RENDER_DIMENSION = limits.maxRenderDimension;
const MAX_RENDER_PIXELS = limits.maxRenderPixels;
const MAX_WORKSHEETS = limits.maxWorksheets;
const MAX_XLSX_CELLS = limits.maxXlsxCells;
const MAX_OFFICE_IMAGES_PER_READ = 2;
const MAX_DOCX_TABLE_CELLS = 100_000;
const MAX_PDF_TEXT_ITEMS_PER_PAGE = 100_000;
const MAX_PDF_OPERATORS_PER_PAGE = 500_000;

if (parent === null) throw new Error("Worker message port is unavailable.");

void execute(command)
  .then((value) => parent.postMessage({ ok: true, value } satisfies WorkerReply))
  .catch((error: unknown) => {
    const code = error instanceof ProcessingFailure ? error.code : "INVALID_DOCUMENT";
    parent.postMessage({ ok: false, code } satisfies WorkerReply);
  });

async function execute(input: WorkerCommand): Promise<unknown> {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    fail("INVALID_DOCUMENT");
  }
  if (input.bytes.byteLength > limits.maxInputBytes) fail("RESOURCE_LIMIT");
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);

  if (input.operation === "INSPECT") {
    if (typeof input.artifactId !== "string" || typeof input.name !== "string") {
      fail("INVALID_DOCUMENT");
    }
    return inspectAttachment(input.artifactId, bytes, input.name, input.detectedMediaType ?? "");
  }
  if (input.manifest === undefined || input.range === undefined) fail("INVALID_DOCUMENT");
  return readAttachment(bytes, input.manifest, input.range);
}

function fail(code: ErrorCode): never {
  throw new ProcessingFailure(code);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionOf(name: string): string {
  const basename = name.toLowerCase();
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "makefile";
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

type Kind = "TEXT" | "IMAGE" | "PDF" | "DOCX" | "XLSX";

function classify(name: string, bytes: Buffer, detectedMediaType: string): Kind {
  const extension = extensionOf(name);
  const normalizedType = detectedMediaType.toLowerCase().split(";", 1)[0] ?? "";
  const signature = bytes.subarray(0, 12);

  if (["doc", "xls", "docm", "xlsm", "ppt", "pptx", "pptm"].includes(extension)) {
    fail("UNSUPPORTED_FORMAT");
  }
  if (extension === "pdf") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) fail("INVALID_DOCUMENT");
    if (
      normalizedType &&
      normalizedType !== "application/pdf" &&
      normalizedType !== "application/octet-stream"
    ) {
      fail("UNSUPPORTED_FORMAT");
    }
    return "PDF";
  }
  if (extension === "docx") {
    if (!isZip(signature)) fail("INVALID_DOCUMENT");
    if (
      normalizedType &&
      normalizedType !==
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
      normalizedType !== "application/octet-stream"
    ) {
      fail("UNSUPPORTED_FORMAT");
    }
    return "DOCX";
  }
  if (extension === "xlsx") {
    if (!isZip(signature)) fail("INVALID_DOCUMENT");
    if (
      normalizedType &&
      normalizedType !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" &&
      normalizedType !== "application/octet-stream"
    ) {
      fail("UNSUPPORTED_FORMAT");
    }
    return "XLSX";
  }

  const image = sniffImage(bytes);
  if (image !== null) {
    const expectedExtension: Record<ImageInfo["mimeType"], readonly string[]> = {
      "image/png": ["png"],
      "image/jpeg": ["jpg", "jpeg"],
      "image/gif": ["gif"],
      "image/webp": ["webp"],
    };
    if (!expectedExtension[image.mimeType].includes(extension)) fail("UNSUPPORTED_FORMAT");
    if (
      normalizedType &&
      normalizedType !== image.mimeType &&
      normalizedType !== "application/octet-stream"
    ) {
      fail("UNSUPPORTED_FORMAT");
    }
    return "IMAGE";
  }
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) fail("INVALID_DOCUMENT");

  const textExtensions = new Set([
    "txt",
    "md",
    "markdown",
    "rst",
    "log",
    "csv",
    "tsv",
    "json",
    "jsonl",
    "xml",
    "svg",
    "yaml",
    "yml",
    "toml",
    "ini",
    "conf",
    "config",
    "env",
    "html",
    "htm",
    "css",
    "scss",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "mts",
    "cts",
    "py",
    "pyi",
    "go",
    "rs",
    "java",
    "kt",
    "kts",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "fs",
    "fsx",
    "php",
    "rb",
    "rake",
    "swift",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "sql",
    "graphql",
    "gql",
    "proto",
    "dockerfile",
    "makefile",
    "gradle",
    "properties",
    "bat",
    "cmd",
    "vue",
    "svelte",
    "astro",
    "lock",
  ]);
  const textMimes = new Set([
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/tab-separated-values",
    "text/xml",
    "text/html",
    "text/css",
    "text/javascript",
    "application/json",
    "application/xml",
    "application/javascript",
    "image/svg+xml",
    "application/x-yaml",
    "application/toml",
    "application/octet-stream",
  ]);
  if (!textExtensions.has(extension)) fail("UNSUPPORTED_FORMAT");
  if (normalizedType && !textMimes.has(normalizedType) && !normalizedType.startsWith("text/")) {
    fail("UNSUPPORTED_FORMAT");
  }
  return "TEXT";
}

function isZip(signature: Buffer): boolean {
  return (
    signature.length >= 4 &&
    signature[0] === 0x50 &&
    signature[1] === 0x4b &&
    (signature[2] === 0x03 || signature[2] === 0x05 || signature[2] === 0x07)
  );
}

function inspectText(bytes: Buffer): TextDocument {
  let text: string;
  let encoding: TextDocument["encoding"];
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
      encoding = "UTF-16LE";
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      text = new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
      encoding = "UTF-16BE";
    } else {
      const content =
        bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
          ? bytes.subarray(3)
          : bytes;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        encoding = "UTF-8";
      } catch {
        text = new TextDecoder("windows-1252", { fatal: true }).decode(content);
        encoding = "WINDOWS-1252";
      }
    }
  } catch {
    fail("INVALID_DOCUMENT");
  }
  if (text.includes("\u0000")) fail("INVALID_DOCUMENT");
  let controls = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (
      (point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d && point !== 0x0c) ||
      point === 0x7f
    ) {
      controls += 1;
    }
  }
  if (text.length > 0 && controls / text.length > 0.01) fail("INVALID_DOCUMENT");
  let lineCount = 1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0d) {
      lineCount += 1;
      if (text.charCodeAt(index + 1) === 0x0a) index += 1;
    } else if (code === 0x0a) {
      lineCount += 1;
    }
    if (lineCount > MAX_ATTACHMENT_TEXT_LINES) fail("RESOURCE_LIMIT");
  }
  const lines = text.split(/\r\n|\n|\r/u);
  return { text, lines, encoding };
}

function inspectImageDimensions(bytes: Buffer): ImageInfo {
  const image = sniffImage(bytes);
  if (image === null) fail("INVALID_DOCUMENT");
  if (
    image.frameCount > 10_000 ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > MAX_IMAGE_PIXELS
  ) {
    fail("RESOURCE_LIMIT");
  }
  return image;
}

function sniffImage(bytes: Buffer): ImageInfo | null {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    let frameCount = 1;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL" && length >= 8) frameCount = Math.max(bytes.readUInt32BE(offset + 8), 1);
      offset += 12 + length;
    }
    return {
      mimeType: "image/png",
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      frameCount,
    };
  }
  if (
    bytes.length >= 10 &&
    (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
      bytes.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    let frameCount = 0;
    let offset = 13;
    const packed = bytes[10] ?? 0;
    if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1);
    while (offset < bytes.length) {
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0x3b) break;
      if (marker === 0x2c) {
        if (offset + 9 > bytes.length) break;
        frameCount += 1;
        const descriptorFlags = bytes[offset + 8] ?? 0;
        offset += 9;
        if ((descriptorFlags & 0x80) !== 0) offset += 3 * 2 ** ((descriptorFlags & 0x07) + 1);
        offset += 1;
      } else if (marker === 0x21) {
        offset += 1;
      } else {
        break;
      }
      while (offset < bytes.length) {
        const size = bytes[offset] ?? 0;
        offset += 1;
        if (size === 0) break;
        offset += size;
      }
    }
    return {
      mimeType: "image/gif",
      width: bytes.readUInt16LE(6),
      height: bytes.readUInt16LE(8),
      frameCount: Math.max(frameCount, 1),
    };
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    let width = 0;
    let height = 0;
    let frameCount = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = bytes.toString("ascii", offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      const data = offset + 8;
      if (type === "VP8X" && size >= 10) {
        width = 1 + bytes.readUIntLE(data + 4, 3);
        height = 1 + bytes.readUIntLE(data + 7, 3);
      } else if (type === "VP8 " && size >= 10 && width === 0) {
        width = bytes.readUInt16LE(data + 6) & 0x3fff;
        height = bytes.readUInt16LE(data + 8) & 0x3fff;
      } else if (type === "VP8L" && size >= 5 && width === 0) {
        const bits = bytes.readUInt32LE(data + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      } else if (type === "ANMF") {
        frameCount += 1;
      }
      offset = data + size + (size % 2);
    }
    return { mimeType: "image/webp", width, height, frameCount: Math.max(frameCount, 1) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      const segmentLength = bytes.readUInt16BE(offset + 2);
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        return {
          mimeType: "image/jpeg",
          width: bytes.readUInt16BE(offset + 7),
          height: bytes.readUInt16BE(offset + 5),
          frameCount: 1,
        };
      }
      if (segmentLength < 2) break;
      offset += 2 + segmentLength;
    }
    return null;
  }
  return null;
}

async function decodeImage(bytes: Buffer): Promise<ProcessedImage> {
  inspectImageDimensions(bytes);
  const image = await loadImage(bytes);
  if (image.width < 1 || image.height < 1 || image.width * image.height > MAX_IMAGE_PIXELS) {
    fail("RESOURCE_LIMIT");
  }
  const scale = Math.min(
    1,
    MAX_RENDER_DIMENSION / image.width,
    MAX_RENDER_DIMENSION / image.height,
    Math.sqrt(MAX_RENDER_PIXELS / (image.width * image.height)),
  );
  const width = Math.max(1, Math.floor(image.width * scale));
  const height = Math.max(1, Math.floor(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  return encodeCanvasImage(canvas);
}

function encodeCanvasImage(source: Canvas): ProcessedImage {
  let canvas = source;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const png = canvas.toBuffer("image/png");
    if (png.byteLength <= 96 * 1024) {
      return {
        data: png.toString("base64"),
        mediaType: "image/png",
        width: canvas.width,
        height: canvas.height,
      };
    }
    const jpegCanvas = createCanvas(canvas.width, canvas.height);
    const jpegContext = jpegCanvas.getContext("2d");
    jpegContext.fillStyle = "#fff";
    jpegContext.fillRect(0, 0, canvas.width, canvas.height);
    jpegContext.drawImage(canvas, 0, 0);
    for (const quality of [78, 65, 52, 40, 28]) {
      const jpeg = jpegCanvas.toBuffer("image/jpeg", quality);
      if (jpeg.byteLength <= 128 * 1024) {
        return {
          data: jpeg.toString("base64"),
          mediaType: "image/jpeg",
          width: canvas.width,
          height: canvas.height,
        };
      }
    }
    if (canvas.width <= 256 && canvas.height <= 256) break;
    const nextWidth = Math.max(1, Math.floor(canvas.width * 0.75));
    const nextHeight = Math.max(1, Math.floor(canvas.height * 0.75));
    const resized = createCanvas(nextWidth, nextHeight);
    resized.getContext("2d").drawImage(canvas, 0, 0, nextWidth, nextHeight);
    canvas = resized;
  }
  fail("RESOURCE_LIMIT");
}

async function inspectAttachment(
  artifactId: string,
  bytes: Buffer,
  name: string,
  detectedMediaType: string,
): Promise<AttachmentProcessingManifest> {
  const kind = classify(name, bytes, detectedMediaType);
  const common = {
    artifactId,
    sha256: sha256(bytes),
    mediaType: canonicalMediaType(kind, bytes, detectedMediaType),
    processorVersion: ATTACHMENT_PROCESSOR_VERSION,
  };

  if (kind === "TEXT") {
    const document = inspectText(bytes);
    return AttachmentProcessingManifestSchema.parse({
      ...common,
      kind,
      encoding: document.encoding,
      lineCount: document.lines.length,
      characterCount: document.text.length,
      visualRequirement: "NOT_REQUIRED",
    });
  }
  if (kind === "IMAGE") {
    const info = inspectImageDimensions(bytes);
    await decodeImage(bytes);
    return AttachmentProcessingManifestSchema.parse({
      ...common,
      kind,
      width: info.width,
      height: info.height,
      frameCount: info.frameCount,
      animated: info.frameCount > 1,
      visualRequirement: "REQUIRED",
    });
  }
  if (kind === "PDF") return inspectPdf(artifactId, bytes, common);
  if (kind === "DOCX") return inspectDocx(artifactId, bytes, common);
  return inspectXlsx(artifactId, bytes, common);
}

function canonicalMediaType(kind: Kind, bytes: Buffer, detectedMediaType: string): string {
  if (kind === "PDF") return "application/pdf";
  if (kind === "DOCX") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (kind === "XLSX") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (kind === "IMAGE") {
    const image = sniffImage(bytes);
    if (image === null) fail("INVALID_DOCUMENT");
    return image.mimeType;
  }
  const mediaType = detectedMediaType.toLowerCase().split(";", 1)[0] ?? "";
  return mediaType.length > 0 && mediaType !== "application/octet-stream"
    ? mediaType
    : "text/plain";
}

function setCanvasGlobals(): void {
  const globals = globalThis as typeof globalThis & {
    DOMMatrix?: typeof DOMMatrix;
    ImageData?: typeof ImageData;
    Path2D?: typeof Path2D;
  };
  globals.DOMMatrix ??= DOMMatrix;
  globals.ImageData ??= ImageData;
  globals.Path2D ??= Path2D;
}

async function openPdf(bytes: Buffer): Promise<pdfjs.PDFDocumentProxy> {
  setCanvasGlobals();
  try {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: true,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    const document = await loadingTask.promise;
    if (document.numPages < 1 || document.numPages > MAX_DOCUMENT_PAGES) {
      await loadingTask.destroy();
      fail("RESOURCE_LIMIT");
    }
    pdfDestroyers.set(document, () => loadingTask.destroy());
    return document;
  } catch (error) {
    if (error instanceof ProcessingFailure) throw error;
    if (error instanceof Error && error.name === "PasswordException") fail("PASSWORD_REQUIRED");
    fail("INVALID_DOCUMENT");
  }
}

async function destroyPdf(document: pdfjs.PDFDocumentProxy): Promise<void> {
  await pdfDestroyers.get(document)?.();
}

async function inspectPdf(
  artifactId: string,
  bytes: Buffer,
  common: Record<string, unknown>,
): Promise<AttachmentProcessingManifest> {
  const document = await openPdf(bytes);
  try {
    const pages = [];
    let anyVisual = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const text = await page.getTextContent();
      const textAvailable = hasPdfText(text.items);
      const operators = await page.getOperatorList();
      if (operators.fnArray.length > MAX_PDF_OPERATORS_PER_PAGE) fail("RESOURCE_LIMIT");
      const imageOps = new Set<number>([
        pdfjs.OPS.paintImageXObject,
        pdfjs.OPS.paintInlineImageXObject,
        pdfjs.OPS.paintImageMaskXObject,
        pdfjs.OPS.paintSolidColorImageMask,
        pdfjs.OPS.constructPath,
        pdfjs.OPS.fill,
        pdfjs.OPS.eoFill,
        pdfjs.OPS.stroke,
        pdfjs.OPS.closeStroke,
        pdfjs.OPS.fillStroke,
        pdfjs.OPS.eoFillStroke,
        pdfjs.OPS.shadingFill,
      ]);
      const visualContentAvailable = operators.fnArray.some((operator) => imageOps.has(operator));
      anyVisual ||= visualContentAvailable;
      pages.push({
        pageNumber,
        textAvailable,
        visualContentAvailable,
        width: viewport.width,
        height: viewport.height,
      });
      page.cleanup();
    }
    return AttachmentProcessingManifestSchema.parse({
      ...common,
      artifactId,
      kind: "PDF",
      pageCount: document.numPages,
      pages,
      visualRequirement: pages.some((page) => !page.textAvailable && page.visualContentAvailable)
        ? "REQUIRED"
        : anyVisual
          ? "POSSIBLE"
          : "NOT_REQUIRED",
    });
  } finally {
    await destroyPdf(document);
  }
}

function readPdfText(items: readonly unknown[]): string {
  if (items.length > MAX_PDF_TEXT_ITEMS_PER_PAGE) fail("RESOURCE_LIMIT");
  let text = "";
  let textLength = 0;
  for (const item of items) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("str" in item) ||
      typeof item.str !== "string"
    )
      continue;
    const separator = "hasEOL" in item && item.hasEOL === true ? "\n" : " ";
    textLength += item.str.length + separator.length;
    if (textLength > MAX_ARCHIVE_UNCOMPRESSED_BYTES) fail("RESOURCE_LIMIT");
    text += item.str + separator;
  }
  return text.trimEnd();
}

function hasPdfText(items: readonly unknown[]): boolean {
  if (items.length > MAX_PDF_TEXT_ITEMS_PER_PAGE) fail("RESOURCE_LIMIT");
  let textLength = 0;
  let available = false;
  for (const item of items) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("str" in item) ||
      typeof item.str !== "string"
    ) {
      continue;
    }
    textLength += item.str.length;
    if (textLength > MAX_ARCHIVE_UNCOMPRESSED_BYTES) fail("RESOURCE_LIMIT");
    available ||= item.str.trim().length > 0;
  }
  return available;
}

async function renderPdfPage(page: pdfjs.PDFPageProxy): Promise<ProcessedImage> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(
    1,
    MAX_RENDER_DIMENSION / base.width,
    MAX_RENDER_DIMENSION / base.height,
    Math.sqrt(MAX_RENDER_PIXELS / (base.width * base.height)),
  );
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas: Canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
  return encodeCanvasImage(canvas);
}

async function inspectArchive(bytes: Buffer): Promise<Archive> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromBufferPromise(bytes, {
      lazyEntries: true,
      validateEntrySizes: true,
      decodeStrings: true,
      autoClose: true,
      strictFileNames: true,
    });
  } catch {
    fail("INVALID_DOCUMENT");
  }
  const entries = new Map<string, Buffer>();
  const seenNames = new Set<string>();
  let count = 0;
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      zip.close();
      if (error) reject(error);
      else resolve();
    };
    zip.on("error", () => finish(new ProcessingFailure("INVALID_DOCUMENT")));
    zip.on("end", () => finish());
    zip.on("entry", (entry) => {
      count += 1;
      if (count > MAX_ARCHIVE_ENTRIES) return finish(new ProcessingFailure("RESOURCE_LIMIT"));
      if ((entry.generalPurposeBitFlag & 1) !== 0)
        return finish(new ProcessingFailure("PASSWORD_REQUIRED"));
      if (
        entry.uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES ||
        totalBytes + entry.uncompressedSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES
      ) {
        return finish(new ProcessingFailure("RESOURCE_LIMIT"));
      }
      const lowerName = entry.fileName.toLowerCase();
      if (lowerName.endsWith("vbaproject.bin")) {
        return finish(new ProcessingFailure("UNSUPPORTED_FORMAT"));
      }
      if (entry.fileName.endsWith("/")) {
        zip.readEntry();
        return;
      }
      if (seenNames.has(entry.fileName)) return finish(new ProcessingFailure("INVALID_DOCUMENT"));
      seenNames.add(entry.fileName);
      const keepContent =
        entry.fileName === "[Content_Types].xml" ||
        entry.fileName === "word/document.xml" ||
        entry.fileName === "xl/workbook.xml" ||
        /^xl\/worksheets\/sheet\d+\.xml$/iu.test(entry.fileName);
      zip.openReadStream(entry, (error, stream) => {
        if (error || stream === undefined) return finish(new ProcessingFailure("INVALID_DOCUMENT"));
        const chunks: Buffer[] = [];
        let entryBytes = 0;
        stream.on("data", (chunk: Buffer) => {
          entryBytes += chunk.byteLength;
          totalBytes += chunk.byteLength;
          if (entryBytes > MAX_ARCHIVE_ENTRY_BYTES || totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
            stream.destroy(new ProcessingFailure("RESOURCE_LIMIT"));
            return;
          }
          if (keepContent) chunks.push(chunk);
        });
        stream.on("error", (streamError: unknown) => {
          finish(
            streamError instanceof ProcessingFailure
              ? streamError
              : new ProcessingFailure("INVALID_DOCUMENT"),
          );
        });
        stream.on("end", () => {
          if (entryBytes !== entry.uncompressedSize)
            return finish(new ProcessingFailure("INVALID_DOCUMENT"));
          if (keepContent) entries.set(entry.fileName, Buffer.concat(chunks, entryBytes));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  }).catch((error: unknown) => {
    if (error instanceof ProcessingFailure) throw error;
    fail("INVALID_DOCUMENT");
  });
  return { entries };
}

async function inspectDocx(
  artifactId: string,
  bytes: Buffer,
  common: Record<string, unknown>,
): Promise<AttachmentProcessingManifest> {
  const archive = await inspectArchive(bytes);
  if (!archive.entries.has("[Content_Types].xml") || !archive.entries.has("word/document.xml"))
    fail("INVALID_DOCUMENT");
  const document = await parseDocx(bytes);
  if (document.blocks.length > MAX_DOCUMENT_BLOCKS || document.images.length > 256)
    fail("RESOURCE_LIMIT");
  const paragraphCount = document.blocks.filter((block) => block.kind === "PARAGRAPH").length;
  const tableCount = document.blocks.filter((block) => block.kind === "TABLE").length;
  const blocks = document.blocks.map((block, index) => ({
    index,
    kind: block.kind,
    ...(block.text !== undefined ? { textLength: block.text.length } : {}),
    ...(block.rows !== undefined
      ? {
          rowCount: block.rows.length,
          columnCount: block.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0),
        }
      : {}),
    ...(block.imageIndices.length > 0 ? { imageIndices: [...block.imageIndices] } : {}),
  }));
  return AttachmentProcessingManifestSchema.parse({
    ...common,
    artifactId,
    kind: "DOCX",
    blockCount: document.blocks.length,
    paragraphCount,
    tableCount,
    imageCount: document.images.length,
    blocks,
    visualRequirement: document.images.length > 0 ? "POSSIBLE" : "NOT_REQUIRED",
  });
}

async function parseDocx(bytes: Buffer): Promise<DocxDocument> {
  const images: Buffer[] = [];
  let converted;
  try {
    converted = await mammoth.convertToHtml(
      { buffer: bytes },
      {
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async (image) => {
          if (images.length >= 256) fail("RESOURCE_LIMIT");
          const content = await image.read();
          const safeContent = Buffer.from(content);
          inspectImageDimensions(safeContent);
          const index = images.push(safeContent) - 1;
          return { src: `attimg://${index}` };
        }),
      },
    );
  } catch (error) {
    if (error instanceof ProcessingFailure) throw error;
    fail("INVALID_DOCUMENT");
  }
  if (Buffer.byteLength(converted.value, "utf8") > MAX_ARCHIVE_UNCOMPRESSED_BYTES)
    fail("RESOURCE_LIMIT");
  const blocks: DocxBlock[] = [];
  let tableCellCount = 0;
  const blockPattern = /<(table|p|h[1-6])\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
  for (const match of converted.value.matchAll(blockPattern)) {
    const html = match[0];
    if (html === undefined) continue;
    const imageIndices = [...html.matchAll(/src\s*=\s*["']attimg:\/\/(\d+)["']/giu)]
      .map((imageMatch) => Number(imageMatch[1]))
      .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < images.length);
    if (/^<table\b/iu.test(html)) {
      const rows: string[][] = [];
      for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/giu)) {
        if (rows.length >= 100_000) fail("RESOURCE_LIMIT");
        const rowHtml = rowMatch[1] ?? "";
        const row: string[] = [];
        for (const cellMatch of rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/giu)) {
          tableCellCount += 1;
          if (tableCellCount > MAX_DOCX_TABLE_CELLS) fail("RESOURCE_LIMIT");
          row.push(htmlToText(cellMatch[1] ?? ""));
        }
        rows.push(row);
      }
      blocks.push({ kind: "TABLE", rows, imageIndices });
    } else {
      blocks.push({ kind: "PARAGRAPH", text: htmlToText(html), imageIndices });
    }
    if (blocks.length > MAX_DOCUMENT_BLOCKS) fail("RESOURCE_LIMIT");
  }
  const referencedImages = new Set(blocks.flatMap((block) => block.imageIndices));
  for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
    if (referencedImages.has(imageIndex)) continue;
    blocks.push({ kind: "IMAGE", imageIndices: [imageIndex] });
  }
  return { blocks, images };
}

function htmlToText(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (entity, value: string) => {
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
      };
      if (value.startsWith("#x")) return String.fromCodePoint(Number.parseInt(value.slice(2), 16));
      if (value.startsWith("#")) return String.fromCodePoint(Number.parseInt(value.slice(1), 10));
      return named[value.toLowerCase()] ?? entity;
    });
  return text.replace(/\s+/gu, " ").trim();
}

async function loadWorkbook(bytes: Buffer): Promise<ExcelJS.Workbook> {
  const archive = await inspectArchive(bytes);
  if (!archive.entries.has("[Content_Types].xml") || !archive.entries.has("xl/workbook.xml"))
    fail("INVALID_DOCUMENT");
  for (const [name, content] of archive.entries) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/iu.test(name)) continue;
    const xml = content.toString("utf8");
    const cells = [...xml.matchAll(/<c\b/giu)].length;
    if (cells > MAX_XLSX_CELLS) fail("RESOURCE_LIMIT");
    for (const ref of xml.matchAll(/\br="([A-Z]{1,3})(\d+)"/giu)) {
      const row = Number(ref[2]);
      if (row > MAX_XLSX_CELLS || columnNumber(ref[1] ?? "") > 16_384) fail("RESOURCE_LIMIT");
    }
  }
  const workbook = new ExcelJS.Workbook();
  try {
    const workbookBytes = Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(workbookBytes, { ignoreNodes: ["extLst"] });
  } catch {
    fail("INVALID_DOCUMENT");
  }
  if (workbook.worksheets.length < 1 || workbook.worksheets.length > MAX_WORKSHEETS)
    fail("RESOURCE_LIMIT");
  let cellCount = 0;
  for (const worksheet of workbook.worksheets) {
    if (worksheet.rowCount > MAX_XLSX_CELLS || worksheet.columnCount > 16_384)
      fail("RESOURCE_LIMIT");
    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        cellCount += 1;
        if (cellCount > MAX_XLSX_CELLS) fail("RESOURCE_LIMIT");
      });
    });
  }
  return workbook;
}

async function inspectXlsx(
  artifactId: string,
  bytes: Buffer,
  common: Record<string, unknown>,
): Promise<AttachmentProcessingManifest> {
  const workbook = await loadWorkbook(bytes);
  let imageCount = 0;
  const sheets = workbook.worksheets.map((worksheet) => {
    const imageAnchors: string[] = [];
    for (const image of worksheet.getImages()) {
      imageCount += 1;
      if (imageCount > 256) fail("RESOURCE_LIMIT");
      if (image.range.tl.row + 1 > MAX_XLSX_CELLS || image.range.tl.col + 1 > 16_384)
        fail("RESOURCE_LIMIT");
      imageAnchors.push(cellAddress(image.range.tl.nativeRow + 1, image.range.tl.nativeCol + 1));
    }
    const state =
      worksheet.state === "veryHidden"
        ? "VERY_HIDDEN"
        : worksheet.state === "hidden"
          ? "HIDDEN"
          : "VISIBLE";
    return {
      name: worksheet.name,
      state,
      rowCount: worksheet.rowCount,
      columnCount: worksheet.columnCount,
      imageAnchors,
    };
  });
  return AttachmentProcessingManifestSchema.parse({
    ...common,
    artifactId,
    kind: "XLSX",
    sheets,
    visualRequirement: imageCount > 0 ? "POSSIBLE" : "NOT_REQUIRED",
  });
}

function columnNumber(letters: string): number {
  return [...letters].reduce((number, character) => number * 26 + character.charCodeAt(0) - 64, 0);
}

function columnLetters(number: number): string {
  let value = number;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function cellAddress(row: number, column: number): string {
  return `${columnLetters(column)}${row}`;
}

function parseCell(address: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(address.replaceAll("$", ""));
  if (match === null) fail("INVALID_DOCUMENT");
  return { row: Number(match[2]), column: columnNumber(match[1] ?? "") };
}

function parseCellRange(range: string): {
  start: { row: number; column: number };
  end: { row: number; column: number };
} {
  const [startText, rawEndText] = range.split(":");
  if (startText === undefined) fail("INVALID_DOCUMENT");
  const endText = rawEndText ?? startText;
  const start = parseCell(startText);
  const end = parseCell(endText);
  if (end.row < start.row || end.column < start.column) fail("INVALID_DOCUMENT");
  return { start, end };
}

function isInCellRange(
  cell: { row: number; column: number },
  range: { start: { row: number; column: number }; end: { row: number; column: number } },
): boolean {
  return (
    cell.row >= range.start.row &&
    cell.row <= range.end.row &&
    cell.column >= range.start.column &&
    cell.column <= range.end.column
  );
}

function simpleCellValue(
  value: ExcelJS.CellValue | undefined,
): string | number | boolean | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "text" in value && typeof value.text === "string")
    return value.text;
  if (typeof value === "object" && "richText" in value && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text).join("");
  }
  if (typeof value === "object" && "result" in value) {
    return simpleCellValue(value.result as ExcelJS.CellValue | undefined) ?? null;
  }
  return String(value);
}

function formulaText(value: ExcelJS.CellValue | undefined): string | undefined {
  if (typeof value !== "object" || value === null || !("formula" in value)) return undefined;
  const formula = value.formula;
  return typeof formula === "string" ? formula : undefined;
}

function mediaTypeForOfficeImage(
  extension: string,
): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  const typeByExtension: Record<string, ImageInfo["mimeType"]> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  const type = typeByExtension[extension.toLowerCase()];
  if (type === undefined) fail("UNSUPPORTED_FORMAT");
  return type;
}

function assertImageBuffer(bytes: Buffer, expected: ImageInfo["mimeType"]): void {
  const image = inspectImageDimensions(bytes);
  if (image.mimeType !== expected) fail("INVALID_DOCUMENT");
}

function textCandidatesForLineRange(
  document: TextDocument,
  range: Extract<AttachmentReadRange, { kind: "TEXT_LINES" }>,
): { items: AttachmentReadItem[]; continuation?: AttachmentReadRange } {
  const startLineIndex = range.startLine - 1;
  if (startLineIndex >= document.lines.length) return { items: [] };
  const offset = range.startCharacter ?? 0;
  if (offset > (document.lines[startLineIndex]?.length ?? 0)) fail("INVALID_DOCUMENT");
  const targetEnd = Math.min(document.lines.length, startLineIndex + range.lineCount);
  const maxTextBytes = Math.min(96 * 1024, MAX_DOCUMENT_OUTPUT_BYTES - 2048);
  let text = "";
  let textBytes = 0;
  let endLine = range.startLine;
  let next: AttachmentReadRange | undefined;
  for (let lineIndex = startLineIndex; lineIndex < targetEnd; lineIndex += 1) {
    const line = document.lines[lineIndex] ?? "";
    const startOffset = lineIndex === startLineIndex ? offset : 0;
    let usedCodeUnits = 0;
    let piece = "";
    let pieceBytes = 0;
    for (const character of line.slice(startOffset)) {
      const bytes = Buffer.byteLength(character, "utf8");
      if (textBytes + pieceBytes + bytes > maxTextBytes) {
        if (piece.length > 0) {
          text += piece;
          textBytes += pieceBytes;
        }
        const consumed = startOffset + usedCodeUnits;
        next = {
          kind: "TEXT_LINES",
          startLine: lineIndex + 1,
          lineCount: targetEnd - lineIndex,
          startCharacter: consumed,
        };
        break;
      }
      piece += character;
      pieceBytes += bytes;
      usedCodeUnits += character.length;
    }
    if (next !== undefined) {
      endLine = lineIndex + 1;
      break;
    }
    text += piece;
    textBytes += pieceBytes;
    endLine = lineIndex + 1;
    if (lineIndex < targetEnd - 1) {
      text += "\n";
      textBytes += 1;
    }
  }
  const items: AttachmentReadItem[] =
    text.length === 0
      ? []
      : [
          {
            type: "TEXT",
            location: { kind: "TEXT_LINES", startLine: range.startLine, endLine },
            text,
          },
        ];
  return { items, ...(next !== undefined ? { continuation: next } : {}) };
}

interface Candidate {
  readonly item: AttachmentReadItem;
  readonly resumeRange: AttachmentReadRange;
}

function makeReadResult(
  artifactId: string,
  sha: string,
  range: AttachmentReadRange,
  candidates: readonly Candidate[],
  naturalNextRange?: AttachmentReadRange,
): AttachmentReadResult {
  const items: AttachmentReadItem[] = [];
  let continuation = naturalNextRange;
  let truncated = naturalNextRange !== undefined;
  const base = {
    artifactId,
    sha256: sha,
    processorVersion: ATTACHMENT_PROCESSOR_VERSION,
    range,
  };
  for (const candidate of candidates) {
    if (items.length >= MAX_ATTACHMENT_READ_ITEMS) {
      continuation = candidate.resumeRange;
      truncated = true;
      break;
    }
    const proposed = [...items, candidate.item];
    const outputBytes =
      Buffer.byteLength(
        JSON.stringify({
          ...base,
          items: proposed,
          truncated: false,
          outputBytes: 0,
        }),
        "utf8",
      ) + 1024;
    if (outputBytes > MAX_ATTACHMENT_READ_RESULT_BYTES) {
      continuation = candidate.resumeRange;
      truncated = true;
      break;
    }
    items.push(candidate.item);
  }
  const finalBase = {
    ...base,
    items,
    truncated,
    ...(truncated && continuation !== undefined ? { nextRange: continuation } : {}),
    outputBytes: 0,
  };
  let outputBytes = Buffer.byteLength(JSON.stringify(finalBase), "utf8");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const exactBytes = Buffer.byteLength(JSON.stringify({ ...finalBase, outputBytes }), "utf8");
    if (exactBytes === outputBytes) break;
    outputBytes = exactBytes;
  }
  if (outputBytes > MAX_ATTACHMENT_READ_RESULT_BYTES) fail("RESOURCE_LIMIT");
  return AttachmentReadResultSchema.parse({ ...finalBase, outputBytes });
}

function manifestSummary(manifest: AttachmentProcessingManifest): string {
  const common = {
    artifactId: manifest.artifactId,
    sha256: manifest.sha256,
    mediaType: manifest.mediaType,
    processorVersion: manifest.processorVersion,
    visualRequirement: manifest.visualRequirement,
    kind: manifest.kind,
  };
  if (manifest.kind === "TEXT") {
    return JSON.stringify({
      ...common,
      encoding: manifest.encoding,
      lineCount: manifest.lineCount,
      characterCount: manifest.characterCount,
    });
  }
  if (manifest.kind === "IMAGE") {
    return JSON.stringify({
      ...common,
      width: manifest.width,
      height: manifest.height,
      frameCount: manifest.frameCount,
      animated: manifest.animated,
    });
  }
  if (manifest.kind === "PDF") {
    return JSON.stringify({
      ...common,
      pageCount: manifest.pageCount,
      pages: manifest.pages.map(({ pageNumber, textAvailable, visualContentAvailable }) => ({
        pageNumber,
        textAvailable,
        visualContentAvailable,
      })),
    });
  }
  if (manifest.kind === "DOCX") {
    return JSON.stringify({
      ...common,
      blockCount: manifest.blockCount,
      paragraphCount: manifest.paragraphCount,
      tableCount: manifest.tableCount,
      imageCount: manifest.imageCount,
    });
  }
  return JSON.stringify({
    ...common,
    sheets: manifest.sheets.map(({ name, state, rowCount, columnCount, imageAnchors }) => ({
      name,
      state,
      rowCount,
      columnCount,
      imageCount: imageAnchors.length,
    })),
  });
}

async function readAttachment(
  bytes: Buffer,
  untrustedManifest: AttachmentProcessingManifest,
  untrustedRange: AttachmentReadRange,
): Promise<AttachmentReadResult> {
  const manifest = AttachmentProcessingManifestSchema.parse(untrustedManifest);
  const range = AttachmentReadRangeSchema.parse(untrustedRange);
  const hash = sha256(bytes);
  if (hash !== manifest.sha256) fail("CONTENT_HASH_MISMATCH");
  if (manifest.processorVersion !== ATTACHMENT_PROCESSOR_VERSION) fail("UNSUPPORTED_FORMAT");
  const candidates: Candidate[] = [];
  let naturalNextRange: AttachmentReadRange | undefined;

  if (range.kind === "MANIFEST") {
    candidates.push({
      item: { type: "TEXT", location: { kind: "MANIFEST" }, text: manifestSummary(manifest) },
      resumeRange: range,
    });
  } else if (range.kind === "IMAGE") {
    if (manifest.kind !== "IMAGE") fail("UNSUPPORTED_FORMAT");
    const image = await decodeImage(bytes);
    candidates.push({
      item: {
        type: "IMAGE",
        location: { kind: "IMAGE" },
        mediaType: image.mediaType,
        data: image.data,
        width: image.width,
        height: image.height,
      },
      resumeRange: range,
    });
  } else if (range.kind === "TEXT_LINES") {
    if (manifest.kind !== "TEXT") fail("UNSUPPORTED_FORMAT");
    const document = inspectText(bytes);
    const read = textCandidatesForLineRange(document, range);
    for (const item of read.items) {
      candidates.push({ item, resumeRange: range });
    }
    naturalNextRange = read.continuation;
  } else if (range.kind === "PDF_PAGE") {
    if (manifest.kind !== "PDF" || range.pageNumber > manifest.pageCount) fail("INVALID_DOCUMENT");
    const document = await openPdf(bytes);
    try {
      const page = await document.getPage(range.pageNumber);
      const textContent = await page.getTextContent();
      const text = readPdfText(textContent.items);
      const offset = range.textOffset ?? 0;
      if (offset > text.length) fail("INVALID_DOCUMENT");
      const textChunk = takeUtf8Chunk(
        text,
        offset,
        Math.min(180 * 1024, MAX_DOCUMENT_OUTPUT_BYTES - 2048),
      );
      if (textChunk.text.length > 0) {
        const nextRange: AttachmentReadRange = {
          ...range,
          textOffset: offset + textChunk.text.length,
        };
        candidates.push({
          item: {
            type: "TEXT",
            location: { kind: "PDF_PAGE", pageNumber: range.pageNumber },
            text: textChunk.text,
          },
          resumeRange: { ...range, textOffset: offset },
        });
        if (textChunk.truncated) naturalNextRange = nextRange;
      }
      if (!textChunk.truncated && offset === 0) {
        const image = await renderPdfPage(page);
        candidates.push({
          item: {
            type: "IMAGE",
            location: { kind: "PDF_PAGE", pageNumber: range.pageNumber },
            mediaType: image.mediaType,
            data: image.data,
            width: image.width,
            height: image.height,
          },
          resumeRange: { ...range, textOffset: text.length },
        });
      } else if (!textChunk.truncated && offset >= text.length) {
        const image = await renderPdfPage(page);
        candidates.push({
          item: {
            type: "IMAGE",
            location: { kind: "PDF_PAGE", pageNumber: range.pageNumber },
            mediaType: image.mediaType,
            data: image.data,
            width: image.width,
            height: image.height,
          },
          resumeRange: range,
        });
      }
      if (textChunk.truncated)
        naturalNextRange =
          textChunk.nextOffset === undefined
            ? undefined
            : { ...range, textOffset: textChunk.nextOffset };
      page.cleanup();
    } finally {
      await destroyPdf(document);
    }
  } else if (range.kind === "DOCX_BLOCKS") {
    if (manifest.kind !== "DOCX") fail("UNSUPPORTED_FORMAT");
    const document = await parseDocx(bytes);
    const end = Math.min(document.blocks.length, range.startIndex + range.blockCount);
    let officeImagesRead = 0;
    let stopDocumentBlocks = false;
    for (let blockIndex = range.startIndex; blockIndex < end; blockIndex += 1) {
      const block = document.blocks[blockIndex];
      if (block === undefined) continue;
      const resumingImage = blockIndex === range.startIndex && range.imageIndex !== undefined;
      if (!resumingImage && block.kind === "PARAGRAPH" && block.text) {
        const offset = blockIndex === range.startIndex ? (range.textOffset ?? 0) : 0;
        if (offset > block.text.length) fail("INVALID_DOCUMENT");
        const chunk = takeUtf8Chunk(block.text, offset, 24 * 1024);
        if (chunk.text.length > 0) {
          candidates.push({
            item: { type: "TEXT", location: { kind: "DOCX_BLOCK", blockIndex }, text: chunk.text },
            resumeRange: { ...range, startIndex: blockIndex, textOffset: offset },
          });
        }
        if (chunk.truncated) {
          naturalNextRange = {
            ...range,
            startIndex: blockIndex,
            textOffset: chunk.nextOffset ?? offset,
          };
          break;
        }
      } else if (!resumingImage && block.kind === "TABLE" && block.rows) {
        let stop = false;
        for (let rowIndex = 0; rowIndex < block.rows.length && !stop; rowIndex += 1) {
          const row = block.rows[rowIndex] ?? [];
          const startColumn =
            blockIndex === range.startIndex && rowIndex === (range.tableRow ?? 0)
              ? (range.tableColumn ?? 0)
              : 0;
          for (let columnIndex = startColumn; columnIndex < row.length; columnIndex += 1) {
            const text = row[columnIndex] ?? "";
            if (text.length === 0) continue;
            const offset =
              blockIndex === range.startIndex &&
              rowIndex === (range.tableRow ?? 0) &&
              columnIndex === startColumn
                ? (range.textOffset ?? 0)
                : 0;
            if (offset > text.length) fail("INVALID_DOCUMENT");
            const chunk = takeUtf8Chunk(text, offset, 24 * 1024);
            if (chunk.text.length > 0) {
              candidates.push({
                item: {
                  type: "TEXT",
                  location: { kind: "DOCX_TABLE_CELL", blockIndex, rowIndex, columnIndex },
                  text: chunk.text,
                },
                resumeRange: {
                  ...range,
                  startIndex: blockIndex,
                  tableRow: rowIndex,
                  tableColumn: columnIndex,
                  textOffset: offset,
                },
              });
            }
            if (chunk.truncated) {
              naturalNextRange = {
                ...range,
                startIndex: blockIndex,
                tableRow: rowIndex,
                tableColumn: columnIndex,
                textOffset: chunk.nextOffset ?? offset,
              };
              stop = true;
              break;
            }
          }
        }
        if (stop) break;
      }
      const imageStart = blockIndex === range.startIndex ? (range.imageIndex ?? 0) : 0;
      for (let index = imageStart; index < block.imageIndices.length; index += 1) {
        const imageIndex = block.imageIndices[index];
        if (imageIndex === undefined) continue;
        const imageBytes = document.images[imageIndex];
        if (imageBytes === undefined) continue;
        const image = await decodeImage(imageBytes);
        candidates.push({
          item: {
            type: "IMAGE",
            location: { kind: "DOCX_IMAGE", imageIndex },
            mediaType: image.mediaType,
            data: image.data,
            width: image.width,
            height: image.height,
          },
          resumeRange: { ...range, startIndex: blockIndex, imageIndex: index },
        });
        officeImagesRead += 1;
        if (officeImagesRead >= MAX_OFFICE_IMAGES_PER_READ) {
          naturalNextRange = {
            ...range,
            startIndex: blockIndex,
            imageIndex: index + 1,
          };
          stopDocumentBlocks = true;
          break;
        }
      }
      if (stopDocumentBlocks) break;
    }
    if (naturalNextRange === undefined && end < document.blocks.length) {
      naturalNextRange = { kind: "DOCX_BLOCKS", startIndex: end, blockCount: range.blockCount };
    }
  } else if (range.kind === "XLSX_RANGE") {
    if (manifest.kind !== "XLSX") fail("UNSUPPORTED_FORMAT");
    const workbook = await loadWorkbook(bytes);
    const worksheet = workbook.getWorksheet(range.sheetName);
    if (worksheet === undefined) fail("INVALID_DOCUMENT");
    const addressRange = parseCellRange(range.range);
    const start = range.startCell === undefined ? addressRange.start : parseCell(range.startCell);
    if (!isInCellRange(start, addressRange)) fail("INVALID_DOCUMENT");
    const imageIndexesByAddress = new Map<string, number[]>();
    worksheet.getImages().forEach((image, index) => {
      const address = cellAddress(image.range.tl.nativeRow + 1, image.range.tl.nativeCol + 1);
      const location = parseCell(address);
      if (
        !isInCellRange(location, addressRange) ||
        location.row < start.row ||
        (location.row === start.row && location.column < start.column)
      )
        return;
      const indexes = imageIndexesByAddress.get(address) ?? [];
      indexes.push(index);
      imageIndexesByAddress.set(address, indexes);
    });
    let stopped = false;
    let officeImagesRead = 0;
    for (let row = start.row; row <= addressRange.end.row && !stopped; row += 1) {
      for (
        let column = row === start.row ? start.column : addressRange.start.column;
        column <= addressRange.end.column;
        column += 1
      ) {
        const address = cellAddress(row, column);
        const cell = worksheet.getCell(row, column);
        const value = cell.value;
        const formula = formulaText(value);
        const normalizedValue =
          formula !== undefined && typeof value === "object" && value !== null && "result" in value
            ? (simpleCellValue(value.result as ExcelJS.CellValue | undefined) ?? null)
            : simpleCellValue(value);
        const skipCell = range.skipCell === true && row === start.row && column === start.column;
        let cellTextTruncated = false;
        if (
          !skipCell &&
          ((normalizedValue !== null && normalizedValue !== undefined) || formula !== undefined)
        ) {
          const valueOffset =
            row === start.row && column === start.column ? (range.textOffset ?? 0) : 0;
          let cellValue = normalizedValue;
          let nextCellRange: AttachmentReadRange = {
            ...range,
            startCell: address,
            startImageIndex: 0,
            skipCell: true,
            textOffset: undefined,
          };
          if (typeof normalizedValue === "string") {
            if (valueOffset > normalizedValue.length) fail("INVALID_DOCUMENT");
            const chunk = takeUtf8Chunk(normalizedValue, valueOffset, 16_000);
            cellValue = chunk.text;
            cellTextTruncated = chunk.truncated;
            nextCellRange = chunk.truncated
              ? {
                  ...range,
                  startCell: address,
                  startImageIndex: 0,
                  skipCell: false,
                  textOffset: chunk.nextOffset ?? valueOffset,
                }
              : {
                  ...range,
                  startCell: address,
                  startImageIndex: 0,
                  skipCell: true,
                  textOffset: undefined,
                };
          }
          const cellItem = {
            type: "CELL" as const,
            location: { kind: "XLSX_CELL" as const, sheetName: worksheet.name, address },
            ...(formula !== undefined ? { formula } : {}),
            ...(cellValue !== undefined ? { value: cellValue } : {}),
          };
          candidates.push({
            item: cellItem,
            resumeRange: {
              ...range,
              startCell: address,
              startImageIndex: 0,
              skipCell: false,
              ...(typeof normalizedValue === "string" ? { textOffset: valueOffset } : {}),
            },
          });
          if (cellTextTruncated) {
            naturalNextRange = nextCellRange;
            stopped = true;
            break;
          }
        }
        const imagesAtAddress = imageIndexesByAddress.get(address) ?? [];
        const firstImageIndex =
          row === start.row && column === start.column ? (range.startImageIndex ?? 0) : 0;
        for (
          let imagePosition = firstImageIndex;
          imagePosition < imagesAtAddress.length;
          imagePosition += 1
        ) {
          const worksheetImageIndex = imagesAtAddress[imagePosition];
          if (worksheetImageIndex === undefined) continue;
          const imageRef = worksheet.getImages()[worksheetImageIndex];
          if (imageRef === undefined) continue;
          const workbookImage = workbook.getImage(Number(imageRef.imageId));
          const extension = workbookImage.extension.toLowerCase();
          const expectedType = mediaTypeForOfficeImage(extension);
          const imageBytes = workbookImage.buffer;
          if (imageBytes === undefined) fail("INVALID_DOCUMENT");
          const safeImageBytes = Buffer.from(imageBytes);
          assertImageBuffer(safeImageBytes, expectedType);
          const image = await decodeImage(safeImageBytes);
          candidates.push({
            item: {
              type: "IMAGE",
              location: { kind: "XLSX_IMAGE", sheetName: worksheet.name, cellAddress: address },
              mediaType: image.mediaType,
              data: image.data,
              width: image.width,
              height: image.height,
            },
            resumeRange: {
              ...range,
              startCell: address,
              startImageIndex: imagePosition,
              skipCell: true,
              textOffset: undefined,
            },
          });
          officeImagesRead += 1;
          if (officeImagesRead >= MAX_OFFICE_IMAGES_PER_READ) {
            naturalNextRange = {
              ...range,
              startCell: address,
              startImageIndex: imagePosition + 1,
              skipCell: true,
              textOffset: undefined,
            };
            stopped = true;
            break;
          }
        }
        if (stopped) break;
        if (candidates.length >= MAX_ATTACHMENT_READ_ITEMS + 1) {
          const nextRow = column < addressRange.end.column ? row : row + 1;
          const nextColumn =
            column < addressRange.end.column ? column + 1 : addressRange.start.column;
          naturalNextRange =
            nextRow <= addressRange.end.row
              ? {
                  ...range,
                  startCell: cellAddress(nextRow, nextColumn),
                  startImageIndex: 0,
                  skipCell: false,
                }
              : undefined;
          stopped = true;
          break;
        }
      }
    }
  } else if (range.kind === "SEARCH") {
    const startMatch = range.startMatch ?? 0;
    const matches = await searchDocument(
      bytes,
      manifest,
      range.query,
      startMatch,
      range.maxMatches,
    );
    for (let index = 0; index < matches.items.length; index += 1) {
      const item = matches.items[index];
      if (item === undefined) continue;
      candidates.push({
        item,
        resumeRange: { ...range, startMatch: startMatch + index },
      });
    }
    naturalNextRange = matches.nextRange;
  }

  return makeReadResult(manifest.artifactId, hash, range, candidates, naturalNextRange);
}

function takeUtf8Chunk(
  text: string,
  start: number,
  maxBytes: number,
): { text: string; truncated: boolean; nextOffset?: number } {
  let result = "";
  let bytes = 0;
  let offset = start;
  for (const character of text.slice(start)) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) return { text: result, truncated: true, nextOffset: offset };
    result += character;
    bytes += size;
    offset += character.length;
  }
  return { text: result, truncated: false };
}

async function searchDocument(
  bytes: Buffer,
  manifest: AttachmentProcessingManifest,
  query: string,
  startMatch: number,
  maxMatches: number,
): Promise<{ items: AttachmentReadItem[]; nextRange?: AttachmentReadRange }> {
  const needle = query.toLowerCase();
  const matched: AttachmentReadItem[] = [];
  let seen = 0;
  let hasMore = false;
  const consider = (text: string, location: AttachmentReadItem["location"]) => {
    const index = text.toLowerCase().indexOf(needle);
    if (index < 0) return;
    if (seen >= 100_000) fail("RESOURCE_LIMIT");
    if (seen++ < startMatch) return;
    if (matched.length >= maxMatches) {
      hasMore = true;
      return;
    }
    const from = Math.max(0, index - 120);
    const to = Math.min(text.length, index + query.length + 120);
    matched.push({ type: "TEXT", location, text: text.slice(from, to) });
  };
  if (manifest.kind === "TEXT") {
    const document = inspectText(bytes);
    document.lines.forEach((line, index) =>
      consider(line, { kind: "TEXT_LINES", startLine: index + 1, endLine: index + 1 }),
    );
  } else if (manifest.kind === "PDF") {
    const document = await openPdf(bytes);
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        consider(readPdfText(content.items), { kind: "PDF_PAGE", pageNumber });
        page.cleanup();
      }
    } finally {
      await destroyPdf(document);
    }
  } else if (manifest.kind === "DOCX") {
    const document = await parseDocx(bytes);
    document.blocks.forEach((block, blockIndex) => {
      if (block.text !== undefined) consider(block.text, { kind: "DOCX_BLOCK", blockIndex });
      block.rows?.forEach((row, rowIndex) =>
        row.forEach((text, columnIndex) =>
          consider(text, { kind: "DOCX_TABLE_CELL", blockIndex, rowIndex, columnIndex }),
        ),
      );
    });
  } else if (manifest.kind === "XLSX") {
    const workbook = await loadWorkbook(bytes);
    for (const worksheet of workbook.worksheets) {
      worksheet.eachRow((row, rowNumber) =>
        row.eachCell((cell, columnNumberValue) => {
          const formula = formulaText(cell.value);
          const value =
            formula !== undefined &&
            typeof cell.value === "object" &&
            cell.value !== null &&
            "result" in cell.value
              ? simpleCellValue(cell.value.result as ExcelJS.CellValue | undefined)
              : simpleCellValue(cell.value);
          if (value !== undefined && value !== null) {
            consider(String(value), {
              kind: "XLSX_CELL",
              sheetName: worksheet.name,
              address: cellAddress(rowNumber, columnNumberValue),
            });
          }
        }),
      );
    }
  }
  return {
    items: matched,
    ...(hasMore
      ? {
          nextRange: { kind: "SEARCH", query, maxMatches, startMatch: startMatch + matched.length },
        }
      : {}),
  };
}
