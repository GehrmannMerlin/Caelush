import { createReadStream } from "node:fs";
import { lstat, realpath as resolveRealpath, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  RuntimeDiscoveryError,
  RuntimeFileReadError,
  RuntimePathNotFoundError,
} from "../runtime-errors.js";
import { readBoundedUtf8Text } from "./text-reader.js";
import type {
  RuntimeDirectoryEntry,
  RuntimeFileKind,
  RuntimeFileMetadata,
  RuntimeFileFingerprint,
  RuntimeFileSystem,
  RuntimeTextRead,
} from "./types.js";

function kind(stats: {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
}): RuntimeFileKind {
  if (stats.isSymbolicLink()) return "SYMLINK";
  if (stats.isFile()) return "FILE";
  if (stats.isDirectory()) return "DIRECTORY";
  return "OTHER";
}

export class LocalRuntimeFileSystem implements RuntimeFileSystem {
  async getMetadata(absolutePath: string): Promise<RuntimeFileMetadata | null> {
    try {
      const stats = await lstat(absolutePath);
      return { kind: kind(stats), ...(stats.isFile() ? { sizeBytes: stats.size } : {}) };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw new RuntimePathNotFoundError("path metadata could not be read", { cause: error });
    }
  }

  async fingerprint(absolutePath: string): Promise<RuntimeFileFingerprint> {
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { kind: "MISSING" };
      }
      throw new RuntimeFileReadError("file fingerprint could not be read", { cause: error });
    }

    const fileKind = kind(stats);
    if (fileKind !== "FILE") return { kind: fileKind };

    const hash = createHash("sha256");
    try {
      for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
    } catch (error) {
      throw new RuntimeFileReadError("file fingerprint could not be read", { cause: error });
    }
    return { kind: "FILE", sizeBytes: stats.size, sha256: hash.digest("hex") };
  }

  async realpath(absolutePath: string): Promise<string> {
    try {
      return path.normalize(await resolveRealpath(absolutePath));
    } catch (error) {
      throw new RuntimePathNotFoundError("path does not exist", { cause: error });
    }
  }

  async readDirectory(absolutePath: string): Promise<readonly RuntimeDirectoryEntry[]> {
    try {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      const result: RuntimeDirectoryEntry[] = [];
      for (const entry of entries) {
        const entryPath = path.join(absolutePath, entry.name);
        const metadata = await this.getMetadata(entryPath);
        if (metadata === null) continue;
        result.push({ name: entry.name, kind: metadata.kind });
      }
      return result.sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (error instanceof RuntimePathNotFoundError) throw error;
      throw new RuntimeDiscoveryError("directory could not be read", { cause: error });
    }
  }

  async readTextFile(
    absolutePath: string,
    options: { readonly offset: number; readonly limit: number; readonly maxBytes: number },
  ): Promise<RuntimeTextRead> {
    try {
      return await readBoundedUtf8Text(absolutePath, options);
    } catch (error) {
      if (error instanceof RuntimePathNotFoundError) throw error;
      throw error;
    }
  }
}
