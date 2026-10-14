import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertOwnedOutputPath } from "./owned-output-path.mjs";

export function cleanDesktopDevelopmentOutput(appRoot, options = {}) {
  return cleanOwnedOutput(
    appRoot,
    ["dist", ".stage/daemon", ".stage/web", ".stage/electron-runtime"],
    options,
  );
}

export function cleanDesktopReleaseOutput(repositoryRoot, options = {}) {
  return cleanOwnedOutput(
    repositoryRoot,
    ["release-artifacts/desktop", "apps/desktop/.build-resources"],
    options,
  );
}

async function cleanOwnedOutput(root, names, { dryRun = false } = {}) {
  const targets = [];
  // Validate the entire plan before deleting any target.
  for (const name of names) {
    const target = await assertOwnedOutputPath(root, path.resolve(root, name));
    try {
      await lstat(target);
      targets.push(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!dryRun) {
    for (const target of targets) await rm(target, { recursive: true, force: true });
  }
  return targets;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [scope, ...flags] = process.argv.slice(2);
  if (!["dev", "release"].includes(scope) || flags.some((flag) => flag !== "--dry-run")) {
    throw new Error("Usage: clean-owned-output.mjs <dev|release> [--dry-run]");
  }
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dryRun = flags.includes("--dry-run");
  const targets = await (scope === "dev"
    ? cleanDesktopDevelopmentOutput(appRoot, { dryRun })
    : cleanDesktopReleaseOutput(path.resolve(appRoot, "../.."), { dryRun }));
  process.stdout.write(
    `${dryRun ? "Would remove" : "Removed"} ${targets.length} generated output directories.\n`,
  );
  for (const target of targets) process.stdout.write(`${target}\n`);
}
