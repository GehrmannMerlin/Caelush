import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import {
  SANDBOX_RUNNER_DIRECTORY_NAME,
  SANDBOX_RUNNER_MANIFEST_FILENAME,
} from "./build-sandbox-runner.mjs";
import { validateReleaseManifest } from "./build-release.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseDirectory = join(repositoryRoot, "release-artifacts");
const MAX_TAR_INSPECTION_BYTES = 128 * 1024 * 1024;

export function inspectReleaseArtifact(artifactPath) {
  const inspectionDirectory = mkdtempSync(join(tmpdir(), "caelush-release-inspect-"));
  try {
    extractReleaseArtifact(artifactPath, inspectionDirectory);
    const releaseManifest = JSON.parse(readExtractedText(inspectionDirectory, "manifest.json"));
    validateReleaseManifest(releaseManifest);
    const entries = listExtractedEntries(inspectionDirectory);
    verifyChecksumRecords(
      (path) => readExtractedBuffer(inspectionDirectory, path),
      entries,
      readExtractedText(inspectionDirectory, "checksums.sha256"),
    );
    const manifestChecksum = readExtractedText(inspectionDirectory, "manifest.sha256")
      .trim()
      .split(/\s+/)[0];
    const actualManifestChecksum = createHash("sha256")
      .update(readExtractedBuffer(inspectionDirectory, "manifest.json"))
      .digest("hex");
    if (manifestChecksum !== actualManifestChecksum) {
      throw new Error("Release manifest checksum mismatch.");
    }

    if (releaseManifest.sandboxRunner === "PACKAGED") {
      verifyPackagedSandboxRunner({
        entries,
        readBuffer: (path) => readExtractedBuffer(inspectionDirectory, path),
        sandboxManifest: releaseManifest.sandboxRunnerManifest,
        checksums: readExtractedText(inspectionDirectory, "checksums.sha256"),
      });
    }
    return releaseManifest;
  } finally {
    rmSync(inspectionDirectory, { recursive: true, force: true });
  }
}

/**
 * The packaged Runner is only trustworthy when it is present, byte-identical to the hash
 * the release manifest advertises, and covered by the archive checksum records.
 */
export function verifyPackagedSandboxRunner({ entries, readBuffer, sandboxManifest, checksums }) {
  const runnerRelativePath = `${SANDBOX_RUNNER_DIRECTORY_NAME}/${sandboxManifest.executableName}`;
  const manifestRelativePath = `${SANDBOX_RUNNER_DIRECTORY_NAME}/${SANDBOX_RUNNER_MANIFEST_FILENAME}`;
  if (!entries.has(runnerRelativePath)) {
    throw new Error("Release sandbox manifest names an executable that is not packaged.");
  }
  if (!entries.has(manifestRelativePath)) {
    throw new Error("Release claims a packaged sandbox runner but its manifest is missing.");
  }
  const measured = createHash("sha256").update(readBuffer(runnerRelativePath)).digest("hex");
  if (measured !== sandboxManifest.sha256) {
    throw new Error("Packaged sandbox runner hash does not match its manifest.");
  }
  const covered = new Set(parseChecksumRecords(checksums).map((record) => record.path));
  for (const required of [runnerRelativePath, manifestRelativePath]) {
    if (!covered.has(required)) {
      throw new Error(`Release checksums do not cover the packaged sandbox runner: ${required}`);
    }
  }
}

export function verifyChecksums(artifactPath, entries, checksums) {
  verifyChecksumRecords((path) => readTarBuffer(artifactPath, path), entries, checksums);
}

function verifyChecksumRecords(readBuffer, entries, checksums) {
  const records = parseChecksumRecords(checksums);
  if (records.length === 0) throw new Error("Release checksum manifest is empty.");
  for (const record of records) {
    if (!entries.has(record.path)) {
      throw new Error(`Release checksum entry is not packaged: ${record.path}`);
    }
    const actual = createHash("sha256").update(readBuffer(record.path)).digest("hex");
    if (actual !== record.hash) throw new Error(`Release checksum mismatch: ${record.path}`);
  }
}

function parseChecksumRecords(checksums) {
  return checksums
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^(?<hash>[0-9a-f]{64})\x20{2}(?<path>.+)$/.exec(line);
      if (match === null) throw new Error("Invalid release checksum record.");
      return { hash: match.groups.hash, path: match.groups.path };
    });
}

function readTarBuffer(artifactPath, path) {
  const result = spawnSync("tar", ["-xOzf", artifactPath, `./${path}`], {
    encoding: null,
    maxBuffer: MAX_TAR_INSPECTION_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`Unable to inspect release entry: ${path}`);
  return result.stdout;
}

function extractReleaseArtifact(artifactPath, inspectionDirectory) {
  const result = spawnSync("tar", ["-xzf", artifactPath, "-C", inspectionDirectory], {
    encoding: "utf8",
    maxBuffer: MAX_TAR_INSPECTION_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `Unable to extract release archive: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
}

function readExtractedText(directory, path) {
  return readExtractedBuffer(directory, path).toString("utf8");
}

function readExtractedBuffer(directory, path) {
  return readFileSync(join(directory, ...path.split("/")));
}

function listExtractedEntries(directory) {
  const entries = new Set();
  const visit = (currentDirectory) => {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const entryPath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      entries.add(relative(directory, entryPath).replaceAll("\\", "/"));
    }
  };
  visit(directory);
  return entries;
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
