import { describe, expect, it } from "vitest";
import {
  allWorkspaceManifestPaths,
  dependencyEntries,
  pathExists,
  readManifest,
  workspaceSourceContents,
} from "./support/workspace.js";

const appPackageNames = new Set(["@caelush/daemon", "@caelush/cli", "@caelush/web"]);
const protocolPackageName = "@caelush/protocol";
const internalPackagePattern = /^@caelush\//;
const deepSourceImportPattern = /\.\.\/(?:\.\.\/)+packages\/[^\s"'`]+\/src\//;

describe("package boundaries", () => {
  it("prevents packages from depending on applications", async () => {
    for (const manifestPath of allWorkspaceManifestPaths().filter((entry) =>
      entry.startsWith("packages/"),
    )) {
      const manifestExists = await pathExists(manifestPath);
      expect(manifestExists, manifestPath).toBe(true);
      if (!manifestExists) {
        return;
      }

      const manifest = await readManifest(manifestPath);
      const dependencies = Object.keys(dependencyEntries(manifest));

      expect(dependencies.some((dependency) => appPackageNames.has(dependency))).toBe(false);
    }
  });

  it("keeps protocol independent from other Caelush feature packages", async () => {
    const manifestPath = "packages/protocol/package.json";
    const manifestExists = await pathExists(manifestPath);
    expect(manifestExists, manifestPath).toBe(true);
    if (!manifestExists) {
      return;
    }

    const manifest = await readManifest(manifestPath);
    const dependencies = Object.keys(dependencyEntries(manifest));

    expect(
      dependencies.some(
        (dependency) =>
          internalPackagePattern.test(dependency) && dependency !== protocolPackageName,
      ),
    ).toBe(false);
  });

  it("keeps Events provider-neutral and Storage below Core", async () => {
    const events = await readManifest("packages/events/package.json");
    const storage = await readManifest("packages/storage/package.json");
    const core = await readManifest("packages/core/package.json");
    const eventDependencies = Object.keys(dependencyEntries(events));
    const storageDependencies = Object.keys(dependencyEntries(storage));
    const coreDependencies = Object.keys(dependencyEntries(core));

    expect(eventDependencies).toContain("@caelush/protocol");
    expect(eventDependencies).not.toContain("@caelush/storage");
    expect(storageDependencies).toContain("@caelush/events");
    expect(storageDependencies).toContain("@caelush/protocol");
    expect(coreDependencies).not.toContain("@caelush/storage");
  });

  it("requires workspace protocol for every internal dependency", async () => {
    for (const manifestPath of allWorkspaceManifestPaths()) {
      const manifestExists = await pathExists(manifestPath);
      expect(manifestExists, manifestPath).toBe(true);
      if (!manifestExists) {
        return;
      }

      const manifest = await readManifest(manifestPath);

      for (const [dependency, version] of Object.entries(dependencyEntries(manifest))) {
        if (internalPackagePattern.test(dependency)) {
          expect(version, `${manifestPath} -> ${dependency}`).toBe("workspace:*");
        }
      }
    }
  });

  it("rejects deep cross-package source imports", async () => {
    const sourceContents = await workspaceSourceContents();

    expect(sourceContents.some((contents) => deepSourceImportPattern.test(contents))).toBe(false);
  });
});
