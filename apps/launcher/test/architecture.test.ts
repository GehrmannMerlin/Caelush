import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceDirectory = join(import.meta.dirname, "..", "src");
const forbiddenImports = [
  "@caelush/core",
  "@caelush/storage",
  "@caelush/runtime",
  "@caelush/security",
  "@caelush/tools",
  "@caelush/verification",
  "@caelush/llm",
  "startDaemon",
];

describe("product launcher architecture", () => {
  it("does not import Agent implementation or execute the daemon in-process", () => {
    for (const filePath of sourceFiles(sourceDirectory)) {
      const source = readFileSync(filePath, "utf8");
      for (const forbidden of forbiddenImports) expect(source).not.toContain(forbidden);
    }
  });
});

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}
