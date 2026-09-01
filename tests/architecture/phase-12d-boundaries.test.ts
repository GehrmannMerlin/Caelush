import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 12D interactive control boundaries", () => {
  it("keeps CLI control authority behind the public client contract", async () => {
    const source = await sourceTree(resolve("apps/cli/src"));

    expect(source).toMatch(/@caelush\/client/);
    expect(source).toMatch(/@caelush\/protocol/);
    expect(source).not.toMatch(
      /@caelush\/(?:core|storage|runtime|security|tools|verification|llm)/,
    );
    expect(source).not.toMatch(/\/api\/v1\//);
    expect(source).not.toMatch(
      /new\s+(?:RunController|AgentLoop|ToolDispatcher|LocalRuntime)\s*\(/,
    );
  });

  it("keeps control modes and transport state out of Protocol RunStatus", async () => {
    const source = await sourceTree(resolve("apps/cli/src"));

    expect(source).toContain('"CANCELLING"');
    expect(source).toContain('"RECONNECTING"');
    expect(source).not.toContain('"WAITING_RETRY"');
    expect(source).not.toContain('"TIMEOUT_PENDING"');
    expect(source).not.toContain('"BUDGET_EXCEEDED_PENDING"');
  });

  it("renders only the allowlisted Approval projection", async () => {
    const files = await sourceFiles(resolve("apps/cli/src/components"));
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

    expect(source).toContain("approval.title");
    expect(source).toContain("approval.reason");
    expect(source).toContain("approval.riskLevel");
    expect(source).not.toMatch(/approval\.action|approval\.raw|JSON\.stringify\s*\(\s*approval/);
  });

  it("records the fixed Phase 12D scope and the deferred Phase 12E boundary", async () => {
    const documents = await Promise.all([
      readFile(resolve("docs/architecture/cli-interactive-control.md"), "utf8"),
      readFile(resolve("docs/architecture/cli-session-recovery.md"), "utf8"),
      readFile(resolve("docs/architecture/cli-transport-recovery.md"), "utf8"),
      readFile(resolve("README.md"), "utf8"),
      readFile(resolve("AGENTS.md"), "utf8"),
    ]);
    const text = documents.join("\n");

    expect(text).toContain("Phase 12D");
    expect(text).toContain("Phase 12E");
    expect(text).toContain("WAITING_APPROVAL");
    expect(text).toContain("Ctrl+D");
    expect(text).toContain("afterSequence");
  });
});

async function sourceTree(directory: string): Promise<string> {
  const files = await sourceFiles(directory);
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(file)));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(file);
  }
  return files;
}
