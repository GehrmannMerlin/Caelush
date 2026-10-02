import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWindowsAclRestrictedTokenProvider } from "../src/index.js";
import { probeNativeSandboxRunner } from "../src/sandbox/native-runner-probe.js";
import type { NativeSandboxRunnerManifest } from "../src/sandbox/native-runner-provider.js";
import {
  buildSandboxRunner,
  // @ts-expect-error The release helper is a checked-in JavaScript build script without a declaration file.
} from "../../../scripts/build-sandbox-runner.mjs";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const providerId = "windows-acl-restricted-token";

describeWindows("native Windows Runner functional probe", () => {
  let temporaryDirectory = "";
  let runnerPath = "";

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "caelush-native-runner-probe-test-"));
    const cargo =
      process.env.CARGO ??
      join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
    const built = await buildSandboxRunner({
      repositoryRoot: process.cwd(),
      outputDirectory: temporaryDirectory,
      cargo,
    });
    runnerPath = built.binaryPath;
  }, 120_000);

  afterAll(async () => {
    if (temporaryDirectory !== "") {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a hash-valid executable that does not prove read-only confinement", async () => {
    const stubPath = join(temporaryDirectory, "stub-runner.exe");
    await copyFile(process.execPath, stubPath);

    await expect(probe(stubPath)).resolves.toEqual({
      available: false,
      enforcement: "NONE",
      reasonCode: "RUNNER_FUNCTIONAL_PROBE_FAILED",
    });
  });

  it("accepts the real Runner only after read succeeds and mutations are denied", async () => {
    const manifest = await manifestFor(runnerPath);
    const provider = createWindowsAclRestrictedTokenProvider({
      platform: "win32",
      arch: process.arch,
      runnerPath,
      manifest,
    });
    await expect(provider.probe!()).resolves.toEqual({
      available: true,
      enforcement: "PARTIAL",
    });
  });
});

async function probe(path: string) {
  const manifest = await manifestFor(path);
  return probeNativeSandboxRunner({
    providerId,
    targetPlatform: "windows",
    enforcement: "PARTIAL",
    hostPlatform: "win32",
    arch: process.arch,
    runnerPath: path,
    manifest,
    timeoutMs: 5_000,
  });
}

async function manifestFor(path: string): Promise<NativeSandboxRunnerManifest> {
  return {
    schemaVersion: 1,
    product: "caelush",
    controlProtocolVersion: 1,
    platform: "windows",
    arch: process.arch,
    executableName: basename(path),
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
    providers: [providerId],
  };
}
