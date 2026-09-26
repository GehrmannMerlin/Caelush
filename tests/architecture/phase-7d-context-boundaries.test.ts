import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

function source(path: string): string {
  return readFileSync(path, "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Phase 7D Context target architecture", () => {
  it("keeps Agent Context generic and host-independent while allowing its target closure", () => {
    const contextRoot = join(root, "packages", "agent", "src", "context");
    const forbidden = [
      "node:fs",
      "node:path",
      "node:child_process",
      "@caelush/runtime",
      "@caelush/storage",
      "@caelush/context",
      "@caelush/coding-agent",
      "@caelush/security",
      "@caelush/memory",
      "fetch(",
      "provider-sdk",
      "apps/daemon",
      "apps/cli",
      "apps/web",
      "sqlite",
      "drizzle",
    ];
    const offenders = sourceFiles(contextRoot).flatMap((file) => {
      const text = source(file);
      return forbidden
        .filter((token) => text.includes(token))
        .map((token) => `${relative(root, file)}: ${token}`);
    });
    expect(offenders).toEqual([]);
  });

  it("has one canonical declaration for every Phase 7D target contract", () => {
    const contextRoot = join(root, "packages", "agent", "src", "context");
    const declarations: readonly [string, string][] = [
      [
        "export interface StructuredCheckpoint {",
        "packages/agent/src/context/checkpoint/structured-checkpoint.ts",
      ],
      [
        "export interface ContextCompactionPlan {",
        "packages/agent/src/context/compaction/context-compaction-contracts.ts",
      ],
      [
        "export interface ContextSummarizerPort {",
        "packages/agent/src/context/compaction/context-compaction-contracts.ts",
      ],
      [
        "export interface ContextCheckpointRecordV2 {",
        "packages/agent/src/context/compaction/context-compaction-contracts.ts",
      ],
      [
        "export interface ContextAuthoritySnapshot {",
        "packages/agent/src/context/rehydration/context-authority-contracts.ts",
      ],
      [
        "export interface RehydratedContextState {",
        "packages/agent/src/context/rehydration/context-authority-contracts.ts",
      ],
      [
        "export interface ContextMaterializer {",
        "packages/agent/src/context/materializer/context-materializer.ts",
      ],
    ];
    const files = sourceFiles(contextRoot);
    for (const [declaration, expected] of declarations) {
      const holders = files
        .filter((file) => source(file).includes(declaration))
        .map((file) => relative(root, file).replaceAll("\\", "/"));
      expect(holders, declaration).toEqual([expected]);
    }
  });

  it("keeps Storage as the implementation direction and production compatibility unchanged", () => {
    const storageFiles = sourceFiles(join(root, "packages", "storage", "src"));
    expect(storageFiles.some((file) => source(file).includes("@caelush/agent"))).toBe(true);
    const agentFiles = sourceFiles(join(root, "packages", "agent", "src"));
    expect(agentFiles.some((file) => source(file).includes("@caelush/storage"))).toBe(false);
    expect(
      readFileSync(
        join(root, "packages", "core", "src", "legacy-context-runtime-adapter.ts"),
        "utf8",
      ),
    ).toContain("@caelush/context");
  });

  it("publishes the target contracts without adding a second production composition root", () => {
    const agentRoot = readFileSync(join(root, "packages", "agent", "src", "index.ts"), "utf8");
    for (const exported of [
      "createContextCompactionPlanner",
      "createContextSummarizationRunner",
      "createContextRehydrator",
      "createContextMaterializer",
      "ContextCheckpointRecordV2",
      "ContextAuthoritySnapshot",
      "RehydratedContextState",
    ]) {
      expect(agentRoot, exported).toContain(exported);
    }
    const daemonFiles = sourceFiles(join(root, "apps", "daemon", "src"));
    expect(daemonFiles.some((file) => source(file).includes("createContextMaterializer"))).toBe(
      false,
    );
  });
});
