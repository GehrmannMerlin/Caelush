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

      /*
       * A library-shaped project publishes `src/index.ts` and an `exports` map. An application
       * whose entry point is its host's — the Electron app in `apps/desktop`, whose `main` is the
       * Electron main process — publishes the source form of that declared entry instead. The rule
       * is not relaxed: every project must still name a real source entry, and an app that stops
       * declaring `main` falls back to the library rule.
       */
      const applicationEntry =
        manifestPath.includes("apps/") && typeof manifest.main === "string"
          ? manifestPath
              .replace(/package\.json$/, String(manifest.main))
              .replace(/\/dist\//, "/src/")
              .replace(/\.js$/, ".ts")
          : undefined;
      if (applicationEntry !== undefined && (await pathExists(applicationEntry))) {
        await expect(pathExists(applicationEntry)).resolves.toBe(true);
      } else {
        await expect(pathExists(sourceEntry)).resolves.toBe(true);
        expect(manifest.exports).toMatchObject({ ".": expect.anything() });
      }
      expect(manifest.private).toBe(true);
      expect(manifest.type).toBe("module");
    }
  });
});
