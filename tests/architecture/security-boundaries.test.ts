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
  it("keeps Security above only Protocol, the Agent Tool contract and its own implementation", async () => {
    const sourceRoot = path.join(repositoryRoot, "packages", "security", "src");
    const files = await sourceFiles(sourceRoot);
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const source = sources.join("\n");

    expect(source).toMatch(/from\s+["']@caelush\/protocol["']/);
    // The Tool Gate contract lives in the Agent Tool framework, which is where the layer that consumes
    // the decision can reach it without a build-order cycle against the Coding product layer.
    expect(source).toMatch(/from\s+["']@caelush\/agent["']/);
    // The Coding security-fact vocabulary and the Coding metadata types are the overlay this Gate
    // evaluates; they are consumed as types, never as an implementation.
    expect(source).toMatch(/from\s+["']@caelush\/coding-agent["']/);
    // The retired legacy Tool System must never come back.
    expect(source).not.toMatch(/from\s+["']@caelush\/tools["']/);

    expect(source).not.toMatch(
      /from\s+["']@caelush\/(?:runtime|core|storage|events|llm|context|verification|daemon|cli|web)["']/,
    );
    expect(source).not.toMatch(/from\s+["']node:(?:fs|child_process|net|http|https)["']/);
  });

  it("keeps policy evaluation pure, metadata-only, and non-secret", async () => {
    const sourceRoot = path.join(repositoryRoot, "packages", "security", "src");
    // The Phase 12C presentation adapter is intentionally the only Security
    // source allowed to inspect invocation arguments for safe UI summaries.
    const files = (await sourceFiles(sourceRoot)).filter(
      (file) => path.basename(file) !== "presentation.ts",
    );
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/invocation\.args|Date\.now|Math\.random|randomUUID/);
    expect(source).not.toMatch(/(?<!\.)\b(?:fetch|spawn|exec|readFile|writeFile)\s*\(/);
    expect(source).not.toContain("SECRET_COMMAND_9A_123");
    expect(source).not.toContain("SECRET_PATH_9A_456");
    expect(source).not.toContain("SECRET_TOKEN_9A_789");
  });

  it("keeps Security implementation detail out of the Coding Tool product layer", async () => {
    // The retired `packages/tools` suite asserted "Tools must not import Security". Phase 4F deleted
    // that package, and the equivalent permanent rule is now about the Coding product layer, which is
    // the only Tool product layer left: it owns the Coding security facts and must not reach into the
    // Security implementation, an evaluator, a Gate instance or the redaction helpers.
    const sourceRoot = path.join(repositoryRoot, "packages", "coding-agent", "src");
    const files = await sourceFiles(sourceRoot);
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8"))))
      // Comments stripped: a Coding module may *describe* the Security implementation it deliberately
      // does not use, and describing it is not depending on it.
      .map((text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))
      .join("\n");

    expect(source).not.toMatch(/from\s+["']@caelush\/security["']/);
    expect(source).not.toMatch(/\bCaelushToolExecutionGate\b/);
    for (const implementation of [
      "evaluateSecurityPolicy",
      "evaluateInputSecurityPolicy",
      "CaelushToolResultSanitizer",
      "CaelushToolPresentation",
      "redactText(",
      "detectSecrets(",
    ]) {
      expect(source, implementation).not.toContain(implementation);
    }
  });

  it("keeps Phase 9C sanitizer injection explicit and documents the Phase 9D boundary", async () => {
    // The sanitizer is injected into the canonical result pipeline, so "explicit, never defaulted to a
    // no-op" is now a property of the composition and of the canonical pipeline contract.
    const composition = await readFile(
      path.join(repositoryRoot, "apps", "daemon", "src", "daemon-composition.ts"),
      "utf8",
    );
    expect(composition).toContain("sanitizer: toolSecurity.resultSanitizer");
    expect(composition).toContain("CaelushToolExecutionUpdateSanitizer");
    expect(composition).not.toContain("INSECURE_NOOP_SANITIZER");

    const securitySource = (
      await Promise.all(
        (await sourceFiles(path.join(repositoryRoot, "packages", "security", "src"))).map((file) =>
          readFile(file, "utf8"),
        ),
      )
    ).join("\n");
    expect(securitySource).not.toContain("INSECURE_NOOP_SANITIZER");
    expect(securitySource).not.toContain("SECRET_APPROVAL_9C_TOKEN");

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
