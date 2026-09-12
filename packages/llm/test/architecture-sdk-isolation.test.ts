import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

/**
 * Repository roots that must never contain a provider SDK import.
 *
 * Phase 2A allowed one exception, inside
 * `packages/llm/src/providers/openai-compatible`. Phase 2B moved that runtime into
 * `@caelush/ai`, so the exception is gone and the rule is now absolute: the only
 * place a provider SDK may be imported is
 * `packages/ai/src/adapters/openai-compatible`.
 *
 * This test is the legacy-side counterpart of the AI package's own SDK ownership
 * test, and it is deliberately not the same assertion: it fails if the OpenAI
 * runtime ever reappears in the legacy package or anywhere else in the kernel.
 */
const scannedRoots = [
  "packages/core/src",
  "packages/protocol/src",
  "packages/events/src",
  "packages/storage/src",
  "packages/context/src",
  "packages/llm/src",
  "apps/daemon/src",
].map((path) => join(root, path));

const PROVIDER_SDK_IMPORT =
  /(?:from|import\()\s*["'](?:ai|@ai-sdk\/|openai|@anthropic-ai\/|@aws-sdk\/|@google\/)/;

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("provider SDK architecture isolation", () => {
  it("allows no provider SDK import anywhere outside the AI adapter", () => {
    const violations = scannedRoots
      .flatMap(sourceFiles)
      .filter((path) => PROVIDER_SDK_IMPORT.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path));

    expect(violations).toEqual([]);
  });

  it("keeps the legacy package free of the deleted translator files", () => {
    const legacyAdapterRoot = join(root, "packages/llm/src/providers/openai-compatible");
    const remaining = readdirSync(legacyAdapterRoot).sort();

    expect(remaining).toEqual(["config.ts", "index.ts", "provider.ts"]);
  });

  it("keeps AI SDK types out of the legacy public declaration", () => {
    const declarationPath = join(root, "packages/llm/dist/index.d.ts");
    expect(existsSync(declarationPath)).toBe(true);
    const declaration = readFileSync(declarationPath, "utf8");

    expect(declaration).not.toMatch(/from ["'](?:ai|@ai-sdk\/)/);
    expect(declaration).not.toMatch(/StreamTextResult|ModelMessage|ToolSet|LanguageModel/);
  });

  it("keeps AI SDK types out of the AI adapter's public declaration", () => {
    const declarationPath = join(root, "packages/ai/dist/adapters/openai-compatible/index.d.ts");
    expect(existsSync(declarationPath)).toBe(true);
    const declaration = readFileSync(declarationPath, "utf8");

    expect(declaration).not.toMatch(/from ["'](?:ai|@ai-sdk\/)/);
    expect(declaration).not.toMatch(/StreamTextResult|ModelMessage|ToolSet|LanguageModel/);
  });
});
