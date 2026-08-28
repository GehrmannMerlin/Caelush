import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LLMRequestSchema } from "@caelush/llm";
import { createWorkspaceId } from "@caelush/protocol";
import { afterEach, expect, it } from "vitest";
import {
  ContextBuilder,
  createLocalProjectInspector,
  createLocalRelevantFilePlanner,
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("builds real inspected and planned project context to an LLMRequest-ready message array", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "caelush-context-builder-e2e-"));
  directories.push(root);
  await mkdir(path.join(root, "packages", "app", "src"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "Root project rule", "utf8");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", packageManager: "pnpm@11.21.0" }),
    "utf8",
  );
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await writeFile(
    path.join(root, "packages", "app", "package.json"),
    JSON.stringify({ name: "app" }),
    "utf8",
  );
  await writeFile(path.join(root, "packages", "app", "AGENTS.md"), "Nested app rule", "utf8");
  await writeFile(
    path.join(root, "packages", "app", "src", "parser.ts"),
    "export function parse() { return true; }\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "packages", "app", "src", "parser.test.ts"),
    "test('parser', () => {});\n",
    "utf8",
  );
  const workspace = { id: createWorkspaceId(), path: root };
  const snapshot = await createLocalProjectInspector().inspect({
    workspace,
    cwd: path.join(root, "packages", "app"),
  });
  const relevant = await createLocalRelevantFilePlanner().plan({
    snapshot,
    query: { text: "Fix parser behavior" },
    budget: {
      maxSelectedFiles: 4,
      maxTotalTokens: 1000,
      maxPerFileTokens: 500,
      minUsefulFileTokens: 1,
    },
  });
  const built = new ContextBuilder().build({
    baseSystemPrompt: "base agent prompt",
    snapshot,
    relevantFiles: relevant,
    history: [
      { role: "user", content: "Please inspect the parser." },
      {
        role: "assistant",
        content: [{ type: "text", text: "I found the parser implementation." }],
      },
      { role: "user", content: "We also need to preserve the test behavior." },
      { role: "assistant", content: [{ type: "text", text: "Understood." }] },
    ],
    currentUserMessage: {
      role: "user",
      content: "Fix parser behavior without breaking the tests.",
    },
    limits: { maxInputTokens: 3000, safetyMarginTokens: 100 },
  });
  const request = LLMRequestSchema.parse({
    model: { provider: "fixture", model: "fixture-model" },
    messages: built.messages,
  });
  expect(request.messages.at(-1)).toEqual({
    role: "user",
    content: "Fix parser behavior without breaking the tests.",
  });
  expect(built.messages[0]?.role).toBe("system");
  expect(
    built.messages.some((message) => message.role === "user" && message !== built.messages.at(-1)),
  ).toBe(true);
  expect(built.messages[0]?.content).toContain("Root project rule");
  expect(built.messages[0]?.content).toContain("Nested app rule");
  expect(
    built.messages.some(
      (message) => message.role === "user" && message.content.includes("parser.ts"),
    ),
  ).toBe(true);
  expect(built.report.estimatedInputTokens + 100).toBeLessThanOrEqual(3000);
});
