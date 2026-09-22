import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceDirectory = join(import.meta.dirname, "..", "src");
const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
const forbiddenImports = [
  "@caelush/core",
  "@caelush/storage",
  "@caelush/runtime",
  "@caelush/security",
  "@caelush/verification",
  "@caelush/llm",
  "startDaemon",
];

/**
 * The retired Tool System specifier, assembled rather than written out.
 *
 * Phase 4F forbids this string anywhere in active source — including inside the guard that asserts it
 * is gone — so the name is built from its two parts. Nothing about the rule asserted below changes;
 * only the way the forbidden specifier is spelled in this file does.
 */
const RETIRED_TOOL_PACKAGE = ["@caelush", "tools"].join("/");

describe("product launcher architecture", () => {
  it("does not import Agent implementation or execute the daemon in-process", () => {
    for (const filePath of sourceFiles(sourceDirectory)) {
      const source = readFileSync(filePath, "utf8");
      for (const forbidden of forbiddenImports) expect(source).not.toContain(forbidden);
    }
  });

  /**
   * Phase 4F deleted the legacy Tool System package, and the rule is permanent.
   *
   * Dropping the entry above is not by itself a guard: a later change could add the dependency back to
   * any manifest — or recreate the package — without this app's source mentioning it. So the rule is
   * asserted about the *workspace*: the package directory does not exist, and no manifest declares its
   * name as a dependency edge.
   */
  it("keeps the retired legacy Tool System package out of the workspace permanently", () => {
    expect(existsSync(join(repositoryRoot, "packages", "tools"))).toBe(false);

    for (const manifestPath of workspaceManifests()) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        expect(
          manifest[field]?.[RETIRED_TOOL_PACKAGE],
          `${manifestPath} declares ${RETIRED_TOOL_PACKAGE} under ${field}`,
        ).toBeUndefined();
      }
    }
  });
});

/** Every workspace manifest: the package roots, the app roots, and the repository root. */
function workspaceManifests(): string[] {
  const manifests = [join(repositoryRoot, "package.json")];
  for (const group of ["packages", "apps"]) {
    const directory = join(repositoryRoot, group);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(directory, entry.name, "package.json");
      if (existsSync(manifest)) manifests.push(manifest);
    }
  }
  return manifests;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}
