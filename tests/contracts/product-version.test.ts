import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditProductVersions } from "../../scripts/check-product-version.mjs";

const roots: string[] = [];
const packageFiles = [
  ["apps/daemon/package.json", "@caelush/daemon"],
  ["apps/desktop/package.json", "@caelush/desktop"],
  ["apps/launcher/package.json", "@caelush/launcher"],
  ["apps/web/package.json", "@caelush/web"],
  ["packages/protocol/package.json", "@caelush/protocol"],
  ["packages/client/package.json", "@caelush/client"],
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(version = "0.1.0") {
  const root = await mkdtemp(join(tmpdir(), "caelush-product-version-"));
  roots.push(root);
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeJson(join(root, "package.json"), { name: "caelush", version });
  for (const [manifestPath, name] of packageFiles) {
    await writeJson(join(root, manifestPath), { name, version });
  }
  await writeJson(
    join(root, "release-artifacts", `caelush-v${version}-windows-x64`, "manifest.json"),
    {
      product: "caelush",
      schemaVersion: 1,
      version,
      protocolVersion: 1,
      nodeRange: ">=24.0.0 <25.0.0",
      sandboxRunner: "UNAVAILABLE",
    },
  );
  await writeFile(
    join(root, "scripts", "build-release.mjs"),
    [
      "const launcherManifest = JSON.parse(await readFile(join(deployDirectory, 'package.json')));",
      "const version = launcherManifest.version;",
      "const manifest = createReleaseManifest({ version, });",
    ].join("\n"),
  );
  return root;
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

describe("canonical product version authority", () => {
  it("checks the current repository and existing release-version source", async () => {
    const result = await auditProductVersions();
    expect(result.errors).toEqual([]);
    expect(result.canonicalVersion).toBe("0.1.0");
    expect(result.checkedManifestCount).toBeGreaterThan(packageFiles.length);
  });

  it("accepts an existing Release Manifest when its version mirrors the canonical product version", async () => {
    const root = await fixtureRoot();
    const result = await auditProductVersions({ root });

    expect(result.errors).toEqual([]);
    expect(result.releaseManifestCount).toBe(1);
  });

  it("rejects a workspace version mirror drift with the manifest path", async () => {
    const root = await fixtureRoot();
    await writeJson(join(root, "apps", "web", "package.json"), {
      name: "@caelush/web",
      version: "0.2.0",
    });

    const result = await auditProductVersions({ root });

    expect(result.errors).toContain(
      "apps/web/package.json: version 0.2.0 differs from canonical 0.1.0 in package.json.",
    );
  });

  it("rejects invalid SemVer and missing package versions", async () => {
    const invalidRoot = await fixtureRoot("01.0.0");
    const invalidResult = await auditProductVersions({ root: invalidRoot });
    expect(
      invalidResult.errors.some(
        (error) => error.includes("package.json") && error.includes("valid SemVer"),
      ),
    ).toBe(true);

    const missingRoot = await fixtureRoot();
    await writeJson(join(missingRoot, "packages", "protocol", "package.json"), {
      name: "@caelush/protocol",
    });
    const missingResult = await auditProductVersions({ root: missingRoot });
    expect(missingResult.errors).toContain(
      "packages/protocol/package.json: package version is missing.",
    );
  });

  it("rejects a release builder that stops sourcing its version from Launcher metadata", async () => {
    const root = await fixtureRoot();
    await writeFile(
      join(root, "scripts", "build-release.mjs"),
      "const version = process.env.RELEASE_VERSION;\ncreateReleaseManifest({ version });\n",
    );

    const result = await auditProductVersions({ root });

    expect(result.errors).toContain(
      "scripts/build-release.mjs: Release Manifest version must come from the deployed Launcher package.json version.",
    );
  });

  it("rejects an existing Release Manifest that disagrees with the canonical product version", async () => {
    const root = await fixtureRoot();
    await writeJson(
      join(root, "release-artifacts", "caelush-v0.2.0-windows-x64", "manifest.json"),
      {
        product: "caelush",
        schemaVersion: 1,
        version: "0.2.0",
        protocolVersion: 1,
        nodeRange: ">=24.0.0 <25.0.0",
        sandboxRunner: "UNAVAILABLE",
      },
    );

    const result = await auditProductVersions({ root });

    expect(result.errors).toContain(
      "release-artifacts/caelush-v0.2.0-windows-x64/manifest.json: release version 0.2.0 differs from canonical 0.1.0.",
    );
  });
});
