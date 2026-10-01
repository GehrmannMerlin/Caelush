import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReleaseManifest } from "./build-release.mjs";
import { inspectReleaseArtifact, verifyChecksums } from "./test-release.mjs";

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
      { encoding: "utf8" },
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
