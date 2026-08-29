import { RuntimePatchError } from "./errors.js";
import {
  PATCH_LIMITS,
  type PatchDocument,
  type PatchHunk,
  type PatchLine,
  type PatchOperation,
} from "./types.js";

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const EOF = "*** End of File";

function invalid(): never {
  throw new RuntimePatchError("INVALID_PATCH");
}

function patchPath(raw: string): string {
  const value = raw.replaceAll("\\", "/");
  const segments = value.split("/");
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[A-Za-z]:\//.test(value) ||
    segments.some((segment) => segment === ".." || segment.length === 0)
  ) {
    invalid();
  }
  return value;
}

function readMarker(line: string, marker: string): string | undefined {
  return line.startsWith(marker) ? line.slice(marker.length) : undefined;
}

function parseHunk(lines: readonly string[], start: number): { hunk: PatchHunk; next: number } {
  const header = lines[start];
  if (header === undefined || !(header === "@@" || header.startsWith("@@ "))) invalid();
  const hunkLines: PatchLine[] = [];
  let index = start + 1;
  let endOfFile = false;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) invalid();
    if (line === EOF) {
      endOfFile = true;
      index += 1;
      break;
    }
    if (line === "@@" || line.startsWith("@@ ") || line.startsWith("*** ")) break;
    const prefix = line[0];
    if (prefix !== " " && prefix !== "-" && prefix !== "+") invalid();
    hunkLines.push({
      kind: prefix === " " ? "CONTEXT" : prefix === "-" ? "REMOVE" : "ADD",
      text: line.slice(1),
    });
    index += 1;
  }
  if (hunkLines.length === 0) invalid();
  return { hunk: { lines: hunkLines, endOfFile }, next: index };
}

export function parsePatch(patch: string): PatchDocument {
  if (typeof patch !== "string") invalid();
  if (Buffer.byteLength(patch, "utf8") > PATCH_LIMITS.maxPatchBytes) {
    throw new RuntimePatchError("PATCH_TOO_LARGE");
  }
  const normalized = patch.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  if (lines[0] !== BEGIN || lines.at(-1) !== END) invalid();
  if (lines.length === 2) throw new RuntimePatchError("EMPTY_PATCH");

  const operations: PatchOperation[] = [];
  const sourcePaths = new Set<string>();
  const destinationPaths = new Set<string>();
  let index = 1;
  let hunkCount = 0;
  while (index < lines.length - 1) {
    const line = lines[index];
    if (line === undefined) invalid();
    const addPath = readMarker(line, "*** Add File: ");
    const deletePath = readMarker(line, "*** Delete File: ");
    const updatePath = readMarker(line, "*** Update File: ");
    if (addPath !== undefined) {
      const path = patchPath(addPath);
      if (sourcePaths.has(path)) invalid();
      sourcePaths.add(path);
      const content: string[] = [];
      index += 1;
      while (index < lines.length - 1 && !lines[index]!.startsWith("*** ")) {
        const addLine = lines[index]!;
        if (!addLine.startsWith("+")) invalid();
        content.push(addLine.slice(1));
        index += 1;
      }
      operations.push({ kind: "ADD", path, lines: content });
      continue;
    }
    if (deletePath !== undefined) {
      const path = patchPath(deletePath);
      if (sourcePaths.has(path)) invalid();
      sourcePaths.add(path);
      index += 1;
      if (index < lines.length - 1 && !lines[index]!.startsWith("*** ")) invalid();
      operations.push({ kind: "DELETE", path });
      continue;
    }
    if (updatePath !== undefined) {
      const path = patchPath(updatePath);
      if (sourcePaths.has(path)) invalid();
      sourcePaths.add(path);
      index += 1;
      let moveTo: string | undefined;
      if (index < lines.length - 1) {
        const movePath = readMarker(lines[index]!, "*** Move to: ");
        if (movePath !== undefined) {
          moveTo = patchPath(movePath);
          if (destinationPaths.has(moveTo)) throw new RuntimePatchError("PATCH_CONFLICT");
          destinationPaths.add(moveTo);
          index += 1;
        }
      }
      const hunks: PatchHunk[] = [];
      while (
        index < lines.length - 1 &&
        (lines[index] === "@@" || lines[index]!.startsWith("@@ "))
      ) {
        const parsed = parseHunk(lines, index);
        hunks.push(parsed.hunk);
        hunkCount += 1;
        if (hunkCount > PATCH_LIMITS.maxHunks) throw new RuntimePatchError("TOO_MANY_HUNKS");
        index = parsed.next;
      }
      if (moveTo === undefined && hunks.length === 0) invalid();
      operations.push({ ...(moveTo === undefined ? {} : { moveTo }), kind: "UPDATE", path, hunks });
      continue;
    }
    invalid();
  }
  if (operations.length > PATCH_LIMITS.maxFiles) throw new RuntimePatchError("TOO_MANY_FILES");
  for (const destination of destinationPaths) {
    if (
      sourcePaths.has(destination) ||
      [...destinationPaths].filter((value) => value === destination).length > 1
    ) {
      throw new RuntimePatchError("PATCH_CONFLICT");
    }
  }
  return { operations, fileCount: operations.length, hunkCount };
}
