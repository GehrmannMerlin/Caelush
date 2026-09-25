import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const CONTEXT_ROOT = "packages/agent/src/context";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name).replaceAll("\\", "/");
      return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

async function code(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("Phase 7B Context Kernel architecture", () => {
  it("keeps the new Context Kernel pure and host-independent", async () => {
    const forbidden = [
      "node:fs",
      "node:path",
      "node:child_process",
      "@caelush/runtime",
      "@caelush/storage",
      "@caelush/context",
      "@caelush/coding-agent",
      'from "apps/',
      "fetch(",
      "sqlite",
      "drizzle",
      "AIMessage",
    ];
    for (const file of await sourceFiles(CONTEXT_ROOT)) {
      const text = await code(file);
      for (const value of forbidden) expect(text, `${file}: ${value}`).not.toContain(value);
    }
  });

  it("keeps one canonical declaration for Phase 7B domain contracts", async () => {
    const declarations: readonly [string, string][] = [
      [
        "export interface ContextHistoryUnit {",
        "packages/agent/src/context/history/semantic-history-unit.ts",
      ],
      [
        "export interface ToolProtocolUnit extends",
        "packages/agent/src/context/history/semantic-history-unit.ts",
      ],
      [
        "export interface ContextHistoryIndex {",
        "packages/agent/src/context/history/semantic-history-unit.ts",
      ],
      [
        "export interface ContextPlanner {",
        "packages/agent/src/context/planner/context-planner.ts",
      ],
      [
        "export interface ContextDocument {",
        "packages/agent/src/context/document/context-document.ts",
      ],
      [
        "export interface ContextDocumentBuilder {",
        "packages/agent/src/context/document/context-document.ts",
      ],
    ];
    const files = await sourceFiles(CONTEXT_ROOT);
    for (const [declaration, expected] of declarations) {
      const holders: string[] = [];
      for (const file of files) if ((await code(file)).includes(declaration)) holders.push(file);
      expect(holders).toEqual([expected]);
    }
  });

  it("keeps production Context compatibility and publishes the canonical public contracts", async () => {
    const adapter = await code("packages/core/src/legacy-context-runtime-adapter.ts");
    expect(adapter).toContain("@caelush/context");

    const root = await code("packages/agent/src/index.ts");
    for (const exported of [
      "createContextHistoryIndexer",
      "createContextPlanner",
      "createContextDocumentBuilder",
      "ContextHistoryUnit",
      "ContextPlan",
      "ContextDocument",
      "ContextDocumentBuilder",
      "ContextMandatoryInputTooLargeError",
    ]) {
      expect(root, exported).toContain(exported);
    }

    const packageJson = JSON.parse(await code("packages/agent/package.json")) as {
      readonly dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies).toEqual({
      "@caelush/ai": "workspace:*",
      "@caelush/protocol": "workspace:*",
      ajv: "8.20.0",
    });
  });

  it("does not introduce a provider materializer, compactor, rehydrator, or persistence path", async () => {
    const files = await sourceFiles(CONTEXT_ROOT);
    expect(files.some((file) => /materializer|compactor|rehydrator|persistence/i.test(file))).toBe(
      false,
    );
    for (const file of files) {
      const text = await code(file);
      expect(text, file).not.toContain("ContextMaterializer");
      expect(text, file).not.toContain("ContextCompactionPlanner");
      expect(text, file).not.toContain("ContextRehydratorPort");
      expect(text, file).not.toContain("ContextPlanRepository");
    }
  });
});
