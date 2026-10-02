import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SANDBOX_RUNNER_DIRECTORY_NAME,
  SANDBOX_RUNNER_MANIFEST_ENVIRONMENT_KEY,
  SANDBOX_RUNNER_PATH_ENVIRONMENT_KEY,
  resolveSandboxRunnerArtifact,
  type SandboxRunnerResolution,
} from "../src/sandbox-runner-host.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "caelush-daemon-runner-host-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveSandboxRunnerArtifact", () => {
  it("prefers the explicit development override and verifies it", async () => {
    const override = await writeRunnerBundle(join(root, "override dir", "运行 目录"), {
      executableName: "caelush-sandbox-runner.exe",
      platform: "windows",
      arch: "x64",
    });
    const resolution = await resolve({
      environment: { [SANDBOX_RUNNER_PATH_ENVIRONMENT_KEY]: override.runnerPath },
      daemonEntryPath: daemonEntryPathFor(join(root, "bundle")),
      platform: "win32",
      arch: "x64",
    });

    expect(resolution.available).toBe(true);
    expect(availableArtifact(resolution).runnerPath).toBe(override.runnerPath);
    expect(availableArtifact(resolution).manifestPath).toBe(override.manifestPath);
  });

  it("accepts an explicit override manifest path", async () => {
    const override = await writeRunnerBundle(join(root, "override"), {
      executableName: "caelush-sandbox-runner.exe",
      platform: "windows",
      arch: "x64",
    });
    const relocatedManifest = join(root, "relocated", "manifest.json");
    await mkdir(join(root, "relocated"), { recursive: true });
    await writeFile(relocatedManifest, JSON.stringify(override.manifest), "utf8");

    const resolution = await resolve({
      environment: {
        [SANDBOX_RUNNER_PATH_ENVIRONMENT_KEY]: override.runnerPath,
        [SANDBOX_RUNNER_MANIFEST_ENVIRONMENT_KEY]: relocatedManifest,
      },
      daemonEntryPath: daemonEntryPathFor(join(root, "bundle")),
      platform: "win32",
      arch: "x64",
    });

    expect(resolution.available).toBe(true);
    expect(availableArtifact(resolution).manifestPath).toBe(relocatedManifest);
  });

  it("finds the fixed release-relative runner without any environment override", async () => {
    const bundleRoot = join(root, "bundle");
    const daemonEntryPath = await writeDaemonEntry(bundleRoot);
    const packaged = await writeRunnerBundle(join(bundleRoot, SANDBOX_RUNNER_DIRECTORY_NAME), {
      executableName: "caelush-sandbox-runner.exe",
      platform: "windows",
      arch: "x64",
    });

    const resolution = await resolve({
      environment: {},
      daemonEntryPath,
      platform: "win32",
      arch: "x64",
    });

    expect(resolution.available).toBe(true);
    expect(availableArtifact(resolution).runnerPath).toBe(packaged.runnerPath);
    expect(availableArtifact(resolution).manifestPath).toBe(packaged.manifestPath);
  });

  it("stays unavailable in a source checkout that has no packaged runner", async () => {
    const daemonEntryPath = join(root, "apps", "daemon", "dist", "main.js");
    await mkdir(join(root, "apps", "daemon", "dist"), { recursive: true });
    await writeFile(daemonEntryPath, "", "utf8");

    await expect(
      resolve({ environment: {}, daemonEntryPath, platform: "win32", arch: "x64" }),
    ).resolves.toEqual({ available: false, reasonCode: "RUNNER_ARTIFACT_MISSING" });
  });

  it("never discovers a runner through the current directory or PATH", async () => {
    const strayDirectory = join(root, "cwd");
    await writeRunnerBundle(strayDirectory, {
      executableName: "caelush-sandbox-runner.exe",
      platform: "windows",
      arch: "x64",
    });
    const daemonEntryPath = join(root, "apps", "daemon", "dist", "main.js");
    await mkdir(join(root, "apps", "daemon", "dist"), { recursive: true });
    await writeFile(daemonEntryPath, "", "utf8");

    await expect(
      resolve({
        environment: { PATH: strayDirectory, Path: strayDirectory },
        daemonEntryPath,
        platform: "win32",
        arch: "x64",
      }),
    ).resolves.toEqual({ available: false, reasonCode: "RUNNER_ARTIFACT_MISSING" });
  });

  it("rejects relative and traversal-like override values", async () => {
    const daemonEntryPath = join(root, "apps", "daemon", "dist", "main.js");
    await mkdir(join(root, "apps", "daemon", "dist"), { recursive: true });
    await writeFile(daemonEntryPath, "", "utf8");
    const valid = await writeRunnerBundle(join(root, "override"), {
      executableName: "caelush-sandbox-runner.exe",
      platform: "windows",
      arch: "x64",
    });

    const overrides = [
      relative(join(root, "apps"), valid.runnerPath),
      join(root, "apps", "daemon", "..", "..", "evil.exe"),
      "caelush-sandbox-runner.exe",
    ];
    for (const override of overrides) {
      await expect(
        resolve({
          environment: { [SANDBOX_RUNNER_PATH_ENVIRONMENT_KEY]: override },
          daemonEntryPath,
          platform: "win32",
          arch: "x64",
        }),
      ).resolves.toEqual({ available: false, reasonCode: "RUNNER_ARTIFACT_MISSING" });
    }
  });

  it("reports a bounded reason code for a mismatched packaged manifest", async () => {
    const bundleRoot = join(root, "bundle");
    const daemonEntryPath = await writeDaemonEntry(bundleRoot);
    const packaged = await writeRunnerBundle(join(bundleRoot, SANDBOX_RUNNER_DIRECTORY_NAME), {
      executableName: "caelush-sandbox-runner.exe",
      platform: "windows",
      arch: "x64",
    });

    await writeFile(packaged.runnerPath, "tampered-runner", "utf8");
    await expect(
      resolve({ environment: {}, daemonEntryPath, platform: "win32", arch: "x64" }),
    ).resolves.toEqual({ available: false, reasonCode: "RUNNER_HASH_MISMATCH" });

    await writeRunnerBundle(join(bundleRoot, SANDBOX_RUNNER_DIRECTORY_NAME), {
      executableName: "caelush-sandbox-runner.exe",
      platform: "windows",
      arch: "x64",
    });
    await writeFile(
      packaged.manifestPath,
      JSON.stringify({ ...packaged.manifest, platform: "linux" }),
      "utf8",
    );
    await expect(
      resolve({ environment: {}, daemonEntryPath, platform: "win32", arch: "x64" }),
    ).resolves.toEqual({ available: false, reasonCode: "RUNNER_MANIFEST_INVALID" });

    await writeFile(packaged.manifestPath, JSON.stringify(packaged.manifest), "utf8");
    await expect(
      resolve({ environment: {}, daemonEntryPath, platform: "win32", arch: "arm64" }),
    ).resolves.toEqual({ available: false, reasonCode: "RUNNER_MANIFEST_INVALID" });

    await rm(packaged.manifestPath, { force: true });
    await expect(
      resolve({ environment: {}, daemonEntryPath, platform: "win32", arch: "x64" }),
    ).resolves.toEqual({ available: false, reasonCode: "RUNNER_ARTIFACT_MISSING" });
  });

  it("refuses an unsupported host platform without touching the filesystem", async () => {
    await expect(
      resolve({
        environment: {},
        daemonEntryPath: daemonEntryPathFor(join(root, "bundle")),
        platform: "freebsd" as NodeJS.Platform,
        arch: "x64",
      }),
    ).resolves.toEqual({ available: false, reasonCode: "RUNNER_PLATFORM_UNSUPPORTED" });
  });

  it("uses the platform executable name instead of the manifest's", async () => {
    const bundleRoot = join(root, "bundle");
    const daemonEntryPath = await writeDaemonEntry(bundleRoot);
    const packaged = await writeRunnerBundle(join(bundleRoot, SANDBOX_RUNNER_DIRECTORY_NAME), {
      executableName: "caelush-sandbox-runner",
      platform: "linux",
      arch: "x64",
    });

    const resolution = await resolve({
      environment: {},
      daemonEntryPath,
      platform: "linux",
      arch: "x64",
    });
    expect(resolution.available).toBe(true);
    expect(availableArtifact(resolution).runnerPath).toBe(packaged.runnerPath);
    expect(basename(availableArtifact(resolution).runnerPath)).toBe("caelush-sandbox-runner");
  });
});

