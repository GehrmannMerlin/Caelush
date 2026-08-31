import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve("packages/core/src");

async function sourceContents(): Promise<string> {
  const files = (await readdir(sourceRoot)).filter((file) => file.endsWith(".ts"));
  return (
    await Promise.all(files.map((file) => readFile(path.join(sourceRoot, file), "utf8")))
  ).join("\n");
}

describe("Core Phase 6B architecture", () => {
  it("keeps Core imports inside the approved narrow contract edges", async () => {
    const source = await sourceContents();
    const imports = [...source.matchAll(/from\s+["'](@caelush\/[^"']+)["']/g)].map(
      (match) => match[1] ?? "",
    );
    expect(
      imports.filter(
        (value) =>
          ![
            "@caelush/context",
            "@caelush/protocol",
            "@caelush/llm/errors",
            "@caelush/llm/messages",
            "@caelush/llm/request",
            "@caelush/llm/turn",
            "@caelush/events",
            "@caelush/tools",
            "@caelush/verification",
          ].includes(value),
      ),
    ).toEqual([]);
    expect(source).not.toMatch(/from\s+["']@caelush\/llm["']/);
    expect(source).not.toMatch(/from\s+["']@caelush\/(?:storage|runtime|security|daemon)/);
  });

  it("contains no host execution, SDK, time, ID, or hidden-reasoning boundary leaks", async () => {
    const source = await sourceContents();
    expect(source).not.toMatch(
      /(?:from\s+["'](?:ai|@ai-sdk\/)|fetch\s*\(|node:(?:fs|path|http|https)|child_process|Date\.now\s*\(|randomUUID\s*\()/,
    );
    expect(source).not.toMatch(/\bany\b/);
    expect(source).not.toMatch(
      /(?:chain_of_thought|raw_reasoning|thinking_content|reasoning\.delta)/,
    );
  });

  it("keeps built Core declarations provider and host independent", async () => {
    const declarations = await Promise.all(
      ["index.d.ts", "agent-decision.d.ts", "agent-decision-mapper.d.ts"].map((file) =>
        readFile(path.resolve("packages/core/dist", file), "utf8"),
      ),
    );
    const declaration = declarations.join("\n");
    expect(declaration).toContain("@caelush/llm/messages");
    expect(declaration).toContain("@caelush/llm/turn");
    expect(declaration).not.toMatch(
      /from\s+["'](?:@caelush\/llm["']|@caelush\/(?:storage|events|runtime|security|daemon)|ai|@ai-sdk\/)/,
    );
  });
});
