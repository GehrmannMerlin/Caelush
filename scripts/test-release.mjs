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
