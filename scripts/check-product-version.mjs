import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isValidSemVer } from "./contracts/semver.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_PACKAGES = new Set([
  "@caelush/daemon",
  "@caelush/desktop",
  "@caelush/launcher",
  "@caelush/web",
  "@caelush/protocol",
  "@caelush/client",
]);

/**
 * Check the canonical product version and all workspace package mirrors without changing files.
 * The existing release builder reads the Launcher package version; checking every mirror makes
 * its generated Release Manifest inherit the root product version without changing that builder.
 * @param {{ root?: string }} [options]
 */
export async function auditProductVersions(options = {}) {
  const root = path.resolve(options.root ?? REPOSITORY_ROOT);
  /** @type {string[]} */
  const errors = [];
  /** @type {{ path: string, name: string, version: string }[]} */
  const manifests = [];
  const rootManifestPath = path.join(root, "package.json");
  const rootManifest = await readManifest(rootManifestPath, errors);
  const canonicalVersion = rootManifest?.version;
  if (typeof canonicalVersion !== "string") {
    errors.push(`${relative(root, rootManifestPath)}: required canonical version is missing.`);
  } else if (!isValidSemVer(canonicalVersion)) {
    errors.push(
      `${relative(root, rootManifestPath)}: ${JSON.stringify(canonicalVersion)} is not valid SemVer 2.0.0.`,
    );
  }

  if (rootManifest !== undefined && typeof rootManifest.name === "string") {
    if (typeof rootManifest.version === "string") {
      manifests.push({
        path: relative(root, rootManifestPath),
        name: rootManifest.name,
        version: rootManifest.version,
      });
    }
  } else {
    errors.push(`${relative(root, rootManifestPath)}: root package name is missing.`);
  }

  const foundNames = new Set();
  for (const group of ["apps", "packages"]) {
    const groupRoot = path.join(root, group);
    let entries;
    try {
      entries = await readdir(groupRoot, { withFileTypes: true });
    } catch {
      errors.push(`${group}/: required workspace directory is missing.`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(groupRoot, entry.name, "package.json");
      let manifest;
      try {
        manifest = await readManifest(manifestPath, errors, { optional: true });
      } catch (error) {
        errors.push(`${relative(root, manifestPath)}: ${safeError(error)}.`);
        continue;
      }
      if (manifest === undefined) continue;
      const manifestPathText = relative(root, manifestPath);
      if (typeof manifest.name !== "string" || manifest.name.length === 0) {
        errors.push(`${manifestPathText}: package name is missing.`);
        continue;
      }
      if (foundNames.has(manifest.name)) {
        errors.push(`${manifestPathText}: duplicate workspace package name ${manifest.name}.`);
      }
      foundNames.add(manifest.name);
      if (typeof manifest.version !== "string" || manifest.version.length === 0) {
        errors.push(`${manifestPathText}: package version is missing.`);
        continue;
      }
      if (!isValidSemVer(manifest.version)) {
        errors.push(
          `${manifestPathText}: ${JSON.stringify(manifest.version)} is not valid SemVer 2.0.0.`,
        );
        continue;
      }
      manifests.push({ path: manifestPathText, name: manifest.name, version: manifest.version });
      if (typeof canonicalVersion === "string" && manifest.version !== canonicalVersion) {
        errors.push(
          `${manifestPathText}: version ${manifest.version} differs from canonical ${canonicalVersion} in package.json.`,
        );
      }
    }
  }

  for (const name of REQUIRED_PACKAGES) {
    if (!foundNames.has(name))
      errors.push(`apps/packages: required workspace package ${name} is missing.`);
  }

  const releaseBuilderPath = path.join(root, "scripts", "build-release.mjs");
  let releaseBuilder;
  try {
    releaseBuilder = await readFile(releaseBuilderPath, "utf8");
  } catch {
    errors.push("scripts/build-release.mjs: required release builder is missing.");
  }
  if (releaseBuilder !== undefined && !usesLauncherVersionForRelease(releaseBuilder)) {
    errors.push(
      "scripts/build-release.mjs: Release Manifest version must come from the deployed Launcher package.json version.",
    );
  }

  const releaseManifestPaths = await findReleaseManifests(path.join(root, "release-artifacts"));
  let releaseManifestCount = 0;
  for (const manifestPath of releaseManifestPaths) {
    // Release bundles use the existing `caelush-v<version>-<platform>-<arch>` directory
    // name. Other manifest.json files in this tree include Sandbox Runner manifests.
    if (!path.basename(path.dirname(manifestPath)).startsWith("caelush-v")) continue;
    const manifest = await readManifest(manifestPath, errors);
    if (manifest === undefined) continue;
    const manifestPathText = relative(root, manifestPath);
    releaseManifestCount += 1;
    if (
      manifest.product !== "caelush" ||
      manifest.schemaVersion !== 1 ||
      manifest.protocolVersion !== 1 ||
      typeof manifest.nodeRange !== "string" ||
      typeof manifest.sandboxRunner !== "string"
    ) {
      errors.push(`${manifestPathText}: malformed Caelush Release Manifest.`);
      continue;
    }
    if (typeof manifest.version !== "string" || !isValidSemVer(manifest.version)) {
      errors.push(`${manifestPathText}: Release Manifest version is missing or invalid SemVer.`);
    } else if (typeof canonicalVersion === "string" && manifest.version !== canonicalVersion) {
      errors.push(
        `${manifestPathText}: release version ${manifest.version} differs from canonical ${canonicalVersion}.`,
      );
    }
  }

  return {
    canonicalVersion: typeof canonicalVersion === "string" ? canonicalVersion : undefined,
    checkedManifestCount: manifests.length,
    releaseManifestCount,
    errors,
  };
}

/** @param {string} source */
export function usesLauncherVersionForRelease(source) {
  return (
    /const\s+launcherManifest\s*=\s*JSON\.parse\s*\(/.test(source) &&
    /const\s+version\s*=\s*launcherManifest\.version\s*;/.test(source) &&
    /createReleaseManifest\s*\(\s*\{\s*version\s*,/s.test(source)
  );
}

/** @param {string} filePath @param {string[]} errors @param {{optional?: boolean}} [options] */
async function readManifest(filePath, errors, options = {}) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    if (options.optional) return undefined;
    errors.push(`${filePath}: required package manifest is missing.`);
    return undefined;
  }
  try {
    const manifest = JSON.parse(source);
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new TypeError("manifest must be a JSON object");
    }
    return manifest;
  } catch (error) {
    errors.push(`${filePath}: invalid JSON (${safeError(error)}).`);
    return undefined;
  }
}

/** @param {string} directory @returns {Promise<string[]>} */
async function findReleaseManifests(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {string[]} */
  const manifests = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) manifests.push(...(await findReleaseManifests(entryPath)));
    else if (entry.isFile() && entry.name === "manifest.json") manifests.push(entryPath);
  }
  return manifests;
}

/** @param {string} root @param {string} pathName */
function relative(root, pathName) {
  return path.relative(root, pathName).split(path.sep).join("/");
}

/** @param {unknown} error */
function safeError(error) {
  return error instanceof Error ? error.message : "unknown error";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--root requires a directory path.");
      options.root = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await auditProductVersions(parseArguments(process.argv.slice(2)));
    if (result.errors.length > 0) {
      process.stderr.write(
        `Product version check FAIL (${String(result.errors.length)} issue(s))\n`,
      );
      for (const error of result.errors) process.stderr.write(`- ${error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `Product version check PASS: ${result.canonicalVersion}; ${String(result.checkedManifestCount)} package manifests; ${String(result.releaseManifestCount)} Release Manifest(s).\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`Product version check FAIL: ${safeError(error)}\n`);
    process.exitCode = 1;
  }
}
