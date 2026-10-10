import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceId } from "@caelush/protocol";
import type { DesktopWorkspaceFileService } from "../workspace/file-service.js";
import {
  DesktopWorkspaceError,
  normalizeRelativePath,
  resolveWorkspaceFilePath as resolveSafeWorkspaceFilePath,
} from "../workspace/file-service.js";

export type DesktopEditorId = "vscode" | "cursor";

export interface DesktopEditorDescriptor {
  readonly id: DesktopEditorId;
  readonly name: "Visual Studio Code" | "Cursor";
}

export type DesktopEditorErrorCode =
  "EDITOR_UNAVAILABLE" | "EDITOR_PATH_UNSAFE" | "EDITOR_LAUNCH_FAILED" | "EDITOR_TARGET_INVALID";

export class DesktopEditorError extends Error {
  constructor(
    readonly code: DesktopEditorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DesktopEditorError";
  }
}

export interface DesktopEditorResolverOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly workspaceFiles: Pick<DesktopWorkspaceFileService, "withWorkspace">;
  readonly spawn?: (
    executable: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly detached: boolean;
      readonly shell: false;
      readonly stdio: "ignore";
      readonly windowsHide: true;
    },
  ) => Pick<ChildProcess, "on" | "unref">;
}

interface InstalledEditor extends DesktopEditorDescriptor {
  readonly executablePath: string;
}

