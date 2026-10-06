import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { resolvePromptCacheArtifactDirectory } from "./browser-smoke-artifact-path.mjs";

describe("resolvePromptCacheArtifactDirectory", () => {
  it("rejects a future artifact directory reached through a junction into the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-artifact-path-"));
    const repository = join(root, "repository");
    const external = join(root, "external");
    const junction = join(external, "repository-link");
    try {
      await mkdir(repository);
      await mkdir(external);
      await symlink(repository, junction, "junction");

      await expect(
        resolvePromptCacheArtifactDirectory(repository, join(junction, "artifacts")),
      ).rejects.toThrow("outside the repository");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a canonical path for a new external artifact directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-artifact-path-"));
    const repository = join(root, "repository");
    const externalDirectory = join(root, "external", "artifacts");
    try {
      await mkdir(repository);
      await mkdir(join(root, "external"));

      await expect(
        resolvePromptCacheArtifactDirectory(repository, externalDirectory),
      ).resolves.toBe(externalDirectory);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an explicitly configured artifact directory", async () => {
    await expect(resolvePromptCacheArtifactDirectory(process.cwd())).rejects.toThrow(
      "artifact directory outside the repository",
    );
  });
});
