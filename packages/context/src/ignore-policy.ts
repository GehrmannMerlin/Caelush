import ignore from "ignore";
import path from "node:path";
import { isProjectHardExcludedDirectoryName } from "@caelush/shared";
import { classifySensitivePath } from "@caelush/security/sensitive-path";
import { ContextIgnoreError } from "./errors.js";
import type { ContextFileKind, ContextFileSystem } from "./filesystem.js";
import { isWithinWorkspace } from "./workspace.js";

const MAX_GITIGNORE_BYTES = 131072;

const binaryExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".jar",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".wav",
  ".mp4",
  ".mov",
  ".avi",
  ".sqlite",
  ".sqlite3",
  ".db",
]);

export interface IgnorePolicyDependencies {
  readonly filesystem: ContextFileSystem;
  readonly projectRoot: string;
  readonly workspaceRoot: string;
}

export interface IgnoreDecision {
  readonly ignored: boolean;
  readonly hardExcluded: boolean;
  readonly sensitive: boolean;
  readonly binary: boolean;
  readonly gitignored: boolean;
}

interface IgnoreRuleLayer {
  readonly baseDirectory: string;
  readonly sourcePath: string;
  readonly matcher: ReturnType<typeof ignore>;
}

function normalizeMatcherPath(targetPath: string): string {
  return targetPath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function isBinaryName(fileName: string): boolean {
  return binaryExtensions.has(path.extname(fileName).toLowerCase());
}

function hasHardExcludedDirectory(relativePath: string): boolean {
  const segments = normalizeMatcherPath(relativePath).split("/").filter(Boolean);
  for (const segment of segments) {
    if (isProjectHardExcludedDirectoryName(segment)) return true;
  }
  return false;
}

function ancestorDirectories(directory: string, root: string): readonly string[] {
  const result: string[] = [];
  let cursor = directory;
  while (true) {
    result.unshift(cursor);
    if (cursor === root) return result;
    const parent = path.dirname(cursor);
    if (parent === cursor) return result;
    cursor = parent;
  }
}

function policyError(message: string, cause?: unknown): ContextIgnoreError {
  return new ContextIgnoreError(message, cause === undefined ? undefined : { cause });
}

export class IgnorePolicy {
  private readonly layers = new Map<string, IgnoreRuleLayer>();

  constructor(private readonly dependencies: IgnorePolicyDependencies) {}

  async decide(targetPath: string, kind: ContextFileKind): Promise<IgnoreDecision> {
    const relativePath = normalizeMatcherPath(
      path.relative(this.dependencies.projectRoot, targetPath),
    );
    const fileName = path.basename(targetPath);
    const hardExcluded = hasHardExcludedDirectory(relativePath);
    const sensitive = kind === "FILE" && classifySensitivePath(relativePath) !== undefined;
    const binary = kind === "FILE" && isBinaryName(fileName);
    const gitignored = await this.isGitignored(targetPath, kind);
    const ignored = hardExcluded || sensitive || binary || gitignored || fileName === ".gitignore";
    return { ignored, hardExcluded, sensitive, binary, gitignored };
  }

  private async isGitignored(targetPath: string, kind: ContextFileKind): Promise<boolean> {
    const relativePath = normalizeMatcherPath(
      path.relative(this.dependencies.projectRoot, targetPath),
    );
    if (
      relativePath === "" ||
      path.isAbsolute(relativePath) ||
      !isWithinWorkspace(this.dependencies.workspaceRoot, targetPath) ||
      !isWithinWorkspace(this.dependencies.projectRoot, targetPath)
    ) {
      return false;
    }

    const parent = kind === "DIRECTORY" ? targetPath : path.dirname(targetPath);
    const directories = ancestorDirectories(parent, this.dependencies.projectRoot);
    let ignored = false;
    for (const directory of directories) {
      if (ignored) break;
      const layer = await this.loadLayer(directory);
      const layerRelativePath = normalizeMatcherPath(path.relative(directory, targetPath));
      if (
        layerRelativePath !== "" &&
        layer.matcher.ignores(kind === "DIRECTORY" ? `${layerRelativePath}/` : layerRelativePath)
      ) {
        ignored = true;
      }
    }
    return ignored;
  }

  private async loadLayer(directory: string): Promise<IgnoreRuleLayer> {
    const cached = this.layers.get(directory);
    if (cached !== undefined) return cached;

    const sourcePath = path.join(directory, ".gitignore");
    let metadata;
    try {
      metadata = await this.dependencies.filesystem.getMetadata(sourcePath);
    } catch (error) {
      throw policyError(`could not inspect gitignore: ${sourcePath}`, error);
    }
    const matcher = ignore();
    if (metadata !== null) {
      if (metadata.kind !== "FILE") {
        throw policyError(`gitignore is not a regular file: ${sourcePath}`);
      }
      let file;
      try {
        file = await this.dependencies.filesystem.readTextFile(sourcePath, {
          maxBytes: MAX_GITIGNORE_BYTES,
        });
      } catch (error) {
        throw policyError(`could not read gitignore: ${sourcePath}`, error);
      }
      if (file.truncated || file.bytes > MAX_GITIGNORE_BYTES) {
        throw policyError(`gitignore exceeds ${MAX_GITIGNORE_BYTES} bytes: ${sourcePath}`);
      }
      try {
        matcher.add(file.text);
      } catch (error) {
        throw policyError(`invalid gitignore rules: ${sourcePath}`, error);
      }
    }
    const layer = { baseDirectory: directory, sourcePath, matcher };
    this.layers.set(directory, layer);
    return layer;
  }
}
