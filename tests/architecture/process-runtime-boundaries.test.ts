import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot } from "./support/workspace.js";

async function sourceTree(relativeRoot: string): Promise<string> {
  const root = path.join(repositoryRoot, relativeRoot);
  const entries = await readdir(root, { recursive: true });
  const files = entries
    .filter((entry): entry is string => entry.endsWith(".ts"))
    .map((entry) => path.join(root, entry));
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

describe("Phase 8C process runtime boundaries", () => {
  it("keeps spawning inside runtime adapters and below the Tool layer", async () => {
    const runtime = await sourceTree("packages/runtime/src");
    const tools = await sourceTree("packages/tools/src");
    expect(runtime).not.toMatch(
      /from\s+["']@caelush\/(?:tools|core|storage|events|llm|security|verification)["']/,
    );
    expect(tools).not.toMatch(/from\s+["']node:(?:child_process|pty)["']/);
    expect(tools).not.toContain("node-pty");
    expect(runtime).not.toContain("shell: true");
    expect(runtime).not.toMatch(/\b(?:exec|execSync|execFile)\s*\(/);
  });

  it("does not add a process persistence or event side channel", async () => {
    const runtimePackage = await readFile(
      path.join(repositoryRoot, "packages/runtime/package.json"),
      "utf8",
    );
    const runtimeSource = await sourceTree("packages/runtime/src");
    expect(runtimePackage).not.toContain("@caelush/storage");
    expect(runtimeSource).not.toMatch(/EventBus|process\.started|process\.exited|activeProcesses/);
    expect(runtimeSource).not.toMatch(
      /(?:git_status|git_diff|PermissionEvaluator|ApprovalManager|VerificationRunner)/,
    );
  });
});
