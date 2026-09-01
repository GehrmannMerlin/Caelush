import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve("apps/cli/src");

describe("CLI architecture boundary", () => {
  it("keeps Core, Runtime, Tool, Storage, and direct HTTP out of CLI source", async () => {
    const files = await sourceFiles(sourceRoot);
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

    expect(source).not.toMatch(
      /@caelush\/(core|storage|runtime|security|tools|context|verification|llm)/,
    );
    expect(source).not.toMatch(/node:fs|spawn\s*\(|\bfetch\s*\(/);
    expect(source).not.toMatch(/toolCallId|hidden reasoning/);
  });

  it("has architecture records for the Session and CLI lifecycle", async () => {
    const documents = await Promise.all([
      readFile(resolve("docs/architecture/cli-application-shell.md"), "utf8"),
      readFile(resolve("docs/architecture/session-conversation-lifecycle.md"), "utf8"),
      readFile(resolve("docs/architecture/client-transport.md"), "utf8"),
      readFile(resolve("docs/architecture/daemon-production-composition.md"), "utf8"),
    ]);
    const documentation = documents.join("\n");

    for (const phrase of [
      "one Session per CLI process",
      "one Run per prompt",
      "finishedAt <= currentRun.createdAt",
      "MAX_SESSION_HISTORY_RUNS = 100",
      "historyPrefix",
      "<Static>",
      "@caelush/client",
      "no automatic reconnect",
      "VerifiedRunFinalResultSchema",
    ]) {
      expect(documentation).toContain(phrase);
    }
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}
