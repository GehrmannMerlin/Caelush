import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReleaseManifest,
  getPlatformArtifactName,
  rewriteWorkspaceDependencies,
  validateReleaseManifest,
} from "./build-release.mjs";
import { resolvePackageSource } from "./build-release.mjs";

describe("release bundle helpers", () => {
  it("names artifacts by product version and target platform", () => {
    expect(getPlatformArtifactName("0.1.0", "win32", "x64")).toBe("caelush-v0.1.0-windows-x64.tgz");
    expect(getPlatformArtifactName("0.1.0", "darwin", "arm64")).toBe(
      "caelush-v0.1.0-macos-arm64.tgz",
    );
  });

  it("rewrites workspace ranges to concrete versions for a pnpm-free artifact", () => {
    const manifest = {
      name: "@caelush/launcher",
      version: "0.1.0",
      dependencies: { "@caelush/cli": "workspace:*", fastify: "5.12.1" },
    };
    expect(rewriteWorkspaceDependencies(manifest, { "@caelush/cli": "0.1.0" })).toEqual({
      ...manifest,
      dependencies: { "@caelush/cli": "0.1.0", fastify: "5.12.1" },
    });
  });

  it("does not advertise the restricted sandbox gate without a packaged Runner", () => {
    const manifest = createReleaseManifest({
      version: "0.1.0",
      platform: "windows",
      arch: "x64",
      sandboxRunner: "UNAVAILABLE",
    });

    expect(manifest.featureGates).toEqual({
      permissionPresetsV1: true,
      runtimeSandboxV1: false,
      fullAccessV1: true,
    });
    expect(() =>
      createReleaseManifest({
        version: "0.1.0",
        platform: "windows",
        arch: "x64",
        sandboxRunner: "UNAVAILABLE",
        featureGates: {
          permissionPresetsV1: true,
          runtimeSandboxV1: true,
          fullAccessV1: true,
        },
      }),
    ).toThrow(/sandbox runner/i);
  });

  it("requires and validates the packaged Runner manifest when the gate is enabled", () => {
    const sandboxRunnerManifest = {
      schemaVersion: 1,
      product: "caelush",
      controlProtocolVersion: 1,
      platform: "windows",
      arch: "x64",
      executableName: "caelush-sandbox-runner.exe",
      sha256: "a".repeat(64),
      providers: ["windows-acl-restricted-token"],
    };
    const manifest = createReleaseManifest({
      version: "0.1.0",
      platform: "windows",
      arch: "x64",
      sandboxRunner: "PACKAGED",
      sandboxRunnerManifest,
      featureGates: {
        permissionPresetsV1: true,
        runtimeSandboxV1: true,
        fullAccessV1: true,
      },
    });

    expect(validateReleaseManifest(manifest)).toEqual(manifest);
    expect(() =>
      validateReleaseManifest({
        ...manifest,
        sandboxRunner: "PACKAGED",
        sandboxRunnerManifest: undefined,
      }),
    ).toThrow(/runner manifest/i);
  });

  it.skipIf(process.platform !== "win32")(
    "resolves Windows junction package aliases to their real package source",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "caelush-release-junction-"));
      try {
        const packageSource = join(root, "package-source");
        const packageAlias = join(root, "package-alias");
        await mkdir(packageSource, { recursive: true });
        await symlink(packageSource, packageAlias, "junction");

        await expect(resolvePackageSource(packageAlias)).resolves.toBe(
          await realpath(packageSource),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
