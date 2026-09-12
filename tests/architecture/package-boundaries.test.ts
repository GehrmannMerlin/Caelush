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
const explicitAnyPattern = /(?::\s*any\b|<any>|\bas\s+any\b|\bany\[\]|Array<any>)/;
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

async function packageSource(packageName: string): Promise<string> {
  const files = await sourceFiles(path.join(repositoryRoot, "packages", packageName, "src"));
  return (await Promise.all(files.map((filePath) => readFile(filePath, "utf8")))).join("\n");
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

  it("keeps the LLM package as a compatibility facade above the AI core only", async () => {
    const manifest = await readManifest("packages/llm/package.json");
    const dependencies = dependencyEntries(manifest);
    expect(dependencies[protocolPackageName]).toBe("workspace:*");
    expect(dependencies.zod).toBe("4.4.3");
    // Phase 2B moved the OpenAI-compatible runtime into `@caelush/ai`, so the legacy
    // package now depends on the AI core and owns no provider SDK at all.
    expect(dependencies["@caelush/ai"]).toBe("workspace:*");
    expect(dependencies.ai).toBeUndefined();
    expect(dependencies["@ai-sdk/openai-compatible"]).toBeUndefined();
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

  it("keeps provider SDK imports out of the legacy package and explicit any out of production source", async () => {
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

  it("keeps the Tool Kernel below execution layers and free of host side effects", async () => {
    const manifest = await readManifest("packages/tools/package.json");
    const dependencies = dependencyEntries(manifest);
    expect(dependencies[protocolPackageName]).toBe("workspace:*");
    expect(dependencies.ajv).toBe("8.20.0");
    expect(dependencies["@caelush/runtime"]).toBe("workspace:*");
    expect(Object.keys(dependencies).sort()).toEqual([
      "@caelush/protocol",
      "@caelush/runtime",
      "ajv",
    ]);

    const sourceRoot = path.join(repositoryRoot, "packages", "tools", "src");
    const files = await sourceFiles(sourceRoot);
    const sources = await Promise.all(
      files.map(async (filePath) => ({ filePath, contents: await readFile(filePath, "utf8") })),
    );
    const source = sources.map(({ contents }) => contents).join("\n");
    expect(source).toMatch(/from\s+["']@caelush\/protocol["']/);
    expect(source).not.toMatch(
      /from\s+["']@caelush\/(?:core|context|storage|events|security|verification|daemon|llm)["']/,
    );
    expect(source).not.toMatch(/from\s+["'](?:ai|@ai-sdk\/)/);
    expect(source).not.toMatch(/node:(?:fs|child_process|http|https|sqlite)/);
    expect(source).not.toMatch(/\b(?:fetch|spawn|exec)\s*\(/);
    expect(source).not.toMatch(/\b(?:EventBus|Permission|ApprovalManager)\b/);

    const ajvImports = sources
      .filter(({ contents }) => /from\s+["']ajv["']/.test(contents))
      .map(({ filePath }) => path.relative(repositoryRoot, filePath).replaceAll(path.sep, "/"));
    expect(ajvImports).toEqual(["packages/tools/src/schema-runtime.ts"]);
  });

  it("keeps Runtime below Tools and limits host process access to the fixed search adapter", async () => {
    const manifest = await readManifest("packages/runtime/package.json");
    const dependencies = dependencyEntries(manifest);
    expect(dependencies[protocolPackageName]).toBe("workspace:*");
    expect(dependencies["@caelush/shared"]).toBe("workspace:*");
    expect(dependencies["fast-glob"]).toBe("3.3.3");
    expect(dependencies["node-pty"]).toBe("1.1.0");
    expect(Object.keys(dependencies).sort()).toEqual([
      "@caelush/protocol",
      "@caelush/shared",
      "fast-glob",
      "node-pty",
    ]);

    const sourceRoot = path.join(repositoryRoot, "packages", "runtime", "src");
    const files = await sourceFiles(sourceRoot);
    const sources = await Promise.all(
      files.map(async (filePath) => ({
        filePath,
        relativePath: path.relative(repositoryRoot, filePath).replaceAll(path.sep, "/"),
        contents: await readFile(filePath, "utf8"),
      })),
    );
    const source = sources.map(({ contents }) => contents).join("\n");
    const patchCommitterSource = sources
      .filter(({ relativePath }) => relativePath === "packages/runtime/src/patch/committer.ts")
      .map(({ contents }) => contents)
      .join("\n");
    const nonMutationSource = sources
      .filter(({ relativePath }) => relativePath !== "packages/runtime/src/patch/committer.ts")
      .map(({ contents }) => contents)
      .join("\n");
    expect(source).not.toMatch(
      /from\s+["']@caelush\/(?:tools|core|context|storage|events|llm|security|verification|daemon)["']|from\s+["'](?:ai|@ai-sdk\/)/,
    );
    expect(nonMutationSource).not.toMatch(
      /\b(?:writeFile|appendFile|rename|unlink|rm|truncate|copyFile|chmod|chown)\s*\(/,
    );
    expect(patchCommitterSource).toMatch(/writePatchFile|removePatchFile|movePatchFile/);
    const childProcessImports = sources
      .filter(({ contents }) => contents.includes('from "node:child_process"'))
      .map(({ relativePath }) => relativePath);
    expect(childProcessImports).toEqual([
      "packages/runtime/src/exec/pipe-process-adapter.ts",
      "packages/runtime/src/git/git-runner.ts",
      "packages/runtime/src/search/ripgrep-runner.ts",
    ]);
    expect(source).not.toContain("shell: true");
    expect(source).not.toMatch(/\b(?:exec|execSync)\s*\(/);
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
    expect(storageDependencies).toContain("@caelush/tools");
    expect(coreDependencies).not.toContain("@caelush/storage");
  });

  it("keeps Core, Events, and Storage within the Phase 6C execution boundaries", async () => {
    const [core, events, storage] = await Promise.all([
      packageSource("core"),
      packageSource("events"),
      packageSource("storage"),
    ]);
    expect(core).not.toMatch(/from\s+["']@caelush\/storage["']/);
    expect(events).not.toMatch(/from\s+["']@caelush\/(?:core|storage)["']/);
    expect(storage).not.toMatch(/from\s+["']@caelush\/(?:context|runtime|security|daemon|llm)["']/);
    for (const [name, source] of [
      ["Core", core],
      ["Events", events],
      ["Storage", storage],
    ] as const) {
      expect(source, `${name} imports an AI SDK`).not.toMatch(/from\s+["'](?:ai|@ai-sdk\/)/);
      expect(source, `${name} performs network or child-process execution`).not.toMatch(
        /(?:fetch\s*\(|node:(?:http|https)|child_process)/,
      );
    }
    expect(core, "Core contains explicit any").not.toMatch(/\bany\b/);
    expect(storage, "Storage contains explicit any").not.toMatch(/\bany\b/);
  });

  it("keeps the Phase 6B loop above Context and narrow LLM contracts", async () => {
    const core = await readManifest("packages/core/package.json");
    const dependencies = dependencyEntries(core);
    expect(dependencies["@caelush/context"]).toBe("workspace:*");
    expect(dependencies["@caelush/llm"]).toBe("workspace:*");
    expect(dependencies["@caelush/protocol"]).toBe("workspace:*");
    expect(dependencies["@caelush/tools"]).toBe("workspace:*");
    expect(Object.keys(dependencies)).not.toContain("ai");
    expect(Object.keys(dependencies)).not.toContain("@ai-sdk/openai-compatible");
  });

  it("allows context to reuse Protocol while keeping it below all execution boundaries", async () => {
    const context = await readManifest("packages/context/package.json");
    const dependencies = dependencyEntries(context);

    expect(dependencies[protocolPackageName]).toBe("workspace:*");
    expect(dependencies["@caelush/shared"]).toBe("workspace:*");
    expect(dependencies.ignore).toBe("7.0.6");
    expect(Object.keys(dependencies).sort()).toEqual([
      "@caelush/llm",
      "@caelush/protocol",
      "@caelush/security",
      "@caelush/shared",
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

  it("keeps Context security reuse narrow and execution-independent", async () => {
    const sourceRoot = path.join(repositoryRoot, "packages", "context", "src");
    const files = await sourceFiles(sourceRoot);
    const source = (await Promise.all(files.map((filePath) => readFile(filePath, "utf8")))).join(
      "\n",
    );
    const securityImports = [
      ...source.matchAll(/from\s+["'](@caelush\/security(?:\/[^"']*)?)["']/g),
    ].map((match) => match[1]);
    expect(securityImports).toHaveLength(2);
    expect(securityImports).toEqual(
      expect.arrayContaining(["@caelush/security/redaction", "@caelush/security/sensitive-path"]),
    );
    expect(source).not.toMatch(
      /from\s+["']@caelush\/(?:security|tools|runtime|storage|events|daemon)["']/,
    );
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
