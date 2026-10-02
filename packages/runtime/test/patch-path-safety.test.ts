import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import { LocalRuntime } from "../src/index.js";
import { createLocalPatchMutationFileSystem } from "../src/patch/committer.js";

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
    const linkedDir = path.join(workspace, "linked-dir");
    const linkedFile = path.join(workspace, "linked-file.txt");
    try {
      await symlink(path.join(workspace, "src"), linkedDir);
      await symlink(path.join(outside, "secret.txt"), linkedFile);
    } catch (error) {
      skip(
        `symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // A resolved `symlink()` is not evidence that a link exists. A host without the privilege, or a
    // sandbox that emulates links, can report success while materialising an ordinary entry; the
    // assertions below would then be measuring a plain file and reporting a boundary defect that is
    // not there. Measure the precondition instead of assuming it.
    const linksAreReal =
      (await lstat(linkedDir)).isSymbolicLink() && (await lstat(linkedFile)).isSymbolicLink();
    if (!linksAreReal) {
      skip("the host reported success but produced no symbolic link (readlink would fail)");
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
    await expect(
      createLocalPatchMutationFileSystem(workspace).writePatchFile(
        path.join(workspace, "linked-dir", "new.txt"),
        new TextEncoder().encode("unsafe"),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "SYMLINK_MUTATION_NOT_ALLOWED" }));
  });
});
