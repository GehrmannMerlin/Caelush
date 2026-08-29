import { TextDecoder, TextEncoder } from "node:util";
import { isBinarySample } from "../filesystem/binary-detection.js";
import { RuntimePatchError } from "./errors.js";
import type { PatchHunk } from "./types.js";

export type PatchNewline = "LF" | "CRLF" | "CR";

export interface DecodedPatchText {
  readonly text: string;
  readonly bom: boolean;
  readonly newline: PatchNewline;
  readonly finalNewline: boolean;
  readonly originalLines: readonly string[];
  readonly originalLineEndings: readonly PatchNewline[];
}

function preferredNewline(text: string): PatchNewline {
  const matches = [...text.matchAll(/\r\n|\r|\n/g)].map(([value]) => value);
  if (matches.length === 0) return "LF";
  const counts = new Map<string, number>();
  for (const value of matches) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = matches[0]!;
  for (const value of matches) {
    if ((counts.get(value) ?? 0) > (counts.get(best) ?? 0)) best = value;
  }
  return best === "\r\n" ? "CRLF" : best === "\r" ? "CR" : "LF";
}

export function decodePatchText(filePath: string, bytes: Uint8Array): DecodedPatchText {
  if (isBinarySample(filePath, bytes.subarray(0, 4096))) {
    throw new RuntimePatchError("BINARY_FILE");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let decoded: string;
  try {
    decoded = decoder.decode(bytes);
  } catch {
    throw new RuntimePatchError("INVALID_UTF8");
  }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = bom && decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const originalLines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  const originalLineEndings: PatchNewline[] = [...text.matchAll(/\r\n|\r|\n/g)].map(([value]) =>
    value === "\r\n" ? "CRLF" : value === "\r" ? "CR" : "LF",
  );
  return {
    text: normalized,
    bom,
    newline: preferredNewline(text),
    finalNewline: /(?:\r\n|\r|\n)$/.test(text),
    originalLines,
    originalLineEndings,
  };
}

function findUnique(lines: readonly string[], pattern: readonly string[], start: number): number {
  const candidates: number[] = [];
  for (let index = start; index <= lines.length - pattern.length; index += 1) {
    if (pattern.every((line, offset) => lines[index + offset] === line)) candidates.push(index);
  }
  if (candidates.length === 0) throw new RuntimePatchError("PATCH_CONTEXT_MISMATCH");
  if (candidates.length > 1) throw new RuntimePatchError("PATCH_CONTEXT_AMBIGUOUS");
  return candidates[0]!;
}

export function applyPatchHunks(text: string, hunks: readonly PatchHunk[]): string {
  const finalNewline = text.endsWith("\n");
  let lines = text.length === 0 ? [] : text.split("\n");
  if (finalNewline) lines = lines.slice(0, -1);
  let searchStart = 0;
  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== "ADD").map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.kind !== "REMOVE").map((line) => line.text);
    if (oldLines.length === 0) throw new RuntimePatchError("PATCH_CONTEXT_AMBIGUOUS");
    const index = findUnique(lines, oldLines, searchStart);
    if (hunk.endOfFile && index + oldLines.length !== lines.length) {
      throw new RuntimePatchError("PATCH_CONTEXT_MISMATCH");
    }
    lines = [...lines.slice(0, index), ...newLines, ...lines.slice(index + oldLines.length)];
    searchStart = index + newLines.length;
  }
  return lines.join("\n") + (finalNewline ? "\n" : "");
}

export function encodePatchedText(metadata: DecodedPatchText, normalizedText: string): Uint8Array {
  const newline = metadata.newline === "CRLF" ? "\r\n" : metadata.newline === "CR" ? "\r" : "\n";
  const lines = normalizedText.endsWith("\n")
    ? normalizedText.slice(0, -1).split("\n")
    : normalizedText.split("\n");
  const body = lines
    .map((line, index) => {
      const hasEnding = index < lines.length - 1 || metadata.finalNewline;
      if (!hasEnding) return line;
      const originalEnding =
        metadata.originalLines[index] === line ? metadata.originalLineEndings[index] : undefined;
      const ending = originalEnding === "CRLF" ? "\r\n" : originalEnding === "CR" ? "\r" : newline;
      return `${line}${ending}`;
    })
    .join("");
  const withFinalNewline = metadata.finalNewline && !body.endsWith(newline) ? body + newline : body;
  const encoded = new TextEncoder().encode(withFinalNewline);
  if (!metadata.bom) return encoded;
  const result = new Uint8Array(encoded.byteLength + 3);
  result.set([0xef, 0xbb, 0xbf]);
  result.set(encoded, 3);
  return result;
}

export function encodeNewPatchFile(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}
