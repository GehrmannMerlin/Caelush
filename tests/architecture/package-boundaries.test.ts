import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allWorkspaceManifestPaths,
  dependencyEntries,
  pathExists,
  readManifest,
  repositoryRoot,
  workspaceSourceContents,
} from "./support/workspace.js";

const appPackageNames = new Set(["@caelush/daemon", "@caelush/cli", "@caelush/web"]);
const protocolPackageName = "@caelush/protocol";
const internalPackagePattern = /^@caelush\//;
const deepSourceImportPattern = /\.\.\/(?:\.\.\/)+packages\/[^\s"'`]+\/src\//;
const forbiddenLlmSdkImportPattern = /\bfrom\s+["'](?:ai|@ai-sdk\/)/;
const explicitAnyPattern = /\bany\b/;
const openAICompatibleAdapterRoot = path.join(
  repositoryRoot,
  "packages",
  "llm",
  "src",
  "providers",
  "openai-compatible",
);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return nestedFiles.flat();
}

function isOpenAICompatibleAdapterPath(filePath: string): boolean {
  return (
    filePath === openAICompatibleAdapterRoot ||
    filePath.startsWith(`${openAICompatibleAdapterRoot}${path.sep}`)
  );
}

describe("package boundaries", () => {
  it("prevents packages from depending on applications", async () => {
    for (const manifestPath of allWorkspaceManifestPaths().filter((entry) =>
      entry.startsWith("packages/"),
    )) {
      const manifestExists = await pathExists(manifestPath);
      expect(manifestExists, manifestPath).toBe(true);
      if (!manifestExists) {
        return;
      }

      const manifest = await readManifest(manifestPath);
      const dependencies = Object.keys(dependencyEntries(manifest));

      expect(dependencies.some((dependency) => appPackageNames.has(dependency))).toBe(false);
    }
  });

  it("keeps protocol independent from other Caelush feature packages", async () => {
    const manifestPath = "packages/protocol/package.json";
    const manifestExists = await pathExists(manifestPath);
    expect(manifestExists, manifestPath).toBe(true);
    if (!manifestExists) {
      return;
    }

    const manifest = await readManifest(manifestPath);
    const dependencies = Object.keys(dependencyEntries(manifest));

    expect(
      dependencies.some(
        (dependency) =>
          internalPackagePattern.test(dependency) && dependency !== protocolPackageName,
      ),
    ).toBe(false);
  });

  it("keeps the LLM package below the provider boundary and above Protocol only", async () => {
    const manifest = await readManifest("packages/llm/package.json");
    const dependencies = dependencyEntries(manifest);
    expect(dependencies[protocolPackageName]).toBe("workspace:*");
    expect(dependencies.zod).toBe("4.4.3");
    expect(dependencies.ai).toBe("7.0.83");
    expect(dependencies["@ai-sdk/openai-compatible"]).toBe("3.0.39");
    expect(
      Object.keys(dependencies).some((dependency) =>
        ["@ai-sdk/core", "@ai-sdk/openai", "openai", "anthropic"].includes(dependency),
      ),
    ).toBe(false);

    const sourceContents = await workspaceSourceContents();
    expect(sourceContents.some((contents) => contents.includes('from "@caelush/protocol"'))).toBe(
      true,
    );
  });

  it("keeps AI SDK imports inside the OpenAI-compatible adapter and explicit any out of production source", async () => {
    const llmSourcePaths = await sourceFiles(path.join(repositoryRoot, "packages", "llm", "src"));
    const llmSourceContents = await Promise.all(
      llmSourcePaths.map(async (filePath) => ({
        filePath,
        contents: await readFile(filePath, "utf8"),
      })),
    );
    const violations = llmSourceContents
      .filter(({ filePath }) => !isOpenAICompatibleAdapterPath(filePath))
      .filter(({ contents }) => forbiddenLlmSdkImportPattern.test(contents))
      .map(({ filePath }) => path.relative(repositoryRoot, filePath));
    expect(violations).toEqual([]);
    expect(llmSourceContents.some(({ contents }) => explicitAnyPattern.test(contents))).toBe(false);
  });

  it("keeps the Phase 4B gateway isolated from adapters and host execution", async () => {
    const llmSourceFileNames = (
      await readdir(path.join(repositoryRoot, "packages", "llm", "src"))
    ).filter((fileName) => fileName.endsWith(".ts"));
    const llmSourceContents = await Promise.all(
      llmSourceFileNames.map((fileName) =>
        readFile(path.join(repositoryRoot, "packages", "llm", "src", fileName), "utf8"),
      ),
    );
    const productionSource = llmSourceContents.join("\n");
    expect(productionSource).not.toMatch(/from\s+["']@caelush\/(?:daemon|storage|events|core)["']/);
    expect(productionSource).not.toMatch(/from\s+["'](?:ai|@ai-sdk\/|openai|anthropic|@google\/)/);
    expect(productionSource).not.toMatch(/\b(?:fetch|ToolDispatcher|AgentLoop|runAgent)\s*\(/);
    expect(productionSource).not.toContain("providerOptions");
    expect(productionSource).not.toContain("stream.error");
    expect(productionSource).not.toContain("reasoning.delta");
  });

  it("keeps Events provider-neutral and Storage below Core", async () => {
    const events = await readManifest("packages/events/package.json");
    const storage = await readManifest("packages/storage/package.json");
    const core = await readManifest("packages/core/package.json");
    const eventDependencies = Object.keys(dependencyEntries(events));
    const storageDependencies = Object.keys(dependencyEntries(storage));
    const coreDependencies = Object.keys(dependencyEntries(core));

    expect(eventDependencies).toContain("@caelush/protocol");
    expect(eventDependencies).not.toContain("@caelush/storage");
    expect(storageDependencies).toContain("@caelush/events");
    expect(storageDependencies).toContain("@caelush/protocol");
    expect(coreDependencies).not.toContain("@caelush/storage");
  });

  it("keeps the Phase 6B loop above Context and narrow LLM contracts", async () => {
    const core = await readManifest("packages/core/package.json");
    const dependencies = dependencyEntries(core);
    expect(dependencies["@caelush/context"]).toBe("workspace:*");
    expect(dependencies["@caelush/llm"]).toBe("workspace:*");
    expect(dependencies["@caelush/protocol"]).toBe("workspace:*");
    expect(Object.keys(dependencies)).not.toContain("ai");
    expect(Object.keys(dependencies)).not.toContain("@ai-sdk/openai-compatible");
  });

  it("allows context to reuse Protocol while keeping it below all execution boundaries", async () => {
    const context = await readManifest("packages/context/package.json");
    const dependencies = dependencyEntries(context);

    expect(dependencies[protocolPackageName]).toBe("workspace:*");
    expect(dependencies.ignore).toBe("7.0.6");
    expect(Object.keys(dependencies).sort()).toEqual([
      "@caelush/llm",
      "@caelush/protocol",
      "ignore",
    ]);
  });

  it("allows Context to import only the provider-independent messages subpath", async () => {
    const sourceRoot = path.join(repositoryRoot, "packages", "context", "src");
    const files = await sourceFiles(sourceRoot);
    const source = (await Promise.all(files.map((filePath) => readFile(filePath, "utf8")))).join(
      "\n",
    );
    const imports = [...source.matchAll(/from\s+["'](@caelush\/llm(?:\/[^"']*)?)["']/g)].map(
      (match) => match[1],
    );
    expect(imports).toContain("@caelush/llm/messages");
    expect(imports.filter((value) => value !== "@caelush/llm/messages")).toEqual([]);
  });

  it("allows the daemon to compose protocol, storage, and events through public entries", async () => {
    const daemon = await readManifest("apps/daemon/package.json");
    const dependencies = Object.keys(dependencyEntries(daemon));

    expect(dependencies).toContain("@caelush/protocol");
    expect(dependencies).toContain("@caelush/storage");
    expect(dependencies).toContain("@caelush/events");
    expect(dependencies).not.toContain("@caelush/cli");
    expect(dependencies).not.toContain("@caelush/web");
  });

  it("requires workspace protocol for every internal dependency", async () => {
    for (const manifestPath of allWorkspaceManifestPaths()) {
      const manifestExists = await pathExists(manifestPath);
      expect(manifestExists, manifestPath).toBe(true);
      if (!manifestExists) {
        return;
      }

      const manifest = await readManifest(manifestPath);

      for (const [dependency, version] of Object.entries(dependencyEntries(manifest))) {
        if (internalPackagePattern.test(dependency)) {
          expect(version, `${manifestPath} -> ${dependency}`).toBe("workspace:*");
        }
      }
    }
  });

  it("rejects deep cross-package source imports", async () => {
    const sourceContents = await workspaceSourceContents();

    expect(sourceContents.some((contents) => deepSourceImportPattern.test(contents))).toBe(false);
  });
});
