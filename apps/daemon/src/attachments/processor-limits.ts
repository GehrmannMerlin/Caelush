export const ATTACHMENT_PROCESSOR_VERSION = "attachments-v1";

export const MAX_ATTACHMENT_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 5_000;
export const MAX_ARCHIVE_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_DOCUMENT_PAGES = 250;
export const MAX_DOCUMENT_BLOCKS = 5_000;
export const MAX_WORKSHEETS = 128;
export const MAX_XLSX_CELLS = 100_000;
export const MAX_IMAGE_PIXELS = 12_000_000;
export const MAX_RENDER_PIXELS = 4_000_000;
export const MAX_RENDER_DIMENSION = 8_192;
export const MAX_DOCUMENT_OUTPUT_BYTES = 256 * 1024;
export const DOCUMENT_PROCESSOR_TIMEOUT_MS = 20_000;
export const DOCUMENT_PROCESSOR_HEAP_MB = 256;

export const DOCUMENT_PROCESSOR_LIMITS = Object.freeze({
  maxInputBytes: MAX_ATTACHMENT_INPUT_BYTES,
  maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
  maxArchiveEntryBytes: MAX_ARCHIVE_ENTRY_BYTES,
  maxArchiveUncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  maxDocumentPages: MAX_DOCUMENT_PAGES,
  maxDocumentBlocks: MAX_DOCUMENT_BLOCKS,
  maxWorksheets: MAX_WORKSHEETS,
  maxXlsxCells: MAX_XLSX_CELLS,
  maxImagePixels: MAX_IMAGE_PIXELS,
  maxRenderPixels: MAX_RENDER_PIXELS,
  maxRenderDimension: MAX_RENDER_DIMENSION,
  maxOutputBytes: MAX_DOCUMENT_OUTPUT_BYTES,
  timeoutMs: DOCUMENT_PROCESSOR_TIMEOUT_MS,
  heapMb: DOCUMENT_PROCESSOR_HEAP_MB,
});