type ResolveInput = Parameters<typeof resolveSandboxRunnerArtifact>[0];

function resolve(input: ResolveInput): Promise<SandboxRunnerResolution> {
  return resolveSandboxRunnerArtifact(input);
}

function availableArtifact(resolution: SandboxRunnerResolution) {
  if (!resolution.available) {
    throw new Error(`Expected an available Runner, got ${resolution.reasonCode}`);
  }
  return resolution.artifact;
}

function daemonEntryPathFor(bundleRoot: string): string {
  return join(bundleRoot, "node_modules", "@caelush", "daemon", "dist", "main.js");
}

async function writeDaemonEntry(bundleRoot: string): Promise<string> {
  const daemonEntryPath = daemonEntryPathFor(bundleRoot);
  await mkdir(join(bundleRoot, "node_modules", "@caelush", "daemon", "dist"), { recursive: true });
  await writeFile(daemonEntryPath, "", "utf8");
  return daemonEntryPath;
}

async function writeRunnerBundle(
  directory: string,
  input: {
    readonly executableName: string;
    readonly platform: "windows" | "linux" | "macos";
    readonly arch: string;
  },
): Promise<{
  readonly runnerPath: string;
  readonly manifestPath: string;
  readonly manifest: Record<string, unknown>;
}> {
  await mkdir(directory, { recursive: true });
  const runnerPath = join(directory, input.executableName);
  const manifestPath = join(directory, "manifest.json");
  await writeFile(runnerPath, "runner-fixture", "utf8");
  const providers =
    input.platform === "windows"
      ? ["windows-acl-restricted-token"]
      : input.platform === "linux"
        ? ["linux-landlock"]
        : ["macos-seatbelt"];
  const manifest = {
    schemaVersion: 1,
    product: "caelush",
    controlProtocolVersion: 1,
    platform: input.platform,
    arch: input.arch,
    executableName: input.executableName,
    sha256: createHash("sha256").update("runner-fixture").digest("hex"),
    providers,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { runnerPath, manifestPath, manifest };
}
