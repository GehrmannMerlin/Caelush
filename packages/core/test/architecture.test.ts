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

/**
 * The Architecture V2 Phase 2C Core boundary.
 *
 * Core used to reach a model through the legacy LLM abstraction. After the cutover it
 * executes a model turn through `ModelTurnExecutor` (the `@caelush/agent` port) over an
 * `AIModelRequest` / `AIModelTurnResult` (`@caelush/ai`). The legacy package is allowed
 * to remain only for the frozen message contracts, which Message System V2 will retire
 * in a later phase.
 */
const ALLOWED_CORE_EDGES = [
  "@caelush/agent",
  "@caelush/ai",
  "@caelush/context",
  "@caelush/protocol",
  "@caelush/llm/messages",
  "@caelush/llm/turn",
  "@caelush/tools",
  "@caelush/verification",
];

describe("Core Phase 6B architecture", () => {
  it("keeps Core imports inside the approved narrow contract edges", async () => {
    const source = await sourceContents();
    const imports = [...source.matchAll(/from\s+["'](@caelush\/[^"']+)["']/g)].map(
      (match) => match[1] ?? "",
    );
    expect(imports.filter((value) => !ALLOWED_CORE_EDGES.includes(value))).toEqual([]);
    expect(source).not.toMatch(/from\s+["']@caelush\/llm["']/);
    expect(source).not.toMatch(/from\s+["']@caelush\/llm\/(?:errors|request|providers)/);
    expect(source).not.toMatch(/from\s+["']@caelush\/(?:storage|runtime|security|daemon|events)/);
  });

  it("contains no legacy model authority, host execution, SDK, time, ID, or hidden-reasoning leaks", async () => {
    const source = await sourceContents();
    expect(source).not.toMatch(
      /(?:from\s+["'](?:ai|@ai-sdk\/)|fetch\s*\(|node:(?:fs|path|http|https)|child_process|Date\.now\s*\(|randomUUID\s*\()/,
    );
    // A real `any` annotation, not the English word inside a comment.
    expect(source).not.toMatch(/(?::\s*any\b|<any>|\bas\s+any\b|\bany\[\]|Array<any>)/);
    expect(source).not.toMatch(
      /(?:chain_of_thought|raw_reasoning|thinking_content|reasoning\.delta)/,
    );

    // The legacy model invocation authority must not be reachable from Core at all.
    expect(source).not.toMatch(
      /\b(?:LLMGateway|LLMProviderRegistry|createOpenAICompatibleLLMProvider|LLMProvider|LLMStreamEvent|LLMCapabilities)\b/,
    );
    // No Core port may carry a legacy model request or turn result as a type.
    expect(source).not.toMatch(
      /import[^;]*\b(?:LLMRequest|LLMTurnResult)\b[^;]*from\s+["']@caelush\/llm/,
    );
  });

  it("keeps built Core declarations provider and host independent", async () => {
    const declarations = await Promise.all(
      ["index.d.ts", "agent-decision.d.ts", "agent-decision-mapper.d.ts"].map((file) =>
        readFile(path.resolve("packages/core/dist", file), "utf8"),
      ),
    );
    const declaration = declarations.join("\n");
    // The frozen message contracts are still owned by the legacy package.
    expect(declaration).toContain("@caelush/llm/messages");
    // Model execution metadata is re-exported from the AI core, not re-declared.
    expect(declaration).toContain("@caelush/ai");
    expect(declaration).not.toMatch(
      /from\s+["'](?:@caelush\/llm["']|@caelush\/(?:storage|events|runtime|security|daemon)|ai|@ai-sdk\/)/,
    );
  });
});
