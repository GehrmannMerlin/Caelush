import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allWorkspaceManifestPaths,
  dependencyEntries,
  pathExists,
  readManifest,
  repositoryRoot,
  retiredLegacyToolPackage,
  workspaceSourceContents,
} from "./support/workspace.js";

const appPackageNames = new Set(["@caelush/daemon", "@caelush/cli", "@caelush/web"]);
const protocolPackageName = "@caelush/protocol";
const internalPackagePattern = /^@caelush\//;
const deepSourceImportPattern = /\.\.\/(?:\.\.\/)+packages\/[^\s"'`]+\/src\//;
const explicitAnyPattern = /(?::\s*any\b|<any>|\bas\s+any\b|\bany\[\]|Array<any>)/;

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

async function packageSource(packageName: string): Promise<string> {
  const files = await sourceFiles(path.join(repositoryRoot, "packages", packageName, "src"));
  return (await Promise.all(files.map((filePath) => readFile(filePath, "utf8")))).join("\n");
}

/** A file's executable code: a comment naming a dependency is documentation, not a dependency. */
function executableSource(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every source file of a package that imports the schema compiler, workspace-relative and sorted. */
async function ajvImportPaths(packageName: string): Promise<string[]> {
  const files = await sourceFiles(path.join(repositoryRoot, "packages", packageName, "src"));
  const sources = await Promise.all(
    files.map(async (filePath) => ({ filePath, contents: await readFile(filePath, "utf8") })),
  );
  return sources
    .filter(({ contents }) => /from\s+["']ajv["']/.test(contents))
    .map(({ filePath }) => path.relative(repositoryRoot, filePath).replaceAll(path.sep, "/"));
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

  it("retires the legacy LLM package after the Phase 5F cutover", async () => {
    expect(await pathExists("packages/llm")).toBe(false);
    expect(await pathExists("packages/llm/package.json")).toBe(false);
  });

  it("keeps the Tool Kernel below execution layers and free of host side effects", async () => {
    // Phase 4F deleted the legacy `@caelush/tools` package. The general Tool Kernel is
    // `@caelush/agent` and the Coding Tool product layer is `@caelush/coding-agent`, so both are
    // asserted directly, and the retired identity is pinned as gone: a manifest or a source directory
    // under `packages/tools` would be the deleted package coming back.
    expect(await pathExists(`${retiredLegacyToolPackage.directory}/package.json`)).toBe(false);
    expect(await pathExists(retiredLegacyToolPackage.directory)).toBe(false);

    // The kernel sits below every execution layer: the AI core contract and Protocol, and no other
    // workspace package at all — no Runtime, no Storage, no Security, no Coding overlay, no host.
    const kernelManifest = await readManifest("packages/agent/package.json");
    const kernelDependencies = dependencyEntries(kernelManifest);
    expect(kernelDependencies[protocolPackageName]).toBe("workspace:*");
    expect(kernelDependencies.ajv).toBe("8.20.0");
    expect(Object.keys(kernelManifest.dependencies ?? {}).sort()).toEqual([
      "@caelush/ai",
      "@caelush/protocol",
      "ajv",
    ]);

    // The Coding Tool product layer owns the nine builtins, their narrow Operations ports and Runtime
    // adapters, the Coding security facts, the approval identity, the Coding effects and the prompt
    // snippets. It is the one Tool package that may reach Runtime, and the edge stays one-way.
    const codingManifest = await readManifest("packages/coding-agent/package.json");
    expect(Object.keys(codingManifest.dependencies ?? {}).sort()).toEqual([
      "@caelush/agent",
      "@caelush/ai",
      "@caelush/protocol",
      "@caelush/runtime",
    ]);

    const kernelSource = executableSource(await packageSource("agent"));
    expect(kernelSource).toMatch(/from\s+["']@caelush\/protocol["']/);
    expect(kernelSource).not.toMatch(
      /from\s+["']@caelush\/(?:core|context|runtime|storage|events|security|verification|daemon|llm|coding-agent)["']/,
    );
    expect(kernelSource).not.toMatch(/from\s+["'](?:ai|@ai-sdk\/)/);
    expect(kernelSource).not.toMatch(/node:(?:fs|child_process|http|https|sqlite)/);
    expect(kernelSource).not.toMatch(/\b(?:fetch|spawn|exec)\s*\(/);
    expect(kernelSource).not.toMatch(/\b(?:EventBus|Permission|ApprovalManager)\b/);

    // The Coding layer reaches the Runtime only through the adapters it injects: it never imports the
    // host process boundary itself, and it never reaches back into a legacy package.
    const codingSource = executableSource(await packageSource("coding-agent"));
    expect(codingSource).toMatch(/from\s+["']@caelush\/agent["']/);
    expect(codingSource).toMatch(/from\s+["']@caelush\/runtime["']/);
    expect(codingSource).not.toMatch(
      /from\s+["']@caelush\/(?:core|context|storage|events|security|verification|daemon|llm)["']/,
    );
    expect(codingSource).not.toMatch(/node:(?:child_process|pty)/);
    expect(codingSource).not.toMatch(/\b(?:fetch|spawn|exec)\s*\(/);
    expect(codingSource).not.toMatch(/\b(?:EventBus|Permission|ApprovalManager)\b/);

    // The schema compiler is one implementation, and Phase 4A moved it into `@caelush/agent`. The
    // Coding layer therefore imports `ajv` nowhere: a second compiler there would be a second answer
    // to "is this schema accepted", which is exactly what the migration removed.
    expect(await ajvImportPaths("coding-agent")).toEqual([]);
    expect(await ajvImportPaths("agent")).toEqual([
      "packages/agent/src/tools/schema/schema-runtime.ts",
    ]);
  });

  it("keeps Runtime below the Tool layer and limits host process access to the fixed search adapter", async () => {
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
      /from\s+["']@caelush\/(?:agent|coding-agent|core|context|storage|events|llm|security|verification|daemon)["']|from\s+["'](?:ai|@ai-sdk\/)/,
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
    // Phase 6D moved durable-event observation compatibility out of Storage: Storage exposes only
    // the read-only durable reader, while the daemon owns the live Hub and its notifier.
    expect(storageDependencies).not.toContain("@caelush/events");
    expect(storageDependencies).toContain("@caelush/protocol");
    // Phase 4F deleted `@caelush/tools`. Storage depends on `@caelush/agent` for the canonical Tool
    // and Agent contracts it persists, and it must never reach up into `@caelush/coding-agent`: the
    // Coding Tool product layer sits above Storage, so that edge would be a cycle.
    expect(Object.keys(storage.dependencies ?? {}).sort()).toEqual([
      "@caelush/agent",
      "@caelush/core",
      "@caelush/memory",
      "@caelush/protocol",
      "@caelush/verification",
      "drizzle-orm",
    ]);
    expect(storageDependencies).not.toContain("@caelush/coding-agent");
    expect(storageDependencies).not.toContain(retiredLegacyToolPackage.name);
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
    expect(storage).not.toMatch(/from\s+["']@caelush\/(?:context|runtime|security|daemon)["']/);
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
    // The pattern targets real annotations; a bare word boundary also matched the
    // English word "any" inside a comment.
    expect(core, "Core contains explicit any").not.toMatch(explicitAnyPattern);
    expect(storage, "Storage contains explicit any").not.toMatch(explicitAnyPattern);
  });

  it("keeps the Phase 6B loop above Context and narrow LLM contracts", async () => {
    const core = await readManifest("packages/core/package.json");
    const dependencies = dependencyEntries(core);
    expect(dependencies["@caelush/context"]).toBe("workspace:*");
    expect(dependencies["@caelush/llm"]).toBeUndefined();
    expect(dependencies["@caelush/protocol"]).toBe("workspace:*");
    // Phase 4F deleted `@caelush/tools`: the Tool Kernel the Phase 6B loop prepares tool calls for is
    // `@caelush/agent` now, and Core depends on it directly.
    expect(dependencies["@caelush/agent"]).toBe("workspace:*");
    expect(dependencies[retiredLegacyToolPackage.name]).toBeUndefined();
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
      "@caelush/ai",
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
    const imports = [...source.matchAll(/from\s+["'](@caelush\/ai(?:\/[^"']*)?)["']/g)].map(
      (match) => match[1],
    );
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((value) => value === "@caelush/ai")).toBe(true);
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
    // Phase 6F adds the Context Contribution projection, which reuses the same narrow redaction
    // source of truth as Context's existing project-derived text path.
    expect(securityImports).toHaveLength(3);
    expect(securityImports).toEqual(
      expect.arrayContaining(["@caelush/security/redaction", "@caelush/security/sensitive-path"]),
    );
    expect(source).not.toMatch(
      /from\s+["']@caelush\/(?:security|agent|coding-agent|runtime|storage|events|daemon)["']/,
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
