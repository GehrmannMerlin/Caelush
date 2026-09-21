import type { ToolExecutionEnvironment } from "@caelush/agent";

/**
 * Discover workspace files by glob.
 *
 * ```ts
 * export interface FindFilesOperations {
 *   find(input: {
 *     readonly environment: ToolExecutionEnvironment;
 *     readonly pattern: string;
 *     readonly path?: string;
 *     readonly limit: number;
 *     readonly signal: AbortSignal;
 *   }): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>;
 * }
 * ```
 *
 * `files` are **workspace-relative** and use forward slashes, in the discovery's stable order. The
 * adapter resolves `path` (defaulting to the workspace root) into a real search root and filters the
 * discovered entries back down to resolvable files, so a symlink that escapes the workspace cannot
 * appear in the result.
 *
 * `pattern` is a glob, and it is validated by the **Tool** before it reaches this port: an absolute
 * pattern or one containing `..` is a Tool-level `INVALID_PATTERN` failure, and the port is not asked
 * to defend against it a second time.
 */
export interface FindFilesOperations {
  find(input: {
    readonly environment: ToolExecutionEnvironment;

    readonly pattern: string;

    readonly path?: string;

    readonly limit: number;

    readonly signal: AbortSignal;
  }): Promise<{
    readonly files: readonly string[];

    readonly truncated: boolean;
  }>;
}
