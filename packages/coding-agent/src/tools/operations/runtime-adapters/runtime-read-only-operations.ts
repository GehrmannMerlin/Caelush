import type { JsonObject } from "@caelush/ai";
import type { ToolExecutionEnvironment } from "@caelush/agent";
import {
  RuntimeInvalidRangeError,
  RuntimeInvariantError,
  RuntimePathNotFoundError,
  RuntimePathTypeError,
  type RuntimeResolver,
  type RuntimeWorkspaceScope,
} from "@caelush/runtime";

import type { ReadFileOperations } from "../operations.js";
import type { CodingReadOnlyOperations, CodingToolPathKind } from "../coding-read-only-operations.js";
import { resolveRuntimeWorkspace } from "./resolve-runtime-workspace.js";

/**
 * The Runtime implementation of the four read-only Operations ports.
 *
 * ```text
 * RuntimeReadOnlyOperations implements
 *   ReadFileOperations · ListDirectoryOperations · FindFilesOperations · SearchTextOperations
 * ```
 *
 * One class rather than four, because the four share the whole preamble — resolve the runtime, open the
 * workspace, translate an unsupported runtime — and splitting it would produce four copies of the same
 * resolution. A consumer still sees only the narrow interface it asked for: each Tool's factory
 * parameter narrows this object to the one port that Tool needs.
 *
 * ## Failures are the Runtime's own errors
 *
 * This adapter deliberately does **not** invent a parallel error vocabulary. A path that does not exist
 * raises `RuntimePathNotFoundError`, a file where a directory was expected raises `RuntimePathTypeError`,
 * and a window past the end of a file raises `RuntimeInvalidRangeError` — the same types the Runtime
 * already raises. The Coding Tool layer maps those codes onto safe model-facing results, exactly as the
 * legacy builtins did, so a migration changes *which object* performs the operation and not *what the
 * model is told* when it fails.
 *
 * Anything the adapter does not recognize keeps propagating. An unrecognized Runtime failure is not
 * something a Tool may invent a safe message for, and a `RuntimeInvariantError` in particular means the
 * Runtime's own guarantees were violated — that belongs at the Run execution layer, not in a Tool result
 * the model could react to.
 *
 * ## Absolute paths stop here
 *
 * Every method resolves a workspace-relative path through the scope's path resolver and returns the
 * **relative** form: `read()` returns `resolved.relativePath`, `list()` builds workspace-relative entry
 * paths, `find()` re-resolves each discovered file and keeps only the relative result, and `search()`
 * verifies every match path resolves to a real file inside the search root. A host absolute path is
 * never returned, so it cannot reach model content.
 */

/** The read-file byte bound. A caller cannot raise it: the port has no input for it. */
export const READ_FILE_MAX_BYTES = 50 * 1024;

export interface RuntimeReadOnlyOperations extends CodingReadOnlyOperations, ReadFileOperations {}

