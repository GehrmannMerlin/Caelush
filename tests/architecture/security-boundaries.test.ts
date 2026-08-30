import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./support/workspace.js";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

describe("security architecture boundaries", () => {
  it("keeps Security above only Protocol and the Tool Gate port", async () => {
    const sourceRoot = path.join(repositoryRoot, "packages", "security", "src");
    const files = await sourceFiles(sourceRoot);
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const source = sources.join("\n");
    expect(source).toMatch(/from\s+["']@caelush\/protocol["']/);
    expect(source).toMatch(/from\s+["']@caelush\/tools["']/);
    expect(source).not.toMatch(
      /from\s+["']@caelush\/(?:runtime|core|storage|events|llm|context|verification|daemon|cli|web)["']/,
    );
    expect(source).not.toMatch(/from\s+["']node:(?:fs|child_process|net|http|https)["']/);
  });

  it("keeps policy evaluation pure, metadata-only, and non-secret", async () => {
    const sourceRoot = path.join(repositoryRoot, "packages", "security", "src");
    const files = await sourceFiles(sourceRoot);
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/invocation\.args|Date\.now|Math\.random|randomUUID/);
    expect(source).not.toMatch(/(?<!\.)\b(?:fetch|spawn|exec|readFile|writeFile)\s*\(/);
    expect(source).not.toContain("SECRET_COMMAND_9A_123");
    expect(source).not.toContain("SECRET_PATH_9A_456");
    expect(source).not.toContain("SECRET_TOKEN_9A_789");
  });

  it("does not make Tools depend on Security", async () => {
    const sourceRoot = path.join(repositoryRoot, "packages", "tools", "src");
    const files = await sourceFiles(sourceRoot);
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/from\s+["']@caelush\/security["']/);
  });

  it("keeps Phase 9C sanitizer injection explicit and documents the Phase 9D boundary", async () => {
    const sourceRoot = path.join(repositoryRoot, "packages", "tools", "src");
    const files = await sourceFiles(sourceRoot);
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).toContain("resultSanitizer");
    expect(source).not.toContain("INSECURE_NOOP_SANITIZER");
    expect(source).not.toContain("SECRET_APPROVAL_9C_TOKEN");

    const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
    expect(readme).toContain("Phase 9C");
    expect(readme).toContain("Phase 9D — V1 Security Integration");
    expect(
      await readFile(
        path.join(repositoryRoot, "docs", "architecture", "input-security-policy.md"),
        "utf8",
      ),
    ).toContain("monotonic");
    expect(
      await readFile(
        path.join(repositoryRoot, "docs", "architecture", "secret-redaction.md"),
        "utf8",
      ),
    ).toContain("ToolResultSanitizerPort");
  });
});
