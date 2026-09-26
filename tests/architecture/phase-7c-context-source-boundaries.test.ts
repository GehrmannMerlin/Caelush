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

describe("Phase 7C Context Source architecture", () => {
  it("keeps Generic Agent Context independent of host implementations", () => {
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
    ];
    const offenders = sourceFiles(contextRoot).flatMap((file) => {
      const text = source(file);
      return forbidden
        .filter((token) => text.includes(token))
        .map((token) => `${relative(root, file)}: ${token}`);
    });
    expect(offenders).toEqual([]);
  });

  it("keeps Coding Context on public Agent/Runtime boundaries without legacy or later-phase edges", () => {
    const contextRoot = join(root, "packages", "coding-agent", "src", "context");
    const forbidden = [
      "@caelush/context",
      "@caelush/core",
      "@caelush/storage",
      "apps/daemon",
      "apps/cli",
      "apps/web",
      "provider-sdk",
      "Date.now(",
      "Math.random(",
    ];
    const privateImports = /@caelush\/(?:agent|ai|protocol|runtime)\/src\//u;
    const offenders = sourceFiles(contextRoot).flatMap((file) => {
      const text = source(file);
      const values = forbidden.filter((token) => text.includes(token));
      if (privateImports.test(text)) values.push("private @caelush import");
      return values.map((token) => `${relative(root, file)}: ${token}`);
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the legacy production adapter and package dependency contracts unchanged", () => {
    expect(
      readFileSync(
        join(root, "packages", "core", "src", "legacy-context-runtime-adapter.ts"),
        "utf8",
      ),
    ).toContain("@caelush/context");
    expect(
      JSON.parse(readFileSync(join(root, "packages", "agent", "package.json"), "utf8")),
    ).toMatchObject({
      dependencies: {
        "@caelush/ai": "workspace:*",
        "@caelush/protocol": "workspace:*",
      },
    });
    expect(
      JSON.parse(readFileSync(join(root, "packages", "coding-agent", "package.json"), "utf8")),
    ).toMatchObject({
      dependencies: {
        "@caelush/agent": "workspace:*",
        "@caelush/runtime": "workspace:*",
      },
    });
  });

  it("publishes all frozen Source IDs from package roots and does not add Planner source branches", () => {
    const agentRoot = readFileSync(join(root, "packages", "agent", "src", "index.ts"), "utf8");
    const codingRoot = readFileSync(
      join(root, "packages", "coding-agent", "src", "index.ts"),
      "utf8",
    );
    const agentIds = readFileSync(
      join(root, "packages", "agent", "src", "context", "source", "source-ids.ts"),
      "utf8",
    );
    const codingIds = readFileSync(
      join(root, "packages", "coding-agent", "src", "context", "source-ids.ts"),
      "utf8",
    );
    expect(agentRoot).toContain("AGENT_CONTEXT_SOURCE_IDS");
    expect(codingRoot).toContain("CODING_CONTEXT_SOURCE_IDS");
    for (const id of [
      "agent.conversation",
      "agent.checkpoint",
      "agent.memory",
      "agent.extension-contributions",
      "agent.branch-context",
    ]) {
      expect(agentIds).toContain(id);
    }
    for (const id of [
      "coding.workspace",
      "coding.runtime-facts",
      "coding.project-instructions",
      "coding.project-metadata",
      "coding.relevant-files",
      "coding.skill-catalog",
      "coding.git-state",
      "coding.verification-repair",
      "coding.temporal",
    ]) {
      expect(codingIds).toContain(id);
    }
    const planner = readFileSync(
      join(root, "packages", "agent", "src", "context", "planner", "context-planner.ts"),
      "utf8",
    );
    expect(planner).not.toContain("coding.");
    expect(planner).not.toContain("AGENT_CONTEXT_SOURCE_IDS");
  });
});
