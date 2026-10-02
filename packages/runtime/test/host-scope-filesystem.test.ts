import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import {
  LocalRuntime,
  createRuntimeFilesystemPolicy,
  RuntimeFilesystemAccessDeniedError,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-host-scope-"));
  const workspace = path.join(parent, "workspace");
  const outside = path.join(parent, "outside");
  const protectedRoot = path.join(parent, "protected");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(protectedRoot, { recursive: true });
  await writeFile(path.join(workspace, "inside.txt"), "inside\n", "utf8");
  await writeFile(path.join(outside, "external.txt"), "external\n", "utf8");
  await writeFile(path.join(protectedRoot, "locked.txt"), "locked\n", "utf8");
  temporaryDirectories.push(parent);
  return { parent, workspace, outside, protectedRoot };
}

function policy(
  workspace: string,
  hostUserRoot: string,
  boundary: "WORKSPACE_READ_ONLY" | "WORKSPACE_READ_WRITE" | "HOST_USER_SCOPE",
  protectedRoots: readonly string[] = [],
) {
  return createRuntimeFilesystemPolicy({
    workspaceId: createWorkspaceId(),
    workspaceRoot: workspace,
    hostUserRoot,
    boundary,
    protectedRoots,
  });
}

function workspaceRef(workspace: string, id: ReturnType<typeof createWorkspaceId>) {
  return { id, path: workspace };
}

function updatePatch(filePath: string, before: string, after: string): string {
  return [
    "*** Begin Patch",
    `*** Update File: ${filePath.replaceAll("\\", "/")}`,
    "@@",
    `-${before}`,
    `+${after}`,
    "*** End Patch",
  ].join("\n");
}

