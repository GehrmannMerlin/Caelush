import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve("packages/context/src");
const forbidden = [
  /process\.env/,
  /node:child_process/,
  /\b(?:spawn|exec|execFile)\s*\(/,
  /\bfetch\s*\(/,
  /from\s+["'](?:node:http|node:https|http|https|@caelush\/llm|ai|@ai-sdk\/)/,
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

    expect(declaration).not.toMatch(/(?:Stats|Dirent|FileHandle)/);
    expect(declaration).not.toContain("LocalContextFileSystem");
  });
});
