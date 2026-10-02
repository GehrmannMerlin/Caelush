import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalRuntime,
  RuntimeBoundaryError,
  RuntimePathNotFoundError,
  createLocalRuntimeResolver,
} from "../src/index.js";
import { createWorkspaceId } from "@caelush/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-runtime-path-"));
  const workspace = path.join(parent, "workspace");
  const outside = path.join(parent, "outside");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(workspace, "README.md"), "read me", "utf8");
  await writeFile(path.join(workspace, "src", "inside.ts"), "inside", "utf8");
  await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
  temporaryDirectories.push(parent);
  return { workspace, outside };
}

describe("LocalRuntime workspace scope", () => {
  it("resolves workspace-relative existing paths and preserves canonical model paths", async () => {
    const { workspace } = await fixture();
    const runtime = new LocalRuntime();
    const scope = await runtime.openWorkspace({ id: createWorkspaceId(), path: workspace });

    await expect(scope.pathResolver.resolveExisting("src/../README.md")).resolves.toMatchObject({
      relativePath: "README.md",
      kind: "FILE",
    });
    await expect(scope.pathResolver.resolveExisting(".")).resolves.toMatchObject({
      relativePath: ".",
      kind: "DIRECTORY",
    });
  });

  it("rejects absolute-like, traversal and missing paths", async () => {
    const { workspace } = await fixture();
    const scope = await new LocalRuntime().openWorkspace({
      id: createWorkspaceId(),
      path: workspace,
    });

    await expect(scope.pathResolver.resolveExisting("../secret.txt")).rejects.toBeInstanceOf(
      RuntimeBoundaryError,
    );
    await expect(
      scope.pathResolver.resolveExisting("C:\\Windows\\system.ini"),
    ).rejects.toBeInstanceOf(RuntimeBoundaryError);
    await expect(
      scope.pathResolver.resolveExisting("\\\\server\\share\\file"),
    ).rejects.toBeInstanceOf(RuntimeBoundaryError);
    await expect(scope.pathResolver.resolveExisting("missing.txt")).rejects.toBeInstanceOf(
      RuntimePathNotFoundError,
    );
    await expect(scope.pathResolver.resolveExisting("README.md\0bad")).rejects.toBeInstanceOf(
      RuntimeBoundaryError,
    );
  });

  it("allows an internal symlink and rejects an external symlink", async ({ skip }) => {
    const { workspace, outside } = await fixture();
    const internalLink = path.join(workspace, "inside-link.ts");
    const externalLink = path.join(workspace, "outside-link.txt");
    try {
      await symlink(path.join(workspace, "src", "inside.ts"), internalLink);
      await symlink(path.join(outside, "secret.txt"), externalLink);
    } catch (error) {
      skip(
        `symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // A resolved `symlink()` is not evidence that a link exists: a host without the privilege, or a
    // sandbox that emulates links, can report success while materialising an ordinary entry, and the
    // SYMLINK assertion below would then be measuring a plain file. Measure the precondition instead
    // of assuming it (Finding N5, the remedy Task 5 applied to the other two fixtures).
    const linksAreReal =
      (await lstat(internalLink)).isSymbolicLink() && (await lstat(externalLink)).isSymbolicLink();
    if (!linksAreReal) {
      skip("the host reported success but produced no symbolic link (readlink would fail)");
    }
    const scope = await new LocalRuntime().openWorkspace({
      id: createWorkspaceId(),
      path: workspace,
    });

    await expect(scope.pathResolver.resolveExisting("inside-link.ts")).resolves.toMatchObject({
      kind: "SYMLINK",
    });
    await expect(scope.pathResolver.resolveExisting("outside-link.txt")).rejects.toBeInstanceOf(
      RuntimeBoundaryError,
    );
  });

  it("resolves only the supported local runtime kind", () => {
    const runtime = new LocalRuntime();
    const resolver = createLocalRuntimeResolver(runtime);
    expect(resolver.resolve({ id: "local", kind: "local" })).toBe(runtime);
    expect(resolver.resolve({ id: "remote", kind: "ssh" })).toBeUndefined();
  });
});
