import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SandboxRunnerArtifactError,
  loadAndVerifySandboxRunnerArtifact,
  type SandboxRunnerManifest,
} from "../src/index.js";
import { verifyNativeSandboxRunnerArtifact } from "../src/sandbox/native-runner-probe.js";
import {
  buildSandboxRunner,
  createSandboxRunnerManifest,
  hashSandboxRunnerFile,
  validateSandboxRunnerManifest,
  writeSandboxRunnerManifest,
  // @ts-expect-error The release helper is a checked-in JavaScript build script without a declaration file.
} from "../../../scripts/build-sandbox-runner.mjs";

describe("sandbox runner artifact manifest", () => {
  it("records platform, architecture, provider set, and executable hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caelush-runner-artifact-"));
    try {
      const binary = path.join(root, "sandbox-runner.exe");
      const manifestPath = path.join(root, "manifest.json");
      await writeFile(binary, "runner-fixture", "utf8");
      const manifest = createSandboxRunnerManifest({
        platform: "windows",
        arch: "x64",
        executableName: "sandbox-runner.exe",
        sha256: await hashSandboxRunnerFile(binary),
        providers: ["windows-acl-restricted-token"],
      });
      await writeSandboxRunnerManifest(manifestPath, manifest);
      expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(manifest);
      expect(validateSandboxRunnerManifest(manifest)).toEqual(manifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a manifest whose hash or platform identity is unsafe", () => {
    const manifest = createSandboxRunnerManifest({
      platform: "linux",
      arch: "x64",
      executableName: "sandbox-runner",
      sha256: "a".repeat(64),
      providers: ["linux-landlock"],
    });
    expect(() =>
      validateSandboxRunnerManifest({ ...manifest, sha256: "b".repeat(64) }),
    ).not.toThrow();
    expect(() => validateSandboxRunnerManifest({ ...manifest, sha256: "not-a-hash" })).toThrow(
      /manifest|hash/i,
    );
    expect(() => validateSandboxRunnerManifest({ ...manifest, platform: "windows" })).toThrow(
      /provider|platform/i,
    );
  });

  it("fails closed when the native compiler is unavailable instead of creating a fake runner", async () => {
    await expect(
      buildSandboxRunner({
        repositoryRoot: process.cwd(),
        cargo: "caelush-cargo-that-does-not-exist",
      }),
    ).rejects.toThrow("SANDBOX_RUNNER_BUILD_UNAVAILABLE");
  });
});