export function createRuntimeReadOnlyOperations(
  resolver: RuntimeResolver,
): RuntimeReadOnlyOperations {
  /**
   * Resolve a path and report what it is, as a Tool may see it.
   *
   * ```text
   * resolveExisting()            succeeds → a kind
   * resolveExisting() throws     → MISSING, which the Tool maps to PATH_NOT_FOUND
   * ```
   *
   * The Runtime raises `RuntimePathNotFoundError` for an absent path, and a Tool is not allowed to
   * import that vocabulary to find out. Catching it here — inside the one directory permitted to know
   * the Runtime — is what turns "the Runtime said 404" into "the operation reports MISSING", which is a
   * fact a Coding Tool can act on without reaching across the boundary.
   *
   * A symlink is reported as `SYMLINK` and separately followed: a Tool decides from the *resolved*
   * entry whether the value is readable, which is what the legacy Tools did when they inspected both
   * `resolved.kind` and `resolved.metadata`.
   */
  async function resolveKind(
    scope: RuntimeWorkspaceScope,
    path: string,
  ): Promise<{ readonly resolved: ResolvedPathLike; readonly kind: CodingToolPathKind | "MISSING" }> {
    let resolved: ResolvedPathLike;
    try {
      resolved = (await scope.pathResolver.resolveExisting(path)) as ResolvedPathLike;
    } catch (error) {
      if (error instanceof RuntimePathNotFoundError) {
        return { resolved: missingPath(path), kind: "MISSING" };
      }
      throw error;
    }
    if (resolved.kind !== "SYMLINK") {
      return { resolved, kind: resolved.kind === "DIRECTORY" ? "DIRECTORY" : "FILE" };
    }
    const target = await scope.filesystem.getMetadata(resolved.realPath);
    if (target === null) return { resolved, kind: "MISSING" };
    return { resolved, kind: target.kind === "DIRECTORY" ? "DIRECTORY" : "FILE" };  }

  /** The shared directory read: resolve, kind-check and list, with no windowing applied. */
  async function readDirectory(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly path: string;
  }): Promise<{
    readonly path: string;
    readonly kind: CodingToolPathKind | "MISSING";
    readonly entries: readonly JsonObject[];
  }> {
    const scope = await resolveRuntimeWorkspace(resolver, input.environment);
    // A symlinked directory is inspected through its real target, so the kind check answers about
    // the thing the caller will actually read.
    const { resolved, kind } = await resolveKind(scope, input.path);
    if (kind === "MISSING") return { path: resolved.relativePath, kind, entries: [] };
    if (kind !== "DIRECTORY") return { path: resolved.relativePath, kind, entries: [] };
    const entries = await scope.filesystem.readDirectory(resolved.absolutePath);
    return {
      path: resolved.relativePath,
      kind,
      entries: entries.map((entry) => ({
        name: entry.name,
        path: resolved.relativePath === "." ? entry.name : `${resolved.relativePath}/${entry.name}`,
        kind: entry.kind,
      })),
    };
  }

  /** The shared file discovery: resolve the root, discover, then re-resolve each candidate. */
  async function discoverFiles(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly pattern: string;
    readonly path?: string;
    readonly limit: number;
  }): Promise<{
    readonly path: string;
    readonly files: readonly string[];
    readonly truncated: boolean;
  }> {
    const scope = await resolveRuntimeWorkspace(resolver, input.environment);
    const resolved = await scope.pathResolver.resolveExisting(input.path ?? ".");
    if (resolved.kind !== "DIRECTORY") {
      throw new RuntimeInvalidRangeError("search path is not a directory");
    }
    const discovered = await scope.discovery.find({
      cwd: resolved.absolutePath,
      pattern: input.pattern,
      limit: input.limit,
    });
    const files: string[] = [];
    for (const file of discovered.files) {
      const relative = resolved.relativePath === "." ? file : `${resolved.relativePath}/${file}`;
      const checked = await scope.pathResolver.resolveExisting(relative);
      // A discovered entry that no longer resolves to a file is dropped rather than reported: the
      // discovery result is a snapshot, and only a re-resolved regular file is safe to name.
      if (checked.kind === "FILE") files.push(checked.relativePath);
    }
    return { path: resolved.relativePath, files, truncated: discovered.truncated };
  }

  /** The shared text search: resolve the root, search with the include glob, verify every match. */
  async function searchTree(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly pattern: string;
    readonly path?: string;
    readonly include?: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly path: string;
    readonly matches: readonly JsonObject[];
    readonly truncated: boolean;
  }> {
    const scope = await resolveRuntimeWorkspace(resolver, input.environment);
    const resolved = await scope.pathResolver.resolveExisting(input.path ?? ".");
    if (resolved.kind !== "DIRECTORY") {
      throw new RuntimePathTypeError("path is not a directory");
    }
    // `include` goes to the Runtime, which turns it into ripgrep's `--glob`: a path-level pre-filter
    // applied before truncation. `limit` is the caller's business bound, so the Runtime is asked for one
    // more than that — the `N + 1` probe that makes "there were more matches" provable instead of
    // guessed.
    const result = await scope.textSearch.search({
      signal: input.signal,
      cwd: resolved.absolutePath,
      pattern: input.pattern,
      ...(input.include === undefined ? {} : { include: input.include }),
      limit: input.limit + 1,
    });
    const matches: JsonObjectLike[] = [];
    for (const match of result.matches.slice(0, input.limit)) {
      // The search backend is not trusted to stay inside the tree it was given.
      if (
        match.path.startsWith("/") ||
        /^[A-Za-z]:[\\/]/.test(match.path) ||
        match.path.split("/").includes("..")
      ) {
        throw new RuntimeInvariantError("search returned a path outside its search root");
      }
      const relative =
        resolved.relativePath === "." ? match.path : `${resolved.relativePath}/${match.path}`;
      const checked = await scope.pathResolver.resolveExisting(relative);
      if (checked.kind !== "FILE") {
        throw new RuntimeInvariantError("search returned a non-file result");
      }
      matches.push({ path: checked.relativePath, line: match.line, text: match.text });
    }
    return {
      path: resolved.relativePath,
      matches,
      truncated: result.truncated || result.matches.length > input.limit,
    };
  }

  /**
   * The shared file read, reporting what the path resolved to.
   *
   * Extracted from `read()` so `readFileWithKind()` and `read()` cannot disagree: both perform exactly
   * one resolution and one read, and they differ only in what they do with a path that is not a file.
   */
  async function readFile(
    input: Parameters<CodingReadOnlyOperations["readFileWithKind"]>[0],
  ): ReturnType<CodingReadOnlyOperations["readFileWithKind"]> {
    const scope = await resolveRuntimeWorkspace(resolver, input.environment);
    const { resolved, kind } = await resolveKind(scope, input.path);
    if (kind !== "FILE") return { path: resolved.relativePath, kind };
    const read = await scope.filesystem.readTextFile(resolved.absolutePath, {
      offset: input.offset,
      limit: input.limit,
      maxBytes: READ_FILE_MAX_BYTES,
    });
    // A window that starts past the end of the file is an invalid range rather than an empty read:
    // the caller asked for lines that cannot exist, and reporting "(empty file)" would be a lie.
    if (read.lines.length === 0 && input.offset > 1 && !read.truncated) {
      throw new RuntimeInvalidRangeError("line offset is outside the file");
    }
    return {
      path: resolved.relativePath,
      kind,
      read: {
        lines: read.lines,
        truncated: read.truncated,
        ...(read.nextOffset === undefined ? {} : { nextOffset: read.nextOffset }),
        bytesReturned: read.bytesReturned,
        utf8Bom: read.utf8Bom,
      },
    };
  }

  return {
    async read(input) {
      const read = await readFile(input);
      if (read.read === undefined) throw new RuntimePathTypeError("path is not a readable file");
      return { path: read.path, ...read.read };
    },

    readFileWithKind: readFile,

    async list(input) {
      const listed = await readDirectory(input);
      if (listed.kind === "MISSING") throw new RuntimePathNotFoundError("path does not exist");
      if (listed.kind !== "DIRECTORY") throw new RuntimePathTypeError("path is not a directory");
      const sliced = listed.entries.slice(0, input.limit);
      return {
        path: listed.path,
        entries: sliced,
        truncated: sliced.length < listed.entries.length,
      };
    },

    async listDirectoryWithKind(input) {      const listed = await readDirectory(input);
      if (listed.kind !== "DIRECTORY") return { path: listed.path, kind: listed.kind, entries: [] };
      return {
        path: listed.path,
        kind: listed.kind,
        entries: listed.entries.slice(0, input.limit),
      };
    },

    async listWithProbe(input: Parameters<CodingReadOnlyOperations["listDirectoryWithKind"]>[0]) {
      const listed = await readDirectory(input);
      return { path: listed.path, entries: listed.entries.slice(0, input.limit) };
    },

    async find(input) {
      const found = await discoverFiles(input);
      return { files: found.files, truncated: found.truncated };
    },

    findWithRoot: discoverFiles,

    async search(input) {
      const found = await searchTree(input);
      return { matches: found.matches, truncated: found.truncated };
    },

    searchWithRoot: searchTree,
  };
}

/**
 * The resolved-path shape this adapter uses structurally.
 *
 * It is declared here rather than imported because `RuntimePathResolver.resolveExisting`'s return type
 * is a broad internal record; what this file actually reads is `kind`, `realPath`, `absolutePath` and
 * `relativePath`, and stating that is what keeps the read honest.
 */
interface ResolvedPathLike {
  readonly kind: "FILE" | "DIRECTORY" | "SYMLINK" | "OTHER";
  readonly realPath: string;
  readonly absolutePath: string;
  readonly relativePath: string;
}

/** The placeholder a MISSING resolution carries, so a caller still receives a relative path. */
function missingPath(path: string): ResolvedPathLike {
  return { kind: "OTHER", realPath: path, absolutePath: path, relativePath: path };
}

/** The JSON-object shape the Operations returns carry. Structural, so no import is needed. */
type JsonObjectLike = { readonly path: string; readonly line: number; readonly text: string };
