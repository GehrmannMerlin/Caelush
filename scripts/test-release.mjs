import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { validateReleaseManifest } from "./build-release.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseDirectory = join(repositoryRoot, "release-artifacts");

export function inspectReleaseArtifact(artifactPath) {
  const releaseManifest = JSON.parse(readTarText(artifactPath, "manifest.json"));
  validateReleaseManifest(releaseManifest);
  const entries = listTarEntries(artifactPath);
  verifyChecksums(artifactPath, entries, readTarText(artifactPath, "checksums.sha256"));
  const manifestChecksum = readTarText(artifactPath, "manifest.sha256").trim().split(/\s+/)[0];
  const actualManifestChecksum = createHash("sha256")
    .update(readTarBuffer(artifactPath, "manifest.json"))
    .digest("hex");
  if (manifestChecksum !== actualManifestChecksum) {
    throw new Error("Release manifest checksum mismatch.");
  }

  if (releaseManifest.sandboxRunner === "PACKAGED") {
    const runnerManifestPath = "sandbox-runner/manifest.json";
    if (!entries.has(runnerManifestPath)) {
      throw new Error("Release claims a packaged sandbox runner but its manifest is missing.");
    }
    const sandboxManifest = JSON.parse(readTarText(artifactPath, runnerManifestPath));
    const runnerEntry = `sandbox-runner/${sandboxManifest.executableName}`;
    if (!entries.has(runnerEntry)) {
      throw new Error("Release sandbox manifest names an executable that is not packaged.");
    }
  }
  return releaseManifest;
}

export function verifyChecksums(artifactPath, entries, checksums) {
  const records = checksums
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^(?<hash>[0-9a-f]{64})\x20{2}(?<path>.+)$/.exec(line);
      if (match === null) throw new Error("Invalid release checksum record.");
      return { hash: match.groups.hash, path: match.groups.path };
    });
  if (records.length === 0) throw new Error("Release checksum manifest is empty.");
  for (const record of records) {
    if (!entries.has(record.path)) {
      throw new Error(`Release checksum entry is not packaged: ${record.path}`);
    }
    const actual = createHash("sha256")
      .update(readTarBuffer(artifactPath, record.path))
      .digest("hex");
    if (actual !== record.hash) throw new Error(`Release checksum mismatch: ${record.path}`);
  }
}

function readTarText(artifactPath, path) {
  return readTarBuffer(artifactPath, path).toString("utf8");
}

function readTarBuffer(artifactPath, path) {
  const result = spawnSync("tar", ["-xOzf", artifactPath, `./${path}`], {
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`Unable to inspect release entry: ${path}`);
  return result.stdout;
}

function listTarEntries(artifactPath) {
  const result = spawnSync("tar", ["-tzf", artifactPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`Unable to list release archive: ${result.stderr}`);
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((entry) => entry.replace(/^\.\//, ""))
      .filter(Boolean),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifact = (await readdir(releaseDirectory))
    .filter((name) => name.endsWith(".tgz"))
    .sort()
    .at(-1);
  if (artifact === undefined)
    throw new Error("No release artifact was found. Run pnpm build:release first.");

  const artifactPath = join(releaseDirectory, artifact);
  inspectReleaseArtifact(artifactPath);
  const result = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts", "artifact-e2e.mjs"), artifactPath],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
    },
  );
  if (result.error !== undefined) throw result.error;
  process.exitCode = result.status ?? 1;
}
