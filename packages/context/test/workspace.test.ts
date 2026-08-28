import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import {
  ContextBoundaryError,
  ContextInvalidWorkspaceError,
} from "../src/errors.js";
import { LocalContextFileSystem } from "../src/filesystem.js";
import { WorkspaceScopeResolver } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ workspace: string; outside: string }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-context-workspace-"));
  const workspace = path.join(parent, "workspace");
  const outside = path.join(parent, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  temporaryDirectories.push(parent);
  return { workspace, outside };
}

function workspaceRef(workspace: string) {
  return { id: createWorkspaceId(), path: workspace };
}

describe("WorkspaceScopeResolver", () => {
  it("resolves the workspace and defaults cwd to its root", async () => {
    const { workspace } = await fixture();
    const scope = await new WorkspaceScopeResolver(new LocalContextFileSystem()).resolve(
      workspaceRef(workspace),
    );

    expect(scope.logicalRoot).toBe(path.resolve(workspace));
    expect(scope.cwd).toBe(path.resolve(workspace));
    expect(scope.realRoot).toBe(await new LocalContextFileSystem().realpath(workspace));
    expect(scope.realCwd).toBe(scope.realRoot);
  });

  it("resolves relative and absolute cwd values inside the workspace", async () => {
    const { workspace } = await fixture();
    await mkdir(path.join(workspace, "packages", "app"), { recursive: true });
    const resolver = new WorkspaceScopeResolver(new LocalContextFileSystem());
    const ref = workspaceRef(workspace);

    await expect(resolver.resolve(ref, "packages/app")).resolves.toMatchObject({
      cwd: path.join(workspace, "packages", "app"),
    });
    await expect(resolver.resolve(ref, path.join(workspace, "packages/app"))).resolves.toMatchObject({
      cwd: path.join(workspace, "packages", "app"),
    });
  });

  it("rejects cwd escapes through relative and absolute paths", async () => {
    const { workspace, outside } = await fixture();
    const resolver = new WorkspaceScopeResolver(new LocalContextFileSystem());
    const ref = workspaceRef(workspace);

    await expect(resolver.resolve(ref, "../outside")).rejects.toBeInstanceOf(ContextBoundaryError);
    await expect(resolver.resolve(ref, outside)).rejects.toBeInstanceOf(ContextBoundaryError);
  });

  it("rejects missing and non-directory workspace paths", async () => {
    const { workspace } = await fixture();
    const resolver = new WorkspaceScopeResolver(new LocalContextFileSystem());
    const ref = workspaceRef(workspace);

    await expect(
      resolver.resolve({ ...ref, path: path.join(workspace, "missing") }),
    ).rejects.toBeInstanceOf(ContextInvalidWorkspaceError);
    const filePath = path.join(workspace, "file");
    await writeFile(filePath, "file", "utf8");
    await expect(resolver.resolve({ ...ref, path: filePath })).rejects.toBeInstanceOf(
      ContextInvalidWorkspaceError,
    );
  });

  it("rejects a cwd symlink that resolves outside the workspace", async ({ skip }) => {
    const { workspace, outside } = await fixture();
    const link = path.join(workspace, "link");
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const resolver = new WorkspaceScopeResolver(new LocalContextFileSystem());

    await expect(resolver.resolve(workspaceRef(workspace), "link")).rejects.toBeInstanceOf(
      ContextBoundaryError,
    );
  });
});
