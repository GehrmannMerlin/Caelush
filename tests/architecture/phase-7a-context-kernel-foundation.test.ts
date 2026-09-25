import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const contextRoot = join(root, "packages", "agent", "src", "context");

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

function source(path: string): string {
  return readFileSync(path, "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Phase 7A Context Kernel architecture", () => {
  it("keeps the target Context Kernel independent of host implementations and legacy Context", () => {
    const forbidden = [
      "node:fs",
      "node:path",
      "node:child_process",
      "@caelush/runtime",
      "@caelush/storage",
      "@caelush/context",
      "@caelush/coding-agent",
      "fetch(",
    ];
    const offenders = sourceFiles(contextRoot).flatMap((file) => {
      const text = source(file);
      return forbidden
        .filter((token) => text.includes(token))
        .map((token) => `${relative(root, file)}: ${token}`);
    });

    expect(offenders).toEqual([]);
  });

  it("publishes the Phase 7A contracts from the Agent package root", () => {
    const entry = readFileSync(join(root, "packages", "agent", "src", "index.ts"), "utf8");
    for (const contract of [
      "ContextFingerprint",
      "PreparedAgentContext",
      "ContextItem",
      "ContextSourceProvider",
      "ContextSourceRegistry",
      "ContextRequestOverhead",
      "ContextTokenEstimatorPort",
      "ContextPolicy",
    ]) {
      expect(entry).toContain(contract);
    }
  });

  it("keeps Phase 7A parallel to the legacy production Context path", () => {
    const agentManifest = JSON.parse(
      readFileSync(join(root, "packages", "agent", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(agentManifest.dependencies).toEqual({
      "@caelush/ai": "workspace:*",
      "@caelush/protocol": "workspace:*",
      ajv: "8.20.0",
    });
    expect(
      readFileSync(
        join(root, "packages", "core", "src", "legacy-context-runtime-adapter.ts"),
        "utf8",
      ),
    ).toContain("@caelush/context");
  });
});
