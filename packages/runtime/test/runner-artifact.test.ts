import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSandboxRunner,
  createSandboxRunnerManifest,
  hashSandboxRunnerFile,
  validateSandboxRunnerManifest,
  writeSandboxRunnerManifest,
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
