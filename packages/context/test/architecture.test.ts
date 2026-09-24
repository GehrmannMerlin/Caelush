import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve("packages/context/src");
const forbidden = [
  /process\.env/,
  /node:child_process/,
  /\b(?:spawn|exec|execFile)\s*\(/,
  /\bfetch\s*\(/,
  /from\s+["'](?:node:http|node:https|http|https|ai["']|@ai-sdk\/)/,
  /\bany\b/,
];

async function sourcePaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? sourcePaths(entryPath)
        : entry.name.endsWith(".ts")
          ? [entryPath]
          : [];
    }),
  );
  return paths.flat();
}

describe("context architecture guards", () => {
  it("keeps production context source free of execution, network, secrets, and provider coupling", async () => {
    const files = await sourcePaths(sourceRoot);
    const contents = await Promise.all(files.map((filePath) => readFile(filePath, "utf8")));

    for (const content of contents) {
      for (const pattern of forbidden) expect(content).not.toMatch(pattern);
    }
  });

  it("keeps generated public declarations independent from Node filesystem implementation types", async () => {
    const declaration = await readFile(path.resolve("packages/context/dist/index.d.ts"), "utf8");

    expect(declaration).not.toMatch(
      /\b(?:Stats|Dirent|FileHandle|IgnoreRuleLayer|matcher|PendingDirectory)\b/i,
    );
    expect(declaration).not.toContain("LocalContextFileSystem");
    expect(declaration).toContain("RelevantFilePlanner");
    expect(declaration).toContain("RelevantFileContextPlan");
  });

  it("uses the provider-independent AI message contract", async () => {
    const files = await sourcePaths(sourceRoot);
    const contents = await Promise.all(files.map((filePath) => readFile(filePath, "utf8")));
    const imports = contents.flatMap((content) =>
      [...content.matchAll(/from\s+["'](@caelush\/ai(?:\/[^"']*)?)["']/g)].map(
        (match) => match[1],
      ),
    );
    expect(imports).toContain("@caelush/ai");
    expect(imports.filter((value) => value !== "@caelush/ai")).toEqual([]);
  });

  it("keeps the public context declaration free of provider and SDK types", async () => {
    const declaration = await readFile(path.resolve("packages/context/dist/index.d.ts"), "utf8");
    const builderDeclaration = await readFile(
      path.resolve("packages/context/dist/context-builder.d.ts"),
      "utf8",
    );
    expect(builderDeclaration).toContain("AIMessage");
    expect(builderDeclaration).toContain("@caelush/ai");
    expect(`${declaration}\n${builderDeclaration}`).not.toMatch(
      /(?:@ai-sdk\/|StreamTextResult|LanguageModel|ToolSet|ModelMessage)/,
    );
  });
});
