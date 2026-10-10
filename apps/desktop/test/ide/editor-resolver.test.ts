import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createWorkspaceId } from "@caelush/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopEditorResolver } from "../../src/main/ide/editor-resolver.js";

const roots: string[] = [];
const workspaceId = createWorkspaceId();

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-d5-ide-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop external editor resolver", () => {
  it("lists only verified VS Code and Cursor executables in known install roots", async () => {
    const root = await makeRoot();
    const codeDirectory = path.join(root, "Programs", "Microsoft VS Code");
    const cursorDirectory = path.join(root, "Programs", "Cursor");
    await mkdir(codeDirectory, { recursive: true });
    await mkdir(cursorDirectory, { recursive: true });
    await writeFile(path.join(codeDirectory, "Code.exe"), "fixture");
    await writeFile(path.join(cursorDirectory, "Cursor.exe"), "fixture");
    const resolver = new DesktopEditorResolver({
      environment: { LOCALAPPDATA: root },
      platform: "win32",
      workspaceFiles: {} as never,
      spawn: vi.fn(() => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("spawn"));
        return child as never;
      }),
    });

    const editors = await resolver.listEditors();

    expect(editors.map((editor) => editor.id)).toEqual(["vscode", "cursor"]);
  });

  it("resolves VS Code installed beside a CLI bin entry in PATH", async () => {
    const root = await makeRoot();
    const installRoot = path.join(root, "Microsoft VS Code");
    const binDirectory = path.join(installRoot, "bin");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(path.join(installRoot, "Code.exe"), "fixture");
    await writeFile(path.join(binDirectory, "code.cmd"), "@echo off");
    const resolver = new DesktopEditorResolver({
      environment: { Path: binDirectory },
      platform: "win32",
      workspaceFiles: {} as never,
      spawn: vi.fn(),
    });

    expect(await resolver.listEditors()).toEqual([{ id: "vscode", name: "Visual Studio Code" }]);
  });

  it("passes Workspace and optional file as separate argv without a shell", async () => {
    const root = await makeRoot();
    const installRoot = path.join(root, "Programs", "Microsoft VS Code");
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(installRoot, { recursive: true });
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(installRoot, "Code.exe"), "fixture");
    await writeFile(path.join(workspaceRoot, "src", "hello world.ts"), "export {};");
    const spawn = vi.fn((_executable: string, _args: readonly string[], _options: unknown) => {
      const child = new EventEmitter();
      Object.assign(child, { unref: vi.fn() });
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    });
    const resolver = new DesktopEditorResolver({
      environment: { LOCALAPPDATA: root },
      platform: "win32",
      workspaceFiles: {
        withWorkspace: async (
          _id: string,
          _signal: AbortSignal | undefined,
          action: (value: unknown) => Promise<unknown>,
        ) =>
          action({
            workspaceId,
            rootPath: workspaceRoot,
            userId: "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857",
            profileId: `u_${"a".repeat(64)}`,
            generationId: "9f16de4b-87a8-4f34-9504-a9a55e4f3d32",
            signal: new AbortController().signal,
          }),
      } as never,
      spawn,
    });

    await resolver.openInEditor({
      editorId: "vscode",
      workspaceId,
      relativeFilePath: "src/hello world.ts",
    });

    const [executable, args, options] = spawn.mock.calls[0]!;
    expect(executable).toBe(path.join(installRoot, "Code.exe"));
    expect(args).toEqual([
      "--reuse-window",
      "--goto",
      `${path.join(workspaceRoot, "src", "hello world.ts")}:1:1`,
      workspaceRoot,
    ]);
    expect(options).toMatchObject({ shell: false, windowsHide: true });
  });

  it("returns unavailable instead of claiming an editor that is not installed", async () => {
    const resolver = new DesktopEditorResolver({
      environment: {},
      platform: "win32",
      workspaceFiles: {} as never,
      spawn: vi.fn(),
    });

    expect(await resolver.listEditors()).toEqual([]);
    await expect(resolver.openInEditor({ editorId: "cursor", workspaceId })).rejects.toMatchObject({
      code: "EDITOR_UNAVAILABLE",
    });
  });
});
