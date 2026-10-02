import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReleaseManifest } from "./build-release.mjs";
import { SANDBOX_RUNNER_DIRECTORY_NAME } from "./build-sandbox-runner.mjs";
import {
  inspectReleaseArtifact,
  verifyChecksums,
  verifyPackagedSandboxRunner,
} from "./test-release.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("release integrity checks", () => {
  it("verifies the release manifest and every packaged checksum", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-release-integrity-"));
    temporaryDirectories.push(root);
    const manifest = createReleaseManifest({
      version: "0.1.0",
      platform: "windows",
      arch: "x64",
      sandboxRunner: "UNAVAILABLE",
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const payloadBytes = Buffer.from("release payload\n");
    await writeFile(join(root, "manifest.json"), manifestBytes);
    await writeFile(join(root, "payload.txt"), payloadBytes);
    await writeFile(
      join(root, "checksums.sha256"),
      `${hash(manifestBytes)}  manifest.json\n${hash(payloadBytes)}  payload.txt\n`,
    );
    await writeFile(join(root, "manifest.sha256"), `${hash(manifestBytes)}  manifest.json\n`);
    const archive = join(root, "release.tgz");
    const result = spawnSync(
      "tar",
      [
        "-czf",
        archive,
        "-C",
        root,
        "manifest.json",
        "payload.txt",
        "checksums.sha256",
        "manifest.sha256",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(result.status).toBe(0);

    expect(inspectReleaseArtifact(archive)).toMatchObject({
      product: "caelush",
      featureGates: { runtimeSandboxV1: false },
    });
  });

  it("rejects checksum records that point outside the packaged entries", () => {
    expect(() =>
      verifyChecksums("unused.tgz", new Set(["manifest.json"]), `${"a".repeat(64)}  missing.js\n`),
    ).toThrow(/not packaged/i);
  });

  it("handles a checksum manifest larger than the child-process default buffer", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-release-large-checksum-"));
    temporaryDirectories.push(root);
    const manifest = createReleaseManifest({
      version: "0.1.0",
      platform: "windows",
      arch: "x64",
      sandboxRunner: "UNAVAILABLE",
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const payloadBytes = Buffer.from("release payload\n");
    const payloadHash = hash(payloadBytes);
    const repeatedRecord = `${payloadHash}  payload.txt\n`;
    const largeChecksums = repeatedRecord.repeat(16_000);
    expect(Buffer.byteLength(largeChecksums)).toBeGreaterThan(1024 * 1024);
    await writeFile(join(root, "manifest.json"), manifestBytes);
    await writeFile(join(root, "payload.txt"), payloadBytes);
    await writeFile(join(root, "checksums.sha256"), largeChecksums);
    await writeFile(join(root, "manifest.sha256"), `${hash(manifestBytes)}  manifest.json\n`);
    const archive = join(root, "release-large-checksum.tgz");
    const result = spawnSync(
      "tar",
      [
        "-czf",
        archive,
        "-C",
        root,
        "manifest.json",
        "payload.txt",
        "checksums.sha256",
        "manifest.sha256",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(result.status).toBe(0);

    expect(inspectReleaseArtifact(archive)).toMatchObject({
      product: "caelush",
      featureGates: { runtimeSandboxV1: false },
    });
  });
});

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("packaged sandbox runner integrity", () => {
  const runnerBytes = Buffer.from("runner-fixture\n");
  const changedRunnerBytes = Buffer.from("tampered-runner\n");
  const runnerRelativePath = `${SANDBOX_RUNNER_DIRECTORY_NAME}/caelush-sandbox-runner.exe`;
  const manifestRelativePath = `${SANDBOX_RUNNER_DIRECTORY_NAME}/manifest.json`;

  it("accepts a packaged Runner whose bytes and checksum records agree", () => {
    const manifest = sandboxManifest(hash(runnerBytes));
    const readBuffer = bufferFor(manifest);
    expect(() =>
      verifyPackagedSandboxRunner({
        entries: new Set([runnerRelativePath, manifestRelativePath]),
        readBuffer,
        sandboxManifest: manifest,
        checksums: checksumRecordsFor(manifest, readBuffer),
      }),
    ).not.toThrow();
  });

  it("fails closed when the packaged Runner bytes no longer match the manifest", () => {
    const manifest = sandboxManifest(hash(Buffer.from("original-runner\n")));
    const readBuffer = bufferFor(manifest);
    expect(() =>
      verifyPackagedSandboxRunner({
        entries: new Set([runnerRelativePath, manifestRelativePath]),
        readBuffer,
        sandboxManifest: manifest,
        checksums: checksumRecordsFor(manifest, readBuffer),
      }),
    ).toThrow(/hash/i);
  });

  it("fails closed when the release checksums do not cover the Runner or its manifest", () => {
    const manifest = sandboxManifest(hash(runnerBytes));
    const readBuffer = bufferFor(manifest);
    for (const omitted of [runnerRelativePath, manifestRelativePath]) {
      expect(() =>
        verifyPackagedSandboxRunner({
          entries: new Set([runnerRelativePath, manifestRelativePath]),
          readBuffer,
          sandboxManifest: manifest,
          checksums: checksumRecordsFor(manifest, readBuffer, omitted),
        }),
      ).toThrow(/checksum/i);
    }
  });

  it("fails closed when the manifest names an executable that is not packaged", () => {
    const manifest = sandboxManifest(hash(runnerBytes));
    const readBuffer = bufferFor(manifest);
    expect(() =>
      verifyPackagedSandboxRunner({
        entries: new Set([manifestRelativePath]),
        readBuffer,
        sandboxManifest: manifest,
        checksums: checksumRecordsFor(manifest, readBuffer),
      }),
    ).toThrow(/not packaged/i);
  });

  function sandboxManifest(sha256: string) {
    return {
      schemaVersion: 1 as const,
      product: "caelush" as const,
      controlProtocolVersion: 1 as const,
      platform: "windows" as const,
      arch: "x64",
      executableName: "caelush-sandbox-runner.exe",
      sha256,
      providers: ["windows-acl-restricted-token"],
    };
  }

  function bufferFor(manifest: ReturnType<typeof sandboxManifest>) {
    return (path: string) =>
      path === runnerRelativePath ? runnerBytes : Buffer.from(JSON.stringify(manifest));
  }

  function checksumRecordsFor(
    manifest: ReturnType<typeof sandboxManifest>,
    readBuffer: (path: string) => Buffer,
    omitted?: string,
  ): string {
    return [runnerRelativePath, manifestRelativePath]
      .filter((path) => path !== omitted)
      .map((path) => `${hash(readBuffer(path))}  ${path}\n`)
      .join("");
  }

  it("keeps the packaged Runner bytes distinct from the tampered fixture", () => {
    expect(hash(runnerBytes)).not.toBe(hash(changedRunnerBytes));
  });
});
