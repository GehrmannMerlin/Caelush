import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReleaseManifest,
  getPlatformArtifactName,
  packageSandboxRunnerForRelease,
  resolveSandboxRunnerBuildDecision,
  rewriteWorkspaceDependencies,
  validateReleaseManifest,
  writeChecksums,
} from "./build-release.mjs";
import { resolvePackageSource } from "./build-release.mjs";
import {
  SANDBOX_RUNNER_DIRECTORY_NAME,
  verifySandboxRunnerPackage,
} from "./build-sandbox-runner.mjs";

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

describe("release sandbox runner packaging", () => {
  it("packages the Runner by default on Windows and stays opt-in elsewhere", () => {
    expect(resolveSandboxRunnerBuildDecision({}, "win32")).toBe(true);
    expect(resolveSandboxRunnerBuildDecision({}, "linux")).toBe(false);
    expect(resolveSandboxRunnerBuildDecision({}, "darwin")).toBe(false);
    expect(resolveSandboxRunnerBuildDecision({ buildSandboxRunner: false }, "win32")).toBe(false);
    expect(resolveSandboxRunnerBuildDecision({ buildSandboxRunner: true }, "linux")).toBe(true);
  });

  it("packages, hash-verifies, and checksums the Runner and its manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-release-runner-"));
    try {
      const builtBinary = join(root, "built-runner.exe");
      const configured = await writeFile(builtBinary, "runner-fixture", "utf8");
      expect(configured).toBeUndefined();
      const deployDirectory = join(root, "deploy");
      const verifications: Array<Record<string, unknown>> = [];
      const runner = await packageSandboxRunnerForRelease({
        repositoryRoot: root,
        deployDirectory,
        platform: "win32",
        arch: "x64",
        binaryPath: builtBinary,
        runCargo: false,
        verify: async (input: Record<string, unknown>) => {
          verifications.push(input);
        },
      });

      expect(runner.binaryPath).toBe(
        join(deployDirectory, SANDBOX_RUNNER_DIRECTORY_NAME, "caelush-sandbox-runner.exe"),
      );
      expect(runner.manifest.sha256).toBe(
        createHash("sha256").update("runner-fixture").digest("hex"),
      );
      expect(verifications).toHaveLength(1);
      expect(verifications[0]).toMatchObject({ targetPlatform: "windows", arch: "x64" });

      await writeFile(
        join(deployDirectory, "manifest.json"),
        `${JSON.stringify(
          createReleaseManifest({
            version: "0.1.0",
            platform: "windows",
            arch: "x64",
            sandboxRunner: "PACKAGED",
            sandboxRunnerManifest: runner.manifest,
          }),
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeChecksums(deployDirectory);
      const checksums = await readFile(join(deployDirectory, "checksums.sha256"), "utf8");
      expect(checksums).toContain(`${SANDBOX_RUNNER_DIRECTORY_NAME}/caelush-sandbox-runner.exe`);
      expect(checksums).toContain(`${SANDBOX_RUNNER_DIRECTORY_NAME}/manifest.json`);
      expect(checksums).toContain("manifest.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the Runner build or bounded smoke does not succeed", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-release-runner-failure-"));
    try {
      const deployDirectory = join(root, "deploy");
      await expect(
        packageSandboxRunnerForRelease({
          repositoryRoot: root,
          deployDirectory,
          platform: "win32",
          arch: "x64",
          binaryPath: join(root, "missing-runner.exe"),
          runCargo: false,
          verify: async () => undefined,
        }),
      ).rejects.toThrow();

      const builtBinary = join(root, "built-runner.exe");
      await writeFile(builtBinary, "runner-fixture", "utf8");
      await expect(
        packageSandboxRunnerForRelease({
          repositoryRoot: root,
          deployDirectory,
          platform: "win32",
          arch: "x64",
          binaryPath: builtBinary,
          runCargo: false,
          verify: async () => {
            throw new Error("SANDBOX_RUNNER_FUNCTIONAL_PROBE_FAILED");
          },
        }),
      ).rejects.toThrow(/SANDBOX_RUNNER_FUNCTIONAL_PROBE_FAILED/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a packaged Runner whose bytes no longer match its manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-release-runner-tamper-"));
    try {
      const builtBinary = join(root, "built-runner.exe");
      await writeFile(builtBinary, "runner-fixture", "utf8");
      const deployDirectory = join(root, "deploy");
      const runner = await packageSandboxRunnerForRelease({
        repositoryRoot: root,
        deployDirectory,
        platform: "win32",
        arch: "x64",
        binaryPath: builtBinary,
        runCargo: false,
        verify: async () => undefined,
      });

      await expect(
        verifySandboxRunnerPackage({ runnerPath: runner.binaryPath, manifest: runner.manifest }),
      ).resolves.toBe(runner.manifest.sha256);

      await writeFile(runner.binaryPath, "tampered-runner", "utf8");
      await expect(
        verifySandboxRunnerPackage({ runnerPath: runner.binaryPath, manifest: runner.manifest }),
      ).rejects.toThrow("SANDBOX_RUNNER_HASH_MISMATCH");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
