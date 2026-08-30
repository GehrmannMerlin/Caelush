import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import type { WorkspacePathResolver } from "../workspace-path.js";
import { sanitizeTerminalOutput } from "../exec/terminal-output.js";
import { RuntimeGitError } from "../runtime-errors.js";
import { decode, assertGitRepository } from "./repository.js";
import {
  GIT_DIFF_CAPTURE_MAX_BYTES,
  GIT_DIFF_MODEL_MAX_BYTES,
  GIT_STATUS_DEFAULT_LIMIT,
  GIT_STATUS_MAX_LIMIT,
  type GitDiffResult,
  type GitDiffScope,
  type GitRunner,
  type GitStatusResult,
  type LocalGitServiceOptions,
  type RuntimeGitService,
} from "./contracts.js";
import { LocalGitRunner } from "./git-runner.js";
import { gitCommandError } from "./errors.js";
import { parseGitStatus } from "./status-parser.js";

const GIT_CONFIG_HARDENING = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
] as const;

export class LocalGitService implements RuntimeGitService {
  private readonly runner: GitRunner;
  private readonly pathResolver: WorkspacePathResolver;

  constructor(private readonly options: LocalGitServiceOptions) {
    this.runner = options.runner ?? new LocalGitRunner();
    this.pathResolver = options.pathResolver;
  }

  async status(input: {
    readonly path?: string;
    readonly limit?: number;
  }): Promise<GitStatusResult> {
    const limit = input.limit ?? GIT_STATUS_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > GIT_STATUS_MAX_LIMIT)
      throw new RuntimeGitError("INVALID_GIT_SCOPE");
    const path = this.resolvePath(input.path ?? ".");
    const repositoryRoot = await assertGitRepository(this.runner, this.options.logicalRoot);
    const result = await this.runner.run({
      cwd: this.options.logicalRoot,
      args: [
        ...GIT_CONFIG_HARDENING,
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
        "--ignore-submodules=all",
        "--no-renames",
        "--",
        path,
      ],
      maxOutputBytes: GIT_DIFF_CAPTURE_MAX_BYTES,
    });
    if (result.exitCode !== 0) throw gitCommandError(decode(result.stderr));
    if (result.stdoutTruncated) throw new RuntimeGitError("GIT_COMMAND_FAILED");
    const parsed = parseGitStatus(decodeStrict(result.stdout), limit);
    const prefix = pathModuleRelative(repositoryRoot, this.options.logicalRoot);
    const entries = parsed.entries.map((entry) => ({
      ...entry,
      path: prefix === "." ? entry.path : stripWorkspacePrefix(entry.path, prefix),
    }));
    if (entries.some((entry) => entry.path === "")) throw new RuntimeGitError("GIT_COMMAND_FAILED");
    return { ...parsed, entries };
  }

  async diff(input: {
    readonly scope?: GitDiffScope;
    readonly path?: string;
  }): Promise<GitDiffResult> {
    const scope = input.scope ?? "ALL";
    if (scope !== "WORKTREE" && scope !== "STAGED" && scope !== "ALL")
      throw new RuntimeGitError("INVALID_GIT_SCOPE");
    const path = this.resolvePath(input.path ?? ".");
    await assertGitRepository(this.runner, this.options.logicalRoot);
    const scopes = scope === "ALL" ? (["WORKTREE", "STAGED"] as const) : ([scope] as const);
    const chunks: string[] = [];
    let omittedBytes = 0;
    let truncated = false;
    let hadDecodeReplacement = false;
    for (const item of scopes) {
      const result = await this.runner.run({
        cwd: this.options.logicalRoot,
        args: [
          ...GIT_CONFIG_HARDENING,
          "diff",
          ...(item === "STAGED" ? ["--cached"] : []),
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--no-renames",
          "--relative",
          "--unified=3",
          "--",
          path,
        ],
        maxOutputBytes: GIT_DIFF_CAPTURE_MAX_BYTES,
      });
      if (result.exitCode !== 0) throw gitCommandError(decode(result.stderr));
      if (result.stdoutTruncated) truncated = true;
      const decoded = decodeLax(result.stdout);
      hadDecodeReplacement ||= decoded.hadDecodeReplacement;
      chunks.push(scope === "ALL" ? `=== ${item} ===\n${decoded.value}` : decoded.value);
      omittedBytes += result.stdoutOmittedBytes;
    }
    const raw = sanitizeTerminalOutput(chunks.join(scope === "ALL" ? "\n" : ""));
    const bounded = boundUtf8(raw, GIT_DIFF_MODEL_MAX_BYTES);
    return {
      scope,
      path,
      diff: bounded.value,
      truncated: truncated || bounded.truncated,
      bytesReturned: Buffer.byteLength(bounded.value, "utf8"),
      omittedBytes: omittedBytes + bounded.omittedBytes,
      hadDecodeReplacement,
    };
  }

  private resolvePath(value: string): string {
    try {
      return this.pathResolver.resolveLexical(value).relativePath;
    } catch {
      throw new RuntimeGitError("INVALID_GIT_PATH");
    }
  }
}

function decodeStrict(bytes: Uint8Array): string {
  const decoder = new StringDecoder("utf8");
  const value = decoder.write(Buffer.from(bytes)) + decoder.end();
  if (value.includes("\uFFFD")) throw new RuntimeGitError("GIT_UNSUPPORTED_PATH_ENCODING");
  return value;
}

function decodeLax(bytes: Uint8Array): {
  readonly value: string;
  readonly hadDecodeReplacement: boolean;
} {
  const decoder = new StringDecoder("utf8");
  const value = decoder.write(Buffer.from(bytes)) + decoder.end();
  return { value, hadDecodeReplacement: value.includes("\uFFFD") };
}

function boundUtf8(value: string, limit: number) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= limit) return { value, truncated: false, omittedBytes: 0 };
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const omittedBytes = bytes.byteLength - end;
  return {
    value: `${bytes.subarray(0, end).toString("utf8")}\n[diff truncated; ${omittedBytes} bytes omitted]`,
    truncated: true,
    omittedBytes,
  };
}

function pathModuleRelative(root: string, workspace: string): string {
  return path.relative(root, workspace).replaceAll(path.sep, "/") || ".";
}

function stripWorkspacePrefix(value: string, prefix: string): string {
  if (value === prefix) return ".";
  if (!value.startsWith(`${prefix}/`)) return "";
  return value.slice(prefix.length + 1);
}
