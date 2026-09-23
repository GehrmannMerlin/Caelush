import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 12C timeline boundaries", () => {
  it("keeps the CLI as a client-only projection host with one canonical History", async () => {
    const files = await sourceFiles(resolve("apps/cli/src"));
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

    expect(source).toMatch(/@caelush\/client/);
    expect(source).toMatch(/@caelush\/protocol/);
    // Phase 4F deleted `@caelush/tools`: the Tool System's live packages are the general kernel
    // `@caelush/agent` and the Coding product layer `@caelush/coding-agent`, and a client-only host
    // reaches neither.
    expect(source).not.toMatch(
      /@caelush\/(core|storage|runtime|security|agent|coding-agent|verification|llm)/,
    );
    // Phase 12D adds an injected reconnect scheduler and one system timer adapter.
    expect(source).not.toMatch(/fetch\s*\(|node:fs|toolCallId/);
    // Phase 5E makes canonical transcript replacement visible in the CLI, so History renders the
    // current bounded projection rather than using Ink Static's append-only collection semantics.
    expect(source.match(/<History\b/g)).toHaveLength(1);
    expect(source).toContain("entries.map((entry)");
  });

  it("keeps presentation direction and raw argument boundaries intact", async () => {
    // Phase 4F deleted `@caelush/tools`. The presentation *ports* are part of the general Tool Kernel
    // in `@caelush/agent`, the durable Tool events are the kernel's, and the Coding/Security side
    // consumes the ports rather than the reverse.
    const presentationPorts = await readFile(
      resolve("packages/agent/src/tools/types/tool-presentation.ts"),
      "utf8",
    );
    const eventFactory = await readFile(
      resolve("packages/agent/src/tools/durable/durable-events.ts"),
      "utf8",
    );
    const securitySource = await readFile(resolve("packages/security/src/presentation.ts"), "utf8");

    // Presentation is a projection of the Tool layer, never an input to Security policy: the port
    // names no Security implementation, and Security imports the port rather than the reverse.
    expect(presentationPorts).not.toContain("@caelush/security");
    expect(securitySource).toContain("@caelush/agent");
    expect(securitySource).not.toMatch(/from\s+["']@caelush\/tools["']/);
    // The durable Tool events carry identifiers and sanitized presentation text only: raw invocation
    // arguments never enter an event payload.
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
