import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 12C timeline boundaries", () => {
  it("keeps the CLI as a client-only projection host with one settled Static", async () => {
    const files = await sourceFiles(resolve("apps/cli/src"));
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

    expect(source).toMatch(/@caelush\/client/);
    expect(source).toMatch(/@caelush\/protocol/);
    expect(source).not.toMatch(/@caelush\/(core|storage|runtime|security|tools|verification|llm)/);
    expect(source).not.toMatch(/setTimeout|setInterval|fetch\s*\(|node:fs|toolCallId/);
    expect(source.match(/<Static\b/g)).toHaveLength(1);
  });

  it("keeps presentation direction and raw argument boundaries intact", async () => {
    const toolsSource = await readFile(resolve("packages/tools/src/presentation.ts"), "utf8");
    const eventFactory = await readFile(resolve("packages/tools/src/event-factory.ts"), "utf8");
    const securitySource = await readFile(resolve("packages/security/src/presentation.ts"), "utf8");

    expect(toolsSource).not.toContain("@caelush/security");
    expect(securitySource).toContain("@caelush/tools");
    expect(eventFactory).not.toMatch(/invocation\.args|payload:.*args/);
    expect(eventFactory).toContain("createToolOutputEvent");
  });

  it("records the fixed Phase 12C scope and deferred next round", async () => {
    const documents = await Promise.all([
      readFile(resolve("docs/architecture/cli-agent-timeline.md"), "utf8"),
      readFile(resolve("docs/architecture/cli-presentation-security.md"), "utf8"),
      readFile(resolve("README.md"), "utf8"),
      readFile(resolve("AGENTS.md"), "utf8"),
    ]);
    const text = documents.join("\n");

    expect(text).toContain("Phase 12C");
    expect(text).toContain("displayHistory");
    expect(text).toContain("WAITING_APPROVAL");
    expect(text).toContain("no automatic reconnect");
    expect(text).toContain("12D");
  });
});

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