export class DesktopEditorResolver {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: DesktopEditorResolverOptions) {
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
  }

  async listEditors(): Promise<readonly DesktopEditorDescriptor[]> {
    const installed = await this.findInstalledEditors();
    return installed.map(({ id, name }) => ({ id, name }));
  }

  async openInEditor(
    input: {
      readonly editorId: DesktopEditorId;
      readonly workspaceId: WorkspaceId;
      readonly relativeFilePath?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly opened: true; readonly editorId: DesktopEditorId }> {
    if (this.platform !== "win32") {
      throw new DesktopEditorError(
        "EDITOR_UNAVAILABLE",
        "External editors are unavailable on this platform.",
      );
    }
    const editor = (await this.findInstalledEditors()).find(({ id }) => id === input.editorId);
    if (editor === undefined) {
      throw new DesktopEditorError("EDITOR_UNAVAILABLE", "This editor is not installed.");
    }
    try {
      return await this.options.workspaceFiles.withWorkspace(
        input.workspaceId,
        signal,
        async (access) => {
          let targetFilePath: string | undefined;
          if (input.relativeFilePath !== undefined) {
            const relativeFilePath = normalizeRelativePath(input.relativeFilePath, this.platform);
            targetFilePath = await resolveSafeWorkspaceFilePath(
              access.rootPath,
              relativeFilePath,
              this.platform,
            );
          }
          const args = ["--reuse-window"];
          if (targetFilePath !== undefined) args.push("--goto", `${targetFilePath}:1:1`);
          args.push(access.rootPath);
          if (signal?.aborted || access.signal.aborted) {
            throw new DesktopEditorError(
              "EDITOR_TARGET_INVALID",
              "The Desktop authorization changed before the editor could open.",
            );
          }
          await launchEditor(
            this.options.spawn ?? defaultSpawn,
            editor.executablePath,
            args,
            access.rootPath,
          );
          return { opened: true, editorId: editor.id } as const;
        },
      );
    } catch (error) {
      if (error instanceof DesktopEditorError || error instanceof DesktopWorkspaceError)
        throw error;
      throw new DesktopEditorError(
        "EDITOR_TARGET_INVALID",
        "The selected Workspace or file is unavailable.",
      );
    }
  }

  private async findInstalledEditors(): Promise<readonly InstalledEditor[]> {
    if (this.platform !== "win32") return [];
    const roots: Readonly<Record<DesktopEditorId, readonly string[]>> = {
      vscode: uniquePaths([
        joinEnvironment(this.environment.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
        joinEnvironment(this.environment.ProgramFiles, "Microsoft VS Code", "Code.exe"),
        joinEnvironment(this.environment["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe"),
        ...resolveVsCodePathEntries(this.environment),
      ]),
      cursor: uniquePaths([
        joinEnvironment(this.environment.LOCALAPPDATA, "Programs", "Cursor", "Cursor.exe"),
        joinEnvironment(this.environment.ProgramFiles, "Cursor", "Cursor.exe"),
        joinEnvironment(this.environment["ProgramFiles(x86)"], "Cursor", "Cursor.exe"),
      ]),
    };
    const result: InstalledEditor[] = [];
    const definitions: readonly DesktopEditorDescriptor[] = [
      { id: "vscode", name: "Visual Studio Code" },
      { id: "cursor", name: "Cursor" },
    ];
    for (const definition of definitions) {
      for (const candidate of roots[definition.id]) {
        const executablePath = await verifyEditorExecutable(candidate, this.platform);
        if (executablePath === null) continue;
        result.push({ ...definition, executablePath });
        break;
      }
    }
    return result;
  }
}

export async function resolveWorkspaceFilePath(
  rootPath: string,
  relativeFilePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  try {
    return await resolveWorkspaceFilePathInternal(rootPath, relativeFilePath, platform);
  } catch (error) {
    if (error instanceof DesktopWorkspaceError) {
      throw new DesktopEditorError(
        "EDITOR_TARGET_INVALID",
        "The selected file is unavailable in this Workspace.",
      );
    }
    throw error;
  }
}

async function resolveWorkspaceFilePathInternal(
  rootPath: string,
  relativeFilePath: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const relative = normalizeRelativePath(relativeFilePath, platform);
  if (relative === "") throw new DesktopWorkspaceError("PATH_INVALID", "A file path is required.");
  const target = await resolveSafeWorkspaceFilePath(rootPath, relative, platform);
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new DesktopWorkspaceError("PATH_NOT_FILE", "The selected item is not a regular file.");
  }
  const canonical = await realpath(target);
  const relativeToRoot = pathApi.relative(pathApi.resolve(rootPath), pathApi.resolve(canonical));
  if (relativeToRoot.startsWith("..") || pathApi.isAbsolute(relativeToRoot)) {
    throw new DesktopWorkspaceError(
      "PATH_REPARSE_POINT",
      "The selected file escapes the Workspace root.",
    );
  }
  return target;
}

async function verifyEditorExecutable(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  try {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
    const canonical = await realpath(candidate);
    const implementation = platform === "win32" ? path.win32 : path.posix;
    const parent = implementation.dirname(candidate);
    const relative = implementation.relative(parent, canonical);
    if (relative.startsWith("..") || implementation.isAbsolute(relative)) return null;
    return canonical;
  } catch {
    return null;
  }
}

function joinEnvironment(base: string | undefined, ...segments: string[]): string | undefined {
  if (base === undefined || base.trim().length === 0) return undefined;
  return path.win32.join(base, ...segments);
}

function uniquePaths(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function resolveVsCodePathEntries(environment: NodeJS.ProcessEnv): readonly string[] {
  const pathValue = Object.entries(environment).find(
    ([name]) => name.toLowerCase() === "path",
  )?.[1];
  if (pathValue === undefined) return [];
  const candidates: string[] = [];
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/gu, "");
    if (directory.length === 0 || !path.win32.isAbsolute(directory)) continue;
    const normalized = path.win32.normalize(directory);
    if (path.win32.basename(normalized).toLowerCase() !== "bin") continue;
    candidates.push(path.win32.join(path.win32.dirname(normalized), "Code.exe"));
  }
  return candidates;
}

function defaultSpawn(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly detached: boolean;
    readonly shell: false;
    readonly stdio: "ignore";
    readonly windowsHide: true;
  },
): Pick<ChildProcess, "on" | "unref"> {
  return nodeSpawn(executable, [...args], { ...options, windowsHide: true });
}

function launchEditor(
  spawnEditor: NonNullable<DesktopEditorResolverOptions["spawn"]>,
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child: Pick<ChildProcess, "on" | "unref">;
    try {
      child = spawnEditor(executable, args, {
        cwd,
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      reject(new DesktopEditorError("EDITOR_LAUNCH_FAILED", "The editor could not be started."));
      return;
    }
    child.on("error", () => {
      if (settled) return;
      settled = true;
      reject(new DesktopEditorError("EDITOR_LAUNCH_FAILED", "The editor could not be started."));
    });
    child.on("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}