describe("loadAndVerifySandboxRunnerArtifact", () => {
  it("returns frozen artifact metadata for a verified runner and manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caelush-runner-load-"));
    try {
      const fixture = await writeRunnerFixture(root, {
        platform: "windows",
        executableName: "caelush-sandbox-runner.exe",
      });
      const resolved = await loadAndVerifySandboxRunnerArtifact({
        runnerPath: fixture.runnerPath,
        manifestPath: fixture.manifestPath,
        platform: "win32",
        arch: "x64",
      });

      expect(resolved.runnerPath).toBe(fixture.runnerPath);
      expect(resolved.manifestPath).toBe(fixture.manifestPath);
      expect(resolved.manifest).toEqual(fixture.manifest);
      expect(Object.isFrozen(resolved)).toBe(true);
      expect(Object.isFrozen(resolved.manifest)).toBe(true);
      expect(Object.isFrozen(resolved.manifest.providers)).toBe(true);
      expect(() => {
        (resolved.manifest as { sha256: string }).sha256 = "0".repeat(64);
      }).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("infers the manifest path beside the runner executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caelush-runner-load-default-"));
    try {
      const fixture = await writeRunnerFixture(root, {
        platform: "windows",
        executableName: "caelush-sandbox-runner.exe",
      });
      const resolved = await loadAndVerifySandboxRunnerArtifact({
        runnerPath: fixture.runnerPath,
        platform: "win32",
        arch: "x64",
      });
      expect(resolved.manifestPath).toBe(path.join(root, "manifest.json"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports runner locations containing spaces and Unicode characters", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-runner-unicode-"));
    const root = path.join(parent, "运行 空间", "runner dir");
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(root, { recursive: true });
      const fixture = await writeRunnerFixture(root, {
        platform: "windows",
        executableName: "caelush-sandbox-runner.exe",
      });
      await expect(
        loadAndVerifySandboxRunnerArtifact({
          runnerPath: fixture.runnerPath,
          manifestPath: fixture.manifestPath,
          platform: "win32",
          arch: "x64",
        }),
      ).resolves.toMatchObject({ runnerPath: fixture.runnerPath });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("fails closed with a bounded reason code for every identity and hash failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caelush-runner-failures-"));
    try {
      await expect(
        loadAndVerifySandboxRunnerArtifact({
          runnerPath: path.join(root, "absent-runner.exe"),
          platform: "win32",
          arch: "x64",
        }),
      ).rejects.toMatchObject({ reasonCode: "RUNNER_ARTIFACT_MISSING" });

      const manifestOnly = path.join(root, "manifest-only");
      const { mkdir: makeDirectory } = await import("node:fs/promises");
      await makeDirectory(manifestOnly, { recursive: true });
      const runnerPath = path.join(manifestOnly, "caelush-sandbox-runner.exe");
      await writeFile(runnerPath, "runner-fixture", "utf8");
      await expect(
        loadAndVerifySandboxRunnerArtifact({ runnerPath, platform: "win32", arch: "x64" }),
      ).rejects.toMatchObject({ reasonCode: "RUNNER_ARTIFACT_MISSING" });

      const manifestPath = path.join(manifestOnly, "manifest.json");
      const validManifest = await validManifestFor(runnerPath, "windows", "x64");
      const reject = async (
        mutated: Partial<SandboxRunnerManifest> | string,
        reasonCode: string,
      ): Promise<void> => {
        await writeFile(
          manifestPath,
          typeof mutated === "string" ? mutated : JSON.stringify({ ...validManifest, ...mutated }),
          "utf8",
        );
        await expect(
          loadAndVerifySandboxRunnerArtifact({
            runnerPath,
            manifestPath,
            platform: "win32",
            arch: "x64",
          }),
        ).rejects.toMatchObject({ reasonCode });
      };

      await reject("not-json", "RUNNER_MANIFEST_INVALID");
      await reject({ product: "other" as never }, "RUNNER_MANIFEST_INVALID");
      await reject({ schemaVersion: 2 as never }, "RUNNER_MANIFEST_INVALID");
      await reject({ controlProtocolVersion: 2 as never }, "RUNNER_MANIFEST_INVALID");
      await reject({ platform: "linux" }, "RUNNER_MANIFEST_INVALID");
      await reject({ arch: "arm64" }, "RUNNER_MANIFEST_INVALID");
      await reject({ executableName: "other.exe" }, "RUNNER_MANIFEST_INVALID");
      await reject({ sha256: "not-a-hash" }, "RUNNER_MANIFEST_INVALID");
      await reject({ providers: [] as never }, "RUNNER_MANIFEST_INVALID");
      await reject({ providers: ["unknown-backend"] as never }, "RUNNER_BACKEND_MISSING");
      await reject({ sha256: "b".repeat(64) }, "RUNNER_HASH_MISMATCH");

      await writeFile(runnerPath, "tampered-runner", "utf8");
      await writeFile(manifestPath, JSON.stringify(validManifest), "utf8");
      await expect(
        loadAndVerifySandboxRunnerArtifact({
          runnerPath,
          manifestPath,
          platform: "win32",
          arch: "x64",
        }),
      ).rejects.toMatchObject({ reasonCode: "RUNNER_HASH_MISMATCH" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported host platform before touching the filesystem", async () => {
    const error = await loadAndVerifySandboxRunnerArtifact({
      runnerPath: path.join(os.tmpdir(), "caelush-runner-absent.exe"),
      platform: "freebsd" as NodeJS.Platform,
      arch: "x64",
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SandboxRunnerArtifactError);
    expect((error as SandboxRunnerArtifactError).reasonCode).toBe("RUNNER_PLATFORM_UNSUPPORTED");
  });
});

describe("native runner Provider artifact verification", () => {
  it("delegates to the shared verifier and keeps the Provider reason codes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caelush-runner-provider-verify-"));
    try {
      const fixture = await writeRunnerFixture(root, {
        platform: "windows",
        executableName: "caelush-sandbox-runner.exe",
      });
      const base = {
        providerId: "windows-acl-restricted-token",
        targetPlatform: "windows" as const,
        enforcement: "PARTIAL" as const,
        hostPlatform: "win32" as NodeJS.Platform,
        arch: "x64",
        runnerPath: fixture.runnerPath,
        manifestPath: fixture.manifestPath,
      };

      await expect(verifyNativeSandboxRunnerArtifact(base)).resolves.toEqual({
        available: true,
        enforcement: "PARTIAL",
      });
      await expect(
        verifyNativeSandboxRunnerArtifact({ ...base, providerId: "unrelated-backend" }),
      ).resolves.toMatchObject({ available: false, reasonCode: "RUNNER_MANIFEST_INVALID" });
      await expect(
        verifyNativeSandboxRunnerArtifact({ ...base, hostPlatform: "linux" }),
      ).resolves.toMatchObject({ available: false, reasonCode: "UNSUPPORTED_PLATFORM" });
      await writeFile(fixture.runnerPath, "tampered-runner", "utf8");
      await expect(verifyNativeSandboxRunnerArtifact(base)).resolves.toMatchObject({
        available: false,
        reasonCode: "RUNNER_HASH_MISMATCH",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeRunnerFixture(
  root: string,
  input: { readonly platform: "windows" | "linux" | "macos"; readonly executableName: string },
): Promise<{
  readonly runnerPath: string;
  readonly manifestPath: string;
  readonly manifest: SandboxRunnerManifest;
}> {
  const runnerPath = path.join(root, input.executableName);
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(runnerPath, "runner-fixture", "utf8");
  const providers =
    input.platform === "windows"
      ? ["windows-acl-restricted-token"]
      : input.platform === "linux"
        ? ["linux-landlock"]
        : ["macos-seatbelt"];
  const manifest = createSandboxRunnerManifest({
    platform: input.platform,
    arch: "x64",
    executableName: input.executableName,
    sha256: createHash("sha256")
      .update(await readFile(runnerPath))
      .digest("hex"),
    providers,
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { runnerPath, manifestPath, manifest };
}

async function validManifestFor(
  runnerPath: string,
  platform: "windows" | "linux" | "macos",
  arch: string,
): Promise<SandboxRunnerManifest> {
  return {
    schemaVersion: 1,
    product: "caelush",
    controlProtocolVersion: 1,
    platform,
    arch,
    executableName: path.basename(runnerPath),
    sha256: createHash("sha256")
      .update(await readFile(runnerPath))
      .digest("hex"),
    providers: ["windows-acl-restricted-token"],
  };
}
