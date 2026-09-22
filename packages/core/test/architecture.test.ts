import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve("packages/core/src");
const workspaceRoots = ["packages", "apps"] as const;

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
 *
 * Phase 4F deleted the legacy Tool System package, so it is no longer an approved edge for
 * anyone — Core included. The permanent rule it leaves behind is checked below: no workspace
 * package may declare a dependency on it, and the workspace must not carry its directory again.
 */
const ALLOWED_CORE_EDGES = [
  "@caelush/agent",
  "@caelush/ai",
  "@caelush/context",
  "@caelush/protocol",
  "@caelush/llm/messages",
  "@caelush/llm/turn",
  "@caelush/verification",
];

/**
 * The package Phase 4F deleted. It must never be a dependency, a workspace path or an import again.
 *
 * The name is assembled from its two segments so that a whole-workspace scan for the literal
 * string does not match the guard whose job is to forbid it.
 */
const RETIRED_TOOL_SYSTEM_PACKAGE = ["@caelush", "tools"].join("/");

/** The directories a workspace package may live in. */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

interface WorkspaceManifest {
  readonly file: string;
  readonly manifest: Record<string, unknown>;
}

/** One workspace manifest, or `undefined` when the path is not a readable package. */
async function readManifest(file: string): Promise<WorkspaceManifest | undefined> {
  try {
    const contents = await readFile(path.resolve(file), "utf8");
    return { file, manifest: JSON.parse(contents) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/**
 * Every manifest that could declare a dependency: the workspace root and each package in
 * `packages/` and `apps/`.
 *
 * A directory without a readable manifest is skipped rather than failed: it is not a package,
 * so it has no dependency field to check.
 */
async function workspaceManifests(): Promise<readonly WorkspaceManifest[]> {
  const manifests: WorkspaceManifest[] = [];
  const root = await readManifest("package.json");
  if (root !== undefined) manifests.push(root);
  for (const workspace of workspaceRoots) {
    const entries = await readdir(path.resolve(workspace), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await readManifest(path.join(workspace, entry.name, "package.json"));
      if (manifest !== undefined) manifests.push(manifest);
    }
  }
  return manifests;
}

/**
 * The Run Layer's model-facing Tool catalog declarations.
 *
 * Phase 4F retired `protocol.ToolDefinition`, and these five modules are where Core declared the Tool
 * catalog it hands to a provider turn. They are the place a regression to the seven-field Protocol
 * shape would reappear, so the canonical replacement — `AIToolSpec`, read from the registry's own
 * `modelSpecs()` — is what they must name.
 */
const MODEL_TOOL_DECLARATION_FILES = [
  "agent-loop.ts",
  "run-controller-ports.ts",
  "run-agent-execution.ts",
  "agent-loop-input.ts",
  "agent-loop-request.ts",
] as const;

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
    // Phase 3A moved the decision contract into the Agent kernel, so these three
    // declarations re-export from `@caelush/agent` rather than re-declaring anything. The
    // legacy message contract stays owned by the legacy package and is still reachable
    // through Core's durable projections.
    expect(declaration).toContain("@caelush/agent");
    // Model execution metadata is re-exported from the AI core, not re-declared.
    expect(declaration).toContain("@caelush/ai");
    expect(declaration).not.toMatch(
      /from\s+["'](?:@caelush\/llm["']|@caelush\/(?:storage|events|runtime|security|daemon)|ai|@ai-sdk\/)/,
    );
  });

  it("declares its model-facing Tool catalog as the canonical AIToolSpec", async () => {
    const declarations = await Promise.all(
      MODEL_TOOL_DECLARATION_FILES.map(async (file) => ({
        file,
        contents: await readFile(path.join(sourceRoot, file), "utf8"),
      })),
    );

    for (const { file, contents } of declarations) {
      // The retired Protocol contract must not come back as an imported type. The history of the
      // cutover is allowed to be named in a comment, so the check is anchored to the import clause.
      expect(contents, file).not.toMatch(
        /import[^;]*\b(?:ToolDefinition|ToolDefinitionSchema)\b[^;]*from\s+["']@caelush\/protocol/,
      );
      // And there is no second, projected model-tool accessor beside the registry's own answer.
      expect(contents, file).not.toMatch(/\bmodelDefinitions\s*\(/);
    }

    // The one catalog declaration the Run Layer's Tool pipeline exposes is the registry's own
    // `modelSpecs()`: three fields per Tool, stored by the registry rather than re-projected here.
    const ports = declarations.find(({ file }) => file === "run-controller-ports.ts")?.contents;
    expect(ports ?? "").toMatch(/modelSpecs\(\)\s*:\s*readonly\s+AIToolSpec\[\]/);
  });
});

describe("workspace package boundaries", () => {
  it("holds no workspace package at the retired Tool System path", async () => {
    // Phase 4F deleted `packages/tools`. A recreated directory is how a second Tool System would
    // start, so its absence is the permanent rule rather than a migration checkpoint.
    const workspaces = await readdir(path.resolve("packages"));
    expect(workspaces).not.toContain("tools");
  });

  it("declares no dependency on the retired Tool System package", async () => {
    const manifests = await workspaceManifests();
    // A guard that read no manifest would pass vacuously; the workspace has packages to check.
    expect(manifests.length).toBeGreaterThan(0);

    for (const { file, manifest } of manifests) {
      for (const field of DEPENDENCY_FIELDS) {
        const dependencies = manifest[field];
        if (dependencies === undefined) continue;
        expect(
          Object.keys(dependencies as Record<string, unknown>),
          `${file} ${field}`,
        ).not.toContain(RETIRED_TOOL_SYSTEM_PACKAGE);
      }
    }
  });
});
