import { open } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import fastGlob from "fast-glob";
import { RuntimeSearchError } from "../runtime-errors.js";
import { RUNTIME_PROJECT_HARD_EXCLUDED_GLOBS } from "../discovery/file-discovery.js";
import type {
  RuntimeTextSearch,
  RuntimeTextSearchRequest,
  RuntimeTextSearchResult,
} from "./text-search.js";

export const MAX_FALLBACK_SEARCH_FILES = 10_000;
export const MAX_FALLBACK_SEARCH_FILE_BYTES = 512 * 1024;
export const MAX_FALLBACK_SEARCH_MATCH_CHARS = 4 * 1024;

/**
 * Bounded in-process search used only when the optional ripgrep accelerator is unavailable.
 *
 * This is intentionally a Runtime implementation rather than a Coding Tool fallback: the same
 * workspace root, hard exclusions, include glob, result limit and AbortSignal remain in force for
 * either backend. It reads a bounded prefix of each candidate and never follows symlinks.
 */
export class LocalTextSearchFallback implements RuntimeTextSearch {
  async search(request: RuntimeTextSearchRequest): Promise<RuntimeTextSearchResult> {
    if (request.signal?.aborted) throw new RuntimeSearchError("search was cancelled");
    const expression = compilePattern(request.pattern);
    const root = path.resolve(request.cwd);
    const pattern = request.include ?? "**/*";
    let files = await collectCandidateFiles(pattern, root);

    files = files
      .map((file) => file.replaceAll("\\", "/"))
      .filter((file) => !isHardExcludedPath(file))
      .sort((left, right) => left.localeCompare(right));
    const tooManyFiles = files.length > MAX_FALLBACK_SEARCH_FILES;
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let truncated = tooManyFiles;

    for (const relativeFile of files.slice(0, MAX_FALLBACK_SEARCH_FILES)) {
      if (request.signal?.aborted) throw new RuntimeSearchError("search was cancelled");
      const absoluteFile = path.resolve(root, relativeFile);
      if (!isInside(root, absoluteFile)) {
        throw new RuntimeSearchError("fallback search returned a path outside its root");
      }
      const read = await readBoundedText(absoluteFile, request.signal);
      truncated = truncated || read.truncated;
      if (read.text === undefined) continue;
      const lines = read.text.split(/\n/u);
      for (const [index, rawLine] of lines.entries()) {
        if (request.signal?.aborted) throw new RuntimeSearchError("search was cancelled");
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!expression.test(line)) continue;
        matches.push({
          path: relativeFile,
          line: index + 1,
          text: boundedMatch(line),
        });
        if (matches.length > request.limit) break;
      }
      if (matches.length > request.limit) break;
    }

    return {
      matches: matches.slice(0, request.limit),
      truncated: truncated || matches.length > request.limit,
    };
  }
}

async function collectCandidateFiles(pattern: string, root: string): Promise<string[]> {
  try {
    const stream = fastGlob.stream(pattern, {
      cwd: root,
      onlyFiles: true,
      followSymbolicLinks: false,
      unique: true,
      absolute: false,
      dot: false,
      ignore: RUNTIME_PROJECT_HARD_EXCLUDED_GLOBS,
      suppressErrors: false,
    });
    const boundedStream = stream as NodeJS.ReadableStream & {
      destroy?: () => void;
    };
    return await new Promise<string[]>((resolve, reject) => {
      const files: string[] = [];
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };
      stream.on("data", (entry: unknown) => {
        if (settled) return;
        files.push(String(entry));
        if (files.length > MAX_FALLBACK_SEARCH_FILES) {
          boundedStream.destroy?.();
          finish(() => resolve(files));
        }
      });
      stream.once("error", (error: unknown) => {
        finish(() => reject(error));
      });
      stream.once("end", () => {
        finish(() => resolve(files));
      });
    });
  } catch (error) {
    throw new RuntimeSearchError("fallback search could not enumerate files", { cause: error });
  }
}

function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch (error) {
    throw new RuntimeSearchError("search pattern is invalid", { cause: error });
  }
}

async function readBoundedText(
  absoluteFile: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly text?: string; readonly truncated: boolean }> {
  const handle = await open(absoluteFile, "r");
  try {
    if (signal?.aborted) throw new RuntimeSearchError("search was cancelled");
    const size = (await handle.stat()).size;
    const length = Math.min(size, MAX_FALLBACK_SEARCH_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, 0);
    if (signal?.aborted) throw new RuntimeSearchError("search was cancelled");
    if (buffer.subarray(0, result.bytesRead).includes(0)) {
      return { truncated: size > MAX_FALLBACK_SEARCH_FILE_BYTES };
    }
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, result.bytesRead),
        ),
        truncated: size > MAX_FALLBACK_SEARCH_FILE_BYTES,
      };
    } catch {
      return { truncated: size > MAX_FALLBACK_SEARCH_FILE_BYTES };
    }
  } finally {
    await handle.close();
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function isHardExcludedPath(relativeFile: string): boolean {
  const excludedNames = new Set(
    RUNTIME_PROJECT_HARD_EXCLUDED_GLOBS.map((glob) => glob.slice(3, -3).toLowerCase()),
  );
  return relativeFile.split("/").some((segment) => excludedNames.has(segment.toLowerCase()));
}

function boundedMatch(text: string): string {
  return Array.from(text).slice(0, MAX_FALLBACK_SEARCH_MATCH_CHARS).join("");
}