describe("policy-aware host filesystem scope", () => {
  it("classifies and reads an external host-user target only in Full Access", async () => {
    const { parent, workspace, outside } = await fixture();
    const workspaceId = createWorkspaceId();
    const runtime = new LocalRuntime();
    const scope = await runtime.openWorkspace(workspaceRef(workspace, workspaceId), {
      filesystemPolicy: {
        ...policy(workspace, parent, "HOST_USER_SCOPE"),
        workspaceId,
      },
    });
    const target = await scope.pathResolver.resolveFilesystemTarget({
      path: path.join(outside, "external.txt"),
      policy: scope.filesystemPolicy,
      operation: "READ",
    });

    expect(target).toMatchObject({ relation: "HOST_USER", kind: "FILE", indirection: "DIRECT" });
    await expect(
      scope.filesystem.readTextFile(target.absolutePath, { offset: 0, limit: 10, maxBytes: 1024 }),
    ).resolves.toMatchObject({ lines: ["1: external"] });
    await runtime.dispose();
  });

  it("rejects an external target under workspace-only policies", async () => {
    const { parent, workspace, outside } = await fixture();
    const workspaceId = createWorkspaceId();
    const runtime = new LocalRuntime();
    const scope = await runtime.openWorkspace(workspaceRef(workspace, workspaceId), {
      filesystemPolicy: {
        ...policy(workspace, parent, "WORKSPACE_READ_WRITE"),
        workspaceId,
      },
    });

    await expect(
      scope.pathResolver.resolveFilesystemTarget({
        path: path.join(outside, "external.txt"),
        policy: scope.filesystemPolicy,
        operation: "READ",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "PATH_OUTSIDE_WORKSPACE" }));
    await runtime.dispose();
  });

  it("denies writes in View Only before patch mutation", async () => {
    const { parent, workspace } = await fixture();
    const workspaceId = createWorkspaceId();
    const runtime = new LocalRuntime();
    const scope = await runtime.openWorkspace(workspaceRef(workspace, workspaceId), {
      filesystemPolicy: {
        ...policy(workspace, parent, "WORKSPACE_READ_ONLY"),
        workspaceId,
      },
    });

    await expect(
      scope.patch.apply({
        patch: updatePatch("inside.txt", "inside", "changed"),
      }),
    ).rejects.toBeInstanceOf(RuntimeFilesystemAccessDeniedError);
    await expect(readFile(path.join(workspace, "inside.txt"), "utf8")).resolves.toBe("inside\n");
    await runtime.dispose();
  });

  it("allows Full Access external patching but blocks protected roots", async () => {
    const { parent, workspace, outside, protectedRoot } = await fixture();
    const workspaceId = createWorkspaceId();
    const runtime = new LocalRuntime();
    const scope = await runtime.openWorkspace(workspaceRef(workspace, workspaceId), {
      filesystemPolicy: {
        ...policy(workspace, parent, "HOST_USER_SCOPE", [protectedRoot]),
        workspaceId,
      },
    });
    const externalFile = path.join(outside, "external.txt");

    await expect(
      scope.patch.apply({ patch: updatePatch(externalFile, "external", "edited") }),
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(externalFile, "utf8")).resolves.toBe("edited\n");
    await expect(
      scope.patch.apply({
        patch: updatePatch(path.join(protectedRoot, "locked.txt"), "locked", "tampered"),
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "PROTECTED_ROOT_MUTATION" }));
    await expect(readFile(path.join(protectedRoot, "locked.txt"), "utf8")).resolves.toBe(
      "locked\n",
    );
    await runtime.dispose();
  });

  it("admits a patch as one unit and performs no mutation when one target is protected", async () => {
    const { parent, workspace, protectedRoot } = await fixture();
    const workspaceId = createWorkspaceId();
    const runtime = new LocalRuntime();
    const scope = await runtime.openWorkspace(workspaceRef(workspace, workspaceId), {
      filesystemPolicy: {
        ...policy(workspace, parent, "HOST_USER_SCOPE", [protectedRoot]),
        workspaceId,
      },
    });

    await expect(
      scope.patch.apply({
        patch: [
          "*** Begin Patch",
          "*** Update File: inside.txt",
          "@@",
          "-inside",
          "+changed",
          `*** Update File: ${path.join(protectedRoot, "locked.txt").replaceAll("\\", "/")}`,
          "@@",
          "-locked",
          "+tampered",
          "*** End Patch",
        ].join("\n"),
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "PROTECTED_ROOT_MUTATION" }));
    await expect(readFile(path.join(workspace, "inside.txt"), "utf8")).resolves.toBe("inside\n");
    await expect(readFile(path.join(protectedRoot, "locked.txt"), "utf8")).resolves.toBe(
      "locked\n",
    );
    await runtime.dispose();
  });

  it("admits a symlink target for read only when its canonical target stays in scope", async ({
    skip,
  }) => {
    const { parent, workspace, outside } = await fixture();
    const linkPath = path.join(workspace, "external-link.txt");
    try {
      await symlink(path.join(outside, "external.txt"), linkPath);
    } catch (error) {
      skip(
        `symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // A resolved `symlink()` is not evidence that a link exists: a host without the privilege, or a
    // sandbox that emulates links, can report success while materialising an ordinary entry, and every
    // assertion below then measures a plain file. Measure the precondition instead of assuming it.
    if (!(await lstat(linkPath)).isSymbolicLink()) {
      skip("the host reported success but produced no symbolic link (readlink would fail)");
    }
    const workspaceId = createWorkspaceId();
    const runtime = new LocalRuntime();
    const restricted = await runtime.openWorkspace(workspaceRef(workspace, workspaceId), {
      filesystemPolicy: {
        ...policy(workspace, parent, "WORKSPACE_READ_WRITE"),
        workspaceId,
      },
    });
    await expect(restricted.pathResolver.resolveExisting("external-link.txt")).rejects.toThrowError(
      expect.objectContaining({ code: "PATH_OUTSIDE_WORKSPACE" }),
    );

    const full = await runtime.openWorkspace(workspaceRef(workspace, workspaceId), {
      filesystemPolicy: {
        ...policy(workspace, parent, "HOST_USER_SCOPE"),
        workspaceId,
      },
    });
    await expect(full.pathResolver.resolveExisting("external-link.txt")).resolves.toMatchObject({
      kind: "SYMLINK",
      relativePath: "external-link.txt",
    });
    await expect(
      full.patch.apply({ patch: updatePatch("external-link.txt", "external", "unsafe") }),
    ).rejects.toThrowError(expect.objectContaining({ code: "SYMLINK_MUTATION_NOT_ALLOWED" }));
    await runtime.dispose();
  });
});
