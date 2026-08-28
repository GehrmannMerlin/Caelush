import { open, lstat, readdir, realpath as resolveRealpath } from "node:fs/promises";
import path from "node:path";
import { ContextIOError } from "./errors.js";

export type ContextFileKind = "FILE" | "DIRECTORY" | "SYMLINK";

export interface ContextFileMetadata {
  readonly kind: ContextFileKind;
}

export interface ContextTextFile {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface ContextDirectoryEntry {
  readonly name: string;
  readonly kind: ContextFileKind;
}

export interface ContextFileSystem {
  getMetadata(path: string): Promise<ContextFileMetadata | null>;
  readTextFile(path: string, options: { maxBytes: number }): Promise<ContextTextFile>;
  readDirectory(path: string): Promise<readonly ContextDirectoryEntry[]>;
  realpath(path: string): Promise<string>;
}

function kindFromStats(stats: { isSymbolicLink(): boolean; isFile(): boolean }): ContextFileKind {
  if (stats.isSymbolicLink()) return "SYMLINK";
  return stats.isFile() ? "FILE" : "DIRECTORY";
}

function wrapFilesystemError(operation: string, target: string, error: unknown): ContextIOError {
  const detail = error instanceof Error ? error.message : "unknown filesystem error";
  return new ContextIOError(`${operation} failed for ${target}: ${detail}`, { cause: error });
}

function validateMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ContextIOError("maxBytes must be a non-negative safe integer");
  }
}

function decodeUtf8Prefix(raw: Uint8Array, maxBytes: number): ContextTextFile {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const truncated = raw.byteLength > maxBytes;
  if (!truncated) {
    return { text: decoder.decode(raw), bytes: raw.byteLength, truncated: false };
  }

  const prefix = raw.subarray(0, maxBytes);
  try {
    decoder.decode(prefix, { stream: true });
  } catch (error) {
    throw new ContextIOError("file contains invalid UTF-8", { cause: error });
  }

  let safeBytes = maxBytes;
  while (safeBytes > 0) {
    try {
      return {
        text: decoder.decode(raw.subarray(0, safeBytes)),
        bytes: safeBytes,
        truncated: true,
      };
    } catch {
      safeBytes -= 1;
    }
  }
  return { text: "", bytes: 0, truncated: true };
}

export class LocalContextFileSystem implements ContextFileSystem {
  async getMetadata(targetPath: string): Promise<ContextFileMetadata | null> {
    try {
      return { kind: kindFromStats(await lstat(targetPath)) };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw wrapFilesystemError("metadata read", targetPath, error);
    }
  }

  async readTextFile(targetPath: string, options: { maxBytes: number }): Promise<ContextTextFile> {
    validateMaxBytes(options.maxBytes);
    try {
      const handle = await open(targetPath, "r");
      try {
        const size = (await handle.stat()).size;
        const readSize = Math.min(size, options.maxBytes + 4);
        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await handle.read(buffer, 0, readSize, 0);
        return decodeUtf8Prefix(buffer.subarray(0, bytesRead), options.maxBytes);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof ContextIOError) throw error;
      throw wrapFilesystemError("text read", targetPath, error);
    }
  }

  async readDirectory(directoryPath: string): Promise<readonly ContextDirectoryEntry[]> {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      return entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({ name: entry.name, kind: kindFromStats(entry) }));
    } catch (error) {
      throw wrapFilesystemError("directory read", directoryPath, error);
    }
  }

  async realpath(targetPath: string): Promise<string> {
    try {
      return path.normalize(await resolveRealpath(targetPath));
    } catch (error) {
      throw wrapFilesystemError("realpath", targetPath, error);
    }
  }
}
