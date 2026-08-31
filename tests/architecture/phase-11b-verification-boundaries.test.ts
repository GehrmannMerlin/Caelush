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

async function packageSources(packageName: string): Promise<string> {
  const files = await sourceFiles(path.join(repositoryRoot, "packages", packageName, "src"));
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

describe("Phase 11B verification boundaries", () => {
  it("keeps verification execution below Core and independent from Tools, Storage, and LLM", async () => {
    const verification = await packageSources("verification");
    expect(verification).not.toMatch(
      /from\s+["']@caelush\/(?:core|tools|storage|llm|daemon|events)["']/,
    );
    expect(verification).not.toMatch(/from\s+["']node:(?:child_process|fs|net|http|https)["']/);
    expect(verification).not.toMatch(
      /\b(?:ToolInvocation|ToolObservation|AgentStep|Conversation)\b/,
    );
    expect(verification).not.toMatch(/\b(?:run\.completed|COMPLETED)\b/);
  });

  it("keeps runtime and security as structural lower-layer adapters", async () => {
    const [runtime, security, context] = await Promise.all([
      packageSources("runtime"),
      packageSources("security"),
      packageSources("context"),
    ]);
    for (const [name, source] of [
      ["runtime", runtime],
      ["security", security],
      ["context", context],
    ] as const) {
      expect(source, `${name} imports verification`).not.toMatch(
        /from\s+["']@caelush\/verification(?:\/[^"']*)?["']/,
      );
    }
  });

  it("keeps verification command admission and execution free of host side effects", async () => {
    const verification = await packageSources("verification");
    const security = await packageSources("security");
    expect(verification).not.toMatch(/\b(?:spawn|exec|execFile|fetch|readFile|writeFile)\s*\(/);
    expect(security).not.toMatch(/\b(?:spawn|execFile|fetch|readFile|writeFile)\s*\(/);
  });

  it("documents the 11B host-action and non-completion boundary", async () => {
    const [verification, runtime, security, context, readme, agents] = await Promise.all([
      readFile(
        path.join(repositoryRoot, "docs", "architecture", "verification-execution.md"),
        "utf8",
      ),
      readFile(path.join(repositoryRoot, "docs", "architecture", "runtime.md"), "utf8"),
      readFile(path.join(repositoryRoot, "docs", "architecture", "security.md"), "utf8"),
      readFile(
        path.join(repositoryRoot, "docs", "architecture", "context-and-project-intelligence.md"),
        "utf8",
      ),
      readFile(path.join(repositoryRoot, "README.md"), "utf8"),
      readFile(path.join(repositoryRoot, "AGENTS.md"), "utf8"),
    ]);
    expect(verification).toContain("typed argv");
    expect(verification).toContain("ToolInvocation");
    expect(verification).toContain("32 KiB");
    expect(runtime).toContain("executeArgv()");
    expect(security).toContain("verification command adapter");
    expect(context).toContain("ProjectInspector.inspect()");
    expect(readme).toContain("Phase 11B — Verification Execution: **COMPLETED**");
    expect(readme).toContain("Phase 11D — Completion Authority & Finalization: **COMPLETED**");
    expect(agents).toContain("Phase 11B rules:");
  });
});
