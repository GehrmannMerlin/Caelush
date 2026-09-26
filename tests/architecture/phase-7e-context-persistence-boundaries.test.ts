import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") continue;
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

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

describe("Phase 7E Context persistence architecture", () => {
  it("keeps the Agent-owned audit closure generic and persistence-free", () => {
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
      "sqlite",
      "drizzle",
      "fetch(",
      "apps/daemon",
      "apps/cli",
      "apps/web",
    ];
    const offenders = sourceFiles(contextRoot).flatMap((file) => {
      const text = source(file);
      return forbidden
        .filter((token) => text.includes(token))
        .map((token) => `${relative(root, file)}: ${token}`);
    });
    expect(offenders).toEqual([]);
  });

  it("has one declaration for each Phase 7E Agent contract", () => {
    const contextRoot = join(root, "packages", "agent", "src", "context");
    const declarations: readonly [string, string][] = [
      [
        "export interface ContextArtifactMetadata {",
        "packages/agent/src/context/artifacts/context-artifact.ts",
      ],
      [
        "export interface ContextBuildReceipt {",
        "packages/agent/src/context/receipts/context-build-receipt.ts",
      ],
      [
        "export interface ContextUsageSnapshot {",
        "packages/agent/src/context/receipts/context-usage.ts",
      ],
      [
        "export interface ContextCompactionCommitPort {",
        "packages/agent/src/context/ports/context-compaction-commit-port.ts",
      ],
      [
        "export interface ContextFingerprintInput {",
        "packages/agent/src/context/contracts/context-fingerprint.ts",
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

  it("keeps Storage as the only implementation direction and preserves the legacy path", () => {
    const storageFiles = sourceFiles(join(root, "packages", "storage", "src"));
    expect(storageFiles.some((file) => source(file).includes("@caelush/agent"))).toBe(true);
    const agentFiles = sourceFiles(join(root, "packages", "agent", "src"));
    expect(agentFiles.some((file) => source(file).includes("@caelush/storage"))).toBe(false);
    expect(read("packages/core/src/legacy-context-runtime-adapter.ts")).toContain(
      "@caelush/context",
    );
    expect(read("packages/storage/src/storage.ts")).toContain("contextCompactionCommit");
    const agentIndex = read("packages/agent/src/index.ts");
    for (const exported of [
      "createContextReceiptBuilder",
      "ContextArtifactStorePort",
      "ContextBuildReceipt",
      "ContextUsageStorePort",
      "ContextCompactionCommitPort",
      "buildContextFingerprint",
    ]) {
      expect(agentIndex, exported).toContain(exported);
    }
  });

  it("does not create receipt/fingerprint tables or a second production event writer", () => {
    const production = [
      ...sourceFiles(join(root, "packages")),
      ...sourceFiles(join(root, "apps")),
    ].map((file) => source(file));
    const forbiddenPhysicalNames = [
      "context_receipts",
      "context_fingerprints",
      "context_usage_updated",
    ];
    for (const name of forbiddenPhysicalNames) {
      expect(
        production.some((text) => text.includes(name)),
        name,
      ).toBe(false);
    }
    const eventWriters = production.filter((text) =>
      text.includes("appendDurableEventsInTransaction"),
    );
    expect(eventWriters.length).toBeGreaterThan(0);
    expect(
      sourceFiles(join(root, "apps", "daemon", "src")).some((file) =>
        source(file).includes("appendDurableEventsInTransaction"),
      ),
    ).toBe(false);
  });

  it("keeps the target contracts out of daemon composition", () => {
    const daemonFiles = sourceFiles(join(root, "apps", "daemon", "src"));
    const forbidden = ["SqliteContextCompactionCommitStore", "createContextFingerprint"];
    const offenders = daemonFiles.flatMap((file) =>
      forbidden
        .filter((token) => source(file).includes(token))
        .map((token) => `${relative(root, file)}: ${token}`),
    );
    expect(offenders).toEqual([]);
  });
});
