import { describe, expect, it } from "vitest";
import {
  allWorkspaceManifestPaths,
  allWorkspaceNames,
  pathExists,
  readManifest,
} from "./support/workspace.js";

describe("workspace shape", () => {
  it("contains every declared package and app directory", async () => {
    const expectedDirectories = allWorkspaceManifestPaths().map((manifestPath) =>
      manifestPath.replace(/\/package\.json$/, ""),
    );

    await expect(
      Promise.all(expectedDirectories.map((directory) => pathExists(directory))),
    ).resolves.toEqual(expectedDirectories.map(() => true));
  });

  it("gives every workspace project a unique canonical name", async () => {
    const manifestPaths = allWorkspaceManifestPaths();
    const manifestsExist = await Promise.all(manifestPaths.map(pathExists));

    expect(manifestsExist).toEqual(manifestPaths.map(() => true));
    if (manifestsExist.some((exists) => !exists)) {
      return;
    }

    const manifests = await Promise.all(manifestPaths.map(readManifest));
    const names = manifests.map((manifest) => manifest.name);

    expect(names).toEqual(allWorkspaceNames());
    expect(new Set(names).size).toBe(names.length);
  });

  it("provides a private ESM manifest and public source entry for every project", async () => {
    const manifestPaths = allWorkspaceManifestPaths();
    const manifestsExist = await Promise.all(manifestPaths.map(pathExists));

    expect(manifestsExist).toEqual(manifestPaths.map(() => true));
    if (manifestsExist.some((exists) => !exists)) {
      return;
    }

    for (const manifestPath of manifestPaths) {
      const manifest = await readManifest(manifestPath);
      const sourceEntry = manifestPath.replace(/package\.json$/, "src/index.ts");

      await expect(pathExists(sourceEntry)).resolves.toBe(true);
      expect(manifest.private).toBe(true);
      expect(manifest.type).toBe("module");
      expect(manifest.exports).toMatchObject({ ".": expect.anything() });
    }
  });
});
