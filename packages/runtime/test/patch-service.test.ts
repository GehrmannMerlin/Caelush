import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function scopeFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-patch-service-"));
  temporaryDirectories.push(parent);
  const workspace = path.join(parent, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "old.txt"), "old\n");
  return new LocalRuntime().openWorkspace({ id: createWorkspaceId(), path: workspace });
}

describe("RuntimePatchService", () => {
  it("applies add, update, move, and delete through one verified runtime capability", async () => {
    const scope = await scopeFixture();
    await expect(
      scope.patch.apply({
        patch: ["*** Begin Patch", "*** Add File: new.txt", "+new", "*** End Patch"].join("\n"),
      }),
    ).resolves.toMatchObject({ ok: true, changes: [{ kind: "ADD", path: "new.txt" }] });
    await expect(
      scope.patch.apply({
        patch: [
          "*** Begin Patch",
          "*** Update File: old.txt",
          "@@",
          "-old",
          "+updated",
          "*** End Patch",
        ].join("\n"),
      }),
    ).resolves.toMatchObject({ ok: true, changes: [{ kind: "UPDATE", path: "old.txt" }] });
    await expect(
      scope.patch.apply({
        patch: [
          "*** Begin Patch",
          "*** Update File: old.txt",
          "*** Move to: moved.txt",
          "*** End Patch",
        ].join("\n"),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changes: [{ kind: "MOVE", fromPath: "old.txt", toPath: "moved.txt" }],
    });
    await expect(
      scope.patch.apply({
        patch: ["*** Begin Patch", "*** Delete File: new.txt", "*** End Patch"].join("\n"),
      }),
    ).resolves.toMatchObject({ ok: true, changes: [{ kind: "DELETE", path: "new.txt" }] });

    expect(await readFile(path.join(scope.logicalRoot, "moved.txt"), "utf8")).toBe("updated\n");
  });

  it("rejects a context mismatch without overwriting the external change", async () => {
    const scope = await scopeFixture();
    await writeFile(path.join(scope.logicalRoot, "old.txt"), "external\n");
    await expect(
      scope.patch.apply({
        patch: [
          "*** Begin Patch",
          "*** Update File: old.txt",
          "@@",
          "-old",
          "+agent",
          "*** End Patch",
        ].join("\n"),
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "PATCH_CONTEXT_MISMATCH",
      } satisfies Partial<RuntimePatchError>),
    );
    expect(await readFile(path.join(scope.logicalRoot, "old.txt"), "utf8")).toBe("external\n");
  });
});
