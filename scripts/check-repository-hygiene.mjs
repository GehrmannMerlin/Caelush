/* global console */

import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".vite",
  ".turbo",
  "release-artifacts",
  "test-results",
]);

const FORBIDDEN_DIRECTORY_PATHS = new Set([
  ".superpowers",
  "docs/superpowers",
  "docs/plans",
  "docs/reports",
  "docs/characterization",
]);

const FORBIDDEN_FILE_PATTERNS = [
  /^PHASE_.+_ROUND_PLAN\.md$/u,
  /^.+_BLOCKED_EVIDENCE\.md$/u,
  /^task-.+-report\.md$/u,
  /^TASK_.+_REPORT\.md$/u,
];

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

export function isForbiddenRelativePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";

  for (let index = 1; index <= segments.length; index += 1) {
    const prefix = segments.slice(0, index).join("/");
    if (FORBIDDEN_DIRECTORY_PATHS.has(prefix)) return true;
  }

  return FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

async function walkRepository(root, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const violations = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    const normalized = normalizeRelativePath(relativePath);

    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    if (isForbiddenRelativePath(normalized)) {
      violations.push(normalized);
      if (entry.isDirectory()) continue;
    }

    if (entry.isDirectory()) {
      violations.push(...(await walkRepository(root, relativePath)));
    }
  }

  return violations;
}

export async function collectViolations(root = REPOSITORY_ROOT) {
  return [...new Set(await walkRepository(root))].sort((left, right) => left.localeCompare(right));
}

export async function main() {
  const violations = await collectViolations();
  if (violations.length > 0) {
    console.error("Repository hygiene check failed. Remove temporary artifacts:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }

  console.log("Repository hygiene check passed.");
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
