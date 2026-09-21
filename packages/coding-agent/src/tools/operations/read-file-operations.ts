import type { ToolExecutionEnvironment } from "@caelush/agent";

/**
 * Read bounded UTF-8 text from one workspace file.
 *
 * ```ts
 * export interface ReadFileOperations {
 *   read(input: {
 *     readonly environment: ToolExecutionEnvironment;
 *     readonly path: string;
 *     readonly offset: number;
 *     readonly limit: number;
 *     readonly signal: AbortSignal;
 *   }): Promise<{
 *     readonly path: string;
 *     readonly lines: readonly string[];
 *     readonly truncated: boolean;
 *     readonly nextOffset?: number;
 *     readonly bytesReturned: number;
 *     readonly utf8Bom: boolean;
 *   }>;
 * }
 * ```
 *
 * ## What the Tool gets back, and what it does not
 *
 * `path` is the **workspace-relative** path the file was resolved to. The Tool never sees a host
 * absolute path: the adapter resolves the relative path through the Runtime's path resolver, reads
 * through the workspace scope, and returns only the safe relative form. A Tool that cannot name an
 * absolute path cannot leak one into model content either.
 *
 * `lines` are the requested 1-indexed window; `nextOffset` is present exactly when more lines follow;
 * `utf8Bom` reports a stripped byte-order mark; `bytesReturned` is the raw byte count of the returned
 * text, so a caller can budget without re-measuring.
 *
 * ## What is deliberately absent
 *
 * There is no `RuntimeResolver`, no `absolutePath`, no `scope`, no `filesystem` and no `maxBytes`
 * input. The byte bound is the operation's own business: a caller that could set it could make one Tool
 * read an unbounded file, and the bound exists precisely so that no Tool can.
 */
export interface ReadFileOperations {
  read(input: {
    readonly environment: ToolExecutionEnvironment;

    readonly path: string;

    readonly offset: number;

    readonly limit: number;

    readonly signal: AbortSignal;
  }): Promise<{
    readonly path: string;

    readonly lines: readonly string[];

    readonly truncated: boolean;

    readonly nextOffset?: number;

    readonly bytesReturned: number;

    readonly utf8Bom: boolean;
  }>;
}
