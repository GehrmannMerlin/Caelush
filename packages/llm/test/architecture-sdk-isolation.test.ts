import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const allowedAdapterRoot = join(root, "packages/llm/src/providers/openai-compatible");
const scannedRoots = [
  "packages/core/src",
  "packages/protocol/src",
  "packages/events/src",
  "packages/storage/src",
  "apps/daemon/src",
  "packages/llm/src",
].map((path) => join(root, path));

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("AI SDK architecture isolation", () => {
  it("allows runtime SDK imports only inside the OpenAI-compatible adapter", () => {
    const violations = scannedRoots
      .flatMap(sourceFiles)
      .filter((path) => !path.startsWith(allowedAdapterRoot))
      .filter((path) => /(?:from|import\()\s*["'](?:ai|@ai-sdk\/)/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path));

    expect(violations).toEqual([]);
  });

  it("keeps AI SDK types out of the built public declaration", () => {
    const declarationPath = join(root, "packages/llm/dist/index.d.ts");
    expect(existsSync(declarationPath)).toBe(true);
    const declaration = readFileSync(declarationPath, "utf8");
    expect(declaration).not.toMatch(/from ["'](?:ai|@ai-sdk\/)/);
    expect(declaration).not.toMatch(/StreamTextResult|ModelMessage|ToolSet|LanguageModel/);
  });
});
