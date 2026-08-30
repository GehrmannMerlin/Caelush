import type { WorkspacePathResolver } from "../workspace-path.js";

export const GIT_EXECUTABLE = "git";
export const GIT_STATUS_DEFAULT_LIMIT = 200;
export const GIT_STATUS_MAX_LIMIT = 1000;
export const GIT_DIFF_CAPTURE_MAX_BYTES = 1024 * 1024;
export const GIT_DIFF_MODEL_MAX_BYTES = 48 * 1024;

export type GitEntryKind = "TRACKED" | "UNTRACKED" | "UNMERGED";

export interface GitStatusEntry {
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly kind: GitEntryKind;
}

export interface GitStatusResult {
  readonly branch?: string;
  readonly detached: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly clean: boolean;
  readonly entries: readonly GitStatusEntry[];
  readonly truncated: boolean;
}

export type GitDiffScope = "WORKTREE" | "STAGED" | "ALL";

export interface GitDiffResult {
  readonly scope: GitDiffScope;
  readonly path: string;
  readonly diff: string;
  readonly truncated: boolean;
  readonly bytesReturned: number;
  readonly omittedBytes: number;
  readonly hadDecodeReplacement: boolean;
}

export interface RuntimeGitService {
  status(input: { readonly path?: string; readonly limit?: number; readonly signal?: AbortSignal }): Promise<GitStatusResult>;
  diff(input: { readonly scope?: GitDiffScope; readonly path?: string; readonly signal?: AbortSignal }): Promise<GitDiffResult>;
}

export interface LocalGitServiceOptions {
  readonly logicalRoot: string;
  readonly pathResolver: WorkspacePathResolver;
  readonly runner?: GitRunner;
}

export interface GitRunner {
  run(input: {
    readonly cwd: string;
    readonly args: readonly string[];
    readonly maxOutputBytes?: number;
    readonly signal?: AbortSignal;
  }): Promise<GitRunnerResult>;
}

export interface GitRunnerResult {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutOmittedBytes: number;
  readonly stderrOmittedBytes: number;
}
