import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import {
  LocalRuntime,
  PATCH_LIMITS,
  parsePatch,
  type PatchMutationFileSystem,
} from "../src/index.js";
import { preparePatch } from "../src/patch/planner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("patch preparation contract", () => {
  it("keeps the mutation port narrow and preparation budgets explicit", () => {
    const methods: readonly (keyof PatchMutationFileSystem)[] = [
      "readFileBytes",
      "getMetadata",
      "writePatchFile",
      "removePatchFile",
      "movePatchFile",
      "makePatchDirectory",
      "removePatchDirectoryIfEmpty",
    ];
    expect(methods).toHaveLength(7);
    expect(PATCH_LIMITS.maxPreparedBytes).toBe(32 * 1024 * 1024);
  });

  it("prepares every change in memory and computes exact before/after versions", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-patch-prepare-"));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "file.txt"), "one\r\ntwo\r\n");
    const scope = await new LocalRuntime().openWorkspace({
      id: createWorkspaceId(),
      path: workspace,
    });
    let writes = 0;
    const filesystem: PatchMutationFileSystem = {
      readFileBytes: async (absolutePath) => new Uint8Array(await readFile(absolutePath)),
      getMetadata: (absolutePath) => scope.filesystem.getMetadata(absolutePath),
      writePatchFile: async () => {
        writes += 1;
      },
      removePatchFile: async () => {
        writes += 1;
      },
      movePatchFile: async () => {
        writes += 1;
      },
      makePatchDirectory: async () => {
        writes += 1;
      },
      removePatchDirectoryIfEmpty: async () => {
        writes += 1;
      },
    };
    const prepared = await preparePatch(
      parsePatch(
        [
          "*** Begin Patch",
          "*** Update File: file.txt",
          "@@",
          " one",
          "-two",
          "+TWO",
          "*** End Patch",
        ].join("\n"),
      ),
      { pathResolver: scope.pathResolver, filesystem },
    );

    expect(prepared.changes[0]).toMatchObject({
      operation: { kind: "UPDATE", path: "file.txt" },
      beforeVersion: { sizeBytes: 10 },
      additions: 1,
      deletions: 1,
    });
    expect(Array.from(prepared.changes[0]!.afterBytes!)).toEqual(
      Array.from(new TextEncoder().encode("one\r\nTWO\r\n")),
    );
    expect(writes).toBe(0);
  });

  it("fails preparation before mutation when a later source is binary", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-patch-preflight-"));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "good.txt"), "old\n");
    await writeFile(path.join(workspace, "bad.png"), Uint8Array.from([0, 1, 2]));
    const scope = await new LocalRuntime().openWorkspace({
      id: createWorkspaceId(),
      path: workspace,
    });
    const filesystem: PatchMutationFileSystem = {
      readFileBytes: async (absolutePath) => new Uint8Array(await readFile(absolutePath)),
      getMetadata: (absolutePath) => scope.filesystem.getMetadata(absolutePath),
      writePatchFile: async () => undefined,
      removePatchFile: async () => undefined,
      movePatchFile: async () => undefined,
      makePatchDirectory: async () => undefined,
      removePatchDirectoryIfEmpty: async () => undefined,
    };
    await expect(
      preparePatch(
        parsePatch(
          [
            "*** Begin Patch",
            "*** Update File: good.txt",
            "@@",
            "-old",
            "+new",
            "*** Update File: bad.png",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
          ].join("\n"),
        ),
        { pathResolver: scope.pathResolver, filesystem },
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "BINARY_FILE" }));
  });
});
