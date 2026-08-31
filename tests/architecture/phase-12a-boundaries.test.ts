import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dependencyEntries, readManifest, repositoryRoot } from "./support/workspace.js";

async function sourceTree(relativeRoot: string): Promise<string> {
  const root = path.join(repositoryRoot, relativeRoot);
  const entries = await readdir(root, { recursive: true });
  const files = entries
    .filter((entry): entry is string => entry.endsWith(".ts"))
    .map((entry) => path.join(root, entry));
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

describe("Phase 12A daemon and shared-client boundaries", () => {
  it("keeps the shared client transport on Protocol and browser APIs only", async () => {
    const client = await readManifest("packages/client/package.json");
    expect(Object.keys(dependencyEntries(client))).toEqual(["@caelush/protocol"]);
    const source = await sourceTree("packages/client/src");
    expect(source).not.toMatch(
      /from\s+["']@caelush\/(?:core|runtime|storage|security|tools|context|verification|llm|events|daemon|cli|web)["']/,
    );
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/\b(?:EventSource|WebSocket|Fastify|AgentLoop|RunController)\b/);
  });

  it("keeps CLI and Web as clients without Kernel or host-runtime dependencies", async () => {
    for (const appName of ["cli", "web"] as const) {
      const manifest = await readManifest(`apps/${appName}/package.json`);
      expect(Object.keys(dependencyEntries(manifest))).not.toEqual(
        expect.arrayContaining([
          "@caelush/core",
          "@caelush/runtime",
          "@caelush/storage",
          "@caelush/security",
          "@caelush/tools",
        ]),
      );
      const source = await sourceTree(`apps/${appName}/src`);
      expect(source).not.toMatch(
        /from\s+["']@caelush\/(?:core|runtime|storage|security|tools|context|verification|llm)["']/,
      );
    }
  });

  it("keeps route registration thin and composition in the daemon root", async () => {
    const routes = await sourceTree("apps/daemon/src/routes");
    expect(routes).not.toMatch(
      /new\s+(?:RunController|LocalRuntime|ToolDispatcher|LLMGateway)\s*\(/,
    );
    expect(routes).not.toMatch(/from\s+["']@caelush\/(?:core|runtime|tools|llm)["']/);
  });

  it("keeps provider and Runtime host execution out of daemon production adapters", async () => {
    const daemon = await sourceTree("apps/daemon/src");
    expect(daemon).not.toMatch(/\b(?:fetch|spawn|execFile|nodePty)\s*\(/);
    expect(daemon).not.toMatch(/from\s+["']node:child_process["']/);
    expect(daemon).not.toMatch(
      /(?:React|Ink|EventSource|WebSocket|cors|MCP|Browser|Computer Use)/i,
    );
  });
});
