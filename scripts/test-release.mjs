import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseDirectory = join(repositoryRoot, "release-artifacts");
const artifact = (await readdir(releaseDirectory))
  .filter((name) => name.endsWith(".tgz"))
  .sort()
  .at(-1);
if (artifact === undefined)
  throw new Error("No release artifact was found. Run pnpm build:release first.");

const artifactPath = join(releaseDirectory, artifact);
const manifestResult = spawnSync("tar", ["-xOzf", artifactPath, "./manifest.json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (manifestResult.status !== 0) {
  throw new Error(`Unable to inspect release manifest: ${manifestResult.stderr}`);
}
const releaseManifest = JSON.parse(manifestResult.stdout);
if (releaseManifest.sandboxRunner === "PACKAGED") {
  const listing = spawnSync("tar", ["-tzf", artifactPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (listing.status !== 0) {
    throw new Error(`Unable to inspect packaged sandbox runner: ${listing.stderr}`);
  }
  const entries = new Set(
    listing.stdout
      .split(/\r?\n/)
      .map((entry) => entry.replace(/^\.\//, ""))
      .filter(Boolean),
  );
  const runnerManifest = "sandbox-runner/manifest.json";
  if (!entries.has(runnerManifest)) {
    throw new Error("Release claims a packaged sandbox runner but its manifest is missing.");
  }
  const runnerManifestResult = spawnSync("tar", ["-xOzf", artifactPath, `./${runnerManifest}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (runnerManifestResult.status !== 0) {
    throw new Error(`Unable to inspect packaged sandbox manifest: ${runnerManifestResult.stderr}`);
  }
  const sandboxManifest = JSON.parse(runnerManifestResult.stdout);
  const runnerEntry = `sandbox-runner/${sandboxManifest.executableName}`;
  if (!entries.has(runnerEntry)) {
    throw new Error("Release sandbox manifest names an executable that is not packaged.");
  }
}

const result = spawnSync(
  process.execPath,
  [join(repositoryRoot, "scripts", "artifact-e2e.mjs"), join(releaseDirectory, artifact)],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
  },
);
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
