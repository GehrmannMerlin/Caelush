import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import { LocalRuntime, RuntimePatchError } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("mutation path boundaries", () => {
  it("allows missing targets under real workspace ancestors and rejects symlink sources/ancestors", async ({
    skip,
  }) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-patch-path-"));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, "workspace");
    const outside = path.join(parent, "outside");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(workspace, "src", "file.txt"), "content");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    try {
      await symlink(path.join(workspace, "src"), path.join(workspace, "linked-dir"));
      await symlink(path.join(outside, "secret.txt"), path.join(workspace, "linked-file.txt"));
    } catch (error) {
      skip(
        `symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const scope = await new LocalRuntime().openWorkspace({
      id: createWorkspaceId(),
      path: workspace,
    });

    await expect(
      scope.pathResolver.resolveMutationTarget("new/deep/file.txt"),
    ).resolves.toMatchObject({
      relativePath: "new/deep/file.txt",
      metadata: null,
    });
    await expect(scope.pathResolver.resolveMutationTarget("linked-file.txt")).rejects.toThrowError(
      expect.objectContaining({ code: "SYMLINK_MUTATION_NOT_ALLOWED" }),
    );
    await expect(
      scope.pathResolver.resolveMutationTarget("linked-dir/new.txt"),
    ).rejects.toThrowError(expect.objectContaining({ code: "SYMLINK_MUTATION_NOT_ALLOWED" }));
  });
});
