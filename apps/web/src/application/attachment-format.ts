import {
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  type LucideIcon,
} from "lucide-react";

/**
 * The visual identity of one attachment format.
 *
 * Both the composer card and the transcript card read this table, so a PDF looks like a PDF in either
 * place. The key is also the CSS hook (`data-format`); colour lives in `styles.css` so light and dark
 * themes stay in one place.
 */
export type AttachmentFormatKey =
  "pdf" | "word" | "excel" | "image" | "text" | "code" | "archive" | "other";

export interface AttachmentFormat {
  readonly key: AttachmentFormatKey;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Compact format mark layered over the file glyph. */
  readonly mark: string;
}

const EXTENSIONS: Readonly<Record<string, AttachmentFormatKey>> = Object.freeze({
  pdf: "pdf",
  doc: "word",
  docx: "word",
  docm: "word",
  rtf: "word",
  odt: "word",
  xls: "excel",
  xlsx: "excel",
  xlsm: "excel",
  xlsb: "excel",
  ods: "excel",
  csv: "excel",
  tsv: "excel",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  bmp: "image",
  svg: "image",
  heic: "image",
  tif: "image",
  tiff: "image",
  txt: "text",
  md: "text",
  markdown: "text",
  rst: "text",
  log: "text",
  ini: "code",
  conf: "code",
  config: "code",
  env: "code",
  ts: "code",
  tsx: "code",
  mts: "code",
  cts: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  json: "code",
  jsonl: "code",
  yaml: "code",
  yml: "code",
  toml: "code",
  xml: "code",
  html: "code",
  htm: "code",
  css: "code",
  scss: "code",
  py: "code",
  pyi: "code",
  go: "code",
  rs: "code",
  java: "code",
  kt: "code",
  kts: "code",
  c: "code",
  h: "code",
  cc: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  fs: "code",
  fsx: "code",
  php: "code",
  rb: "code",
  rake: "code",
  swift: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  ps1: "code",
  sql: "code",
  graphql: "code",
  gql: "code",
  proto: "code",
  dockerfile: "code",
  makefile: "code",
  gradle: "code",
  properties: "code",
  bat: "code",
  cmd: "code",
  vue: "code",
  svelte: "code",
  astro: "code",
  lock: "code",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
});

const FORMATS: Readonly<Record<AttachmentFormatKey, AttachmentFormat>> = Object.freeze({
  pdf: { key: "pdf", label: "PDF", icon: FileText, mark: "PDF" },
  word: { key: "word", label: "DOC", icon: FileType2, mark: "W" },
  excel: { key: "excel", label: "SHEET", icon: FileSpreadsheet, mark: "X" },
  image: { key: "image", label: "IMG", icon: FileImage, mark: "IMG" },
  text: { key: "text", label: "TXT", icon: FileText, mark: "TXT" },
  code: { key: "code", label: "CODE", icon: FileCode2, mark: "</>" },
  archive: { key: "archive", label: "ZIP", icon: FileArchive, mark: "ZIP" },
  other: { key: "other", label: "FILE", icon: File, mark: "FILE" },
});

/** Resolve a name and/or media type to the one presentation both cards share. */
export function attachmentFormatOf(input: {
  readonly name?: string | undefined;
  readonly mediaType?: string | undefined;
}): AttachmentFormat {
  const extension = extensionOf(input.name);
  if (extension !== undefined) {
    const key = EXTENSIONS[extension];
    if (key !== undefined) {
      return Object.freeze({
        ...FORMATS[key],
        label: labelFor(extension, key),
        mark: markFor(extension, key),
      });
    }
    return Object.freeze({
      ...FORMATS.other,
      label: extension.toUpperCase(),
      mark: compactMark(extension),
    });
  }
  const mediaType = input.mediaType?.toLowerCase();
  if (mediaType?.startsWith("image/") === true) return FORMATS.image;
  if (mediaType === "application/pdf") return FORMATS.pdf;
  if (mediaType?.includes("wordprocessingml") === true || mediaType === "application/msword") {
    return FORMATS.word;
  }
  if (
    mediaType?.includes("spreadsheetml") === true ||
    mediaType === "application/vnd.ms-excel" ||
    mediaType === "text/csv" ||
    mediaType === "text/tab-separated-values"
  ) {
    return FORMATS.excel;
  }
  if (
    mediaType === "application/json" ||
    mediaType === "application/xml" ||
    mediaType === "application/javascript" ||
    mediaType === "text/javascript" ||
    mediaType === "text/html" ||
    mediaType === "text/css" ||
    mediaType === "application/x-yaml" ||
    mediaType === "application/toml"
  ) {
    return FORMATS.code;
  }
  if (
    mediaType === "application/zip" ||
    mediaType === "application/x-7z-compressed" ||
    mediaType === "application/vnd.rar" ||
    mediaType === "application/x-rar-compressed" ||
    mediaType === "application/gzip" ||
    mediaType === "application/x-bzip2" ||
    mediaType === "application/x-xz"
  ) {
    return FORMATS.archive;
  }
  if (mediaType?.startsWith("text/") === true) return FORMATS.text;
  return FORMATS.other;
}

function extensionOf(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const normalizedName = name.toLowerCase();
  if (normalizedName === "dockerfile" || normalizedName === "makefile") return normalizedName;
  const index = name.lastIndexOf(".");
  if (index < 0 || index === name.length - 1) return undefined;
  return name.slice(index + 1).toLowerCase();
}

/** Prefer the real extension (DOCX/XLSX/TSV) and fall back to the format family. */
function labelFor(extension: string, key: AttachmentFormatKey): string {
  if (extension === "jpeg") return "JPG";
  if (extension === "markdown") return "MD";
  if (key === "image" && extension === "svg") return "SVG";
  return extension.toUpperCase();
}

function markFor(extension: string, key: AttachmentFormatKey): string {
  if (key === "pdf") return "PDF";
  if (key === "word") return "W";
  if (key === "excel") return "X";
  if (key === "image") return extension === "svg" ? "SVG" : "IMG";
  return compactMark(labelFor(extension, key));
}

function compactMark(value: string): string {
  return value.length > 4 ? value.slice(0, 4) : value;
}
