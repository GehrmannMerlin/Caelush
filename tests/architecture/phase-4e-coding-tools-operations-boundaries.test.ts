import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 4E — the Coding Tool product layer authority guard.
 *
 * ```text
 * @caelush/coding-agent   the nine Coding builtin business implementations
 * @caelush/agent          the general Agent Tool Kernel they are built on
 * apps/daemon             composes the target layer
 * ```
 *
 * The round's completion gate names two conditions that must hold *together*:
 *
 * ```text
 * the nine builtins are target-owned
 * there is no second business implementation of any of them
 * ```
 *
 * Either one alone is satisfiable by doing nothing useful — the first by leaving the target code
 * unreferenced, the second by deleting it. This guard is written to fail on both failure modes: it
 * asserts where the implementations are, that nothing outside the Coding product layer contains a
 * second one, and that production actually executes the target ones.
 *
 * It is a *source* guard, deliberately. The runtime behaviour is proven by the builtin suites, the
 * Operations contract suite, the Runtime adapter suite, the fidelity suite and the daemon E2E suites;
 * what a source guard adds is the thing those cannot see — that a second copy did not quietly return.
 *
 * ## Phase 4F revised this file
 *
 * Phase 4E's acceptance boundary included keeping the legacy `@caelush/tools` package alive with its
 * facade surface intact, and this guard asserted that directly. Phase 4F **retired that package**, so
 * every assertion that named it has been restated as the permanent rule it was standing in for:
 * "the Coding product layer owns this and nothing else does". The migration-era assertions were
 * replaced, never weakened — a guard whose subject was deleted is repointed at the owner, not emptied.
 */

const repositoryRoot = process.cwd();

function abs(...parts: readonly string[]): string {
  return path.join(repositoryRoot, ...parts);
}

async function read(relativePath: string): Promise<string> {
  return await readFile(abs(relativePath), "utf8");
}

/** True when a path exists. A guard must be able to assert an absence without throwing. */
async function exists(relativePath: string): Promise<boolean> {
  try {
    await stat(abs(relativePath));
    return true;
  } catch {
    return false;
  }
}

/** Source with comments removed, so documentation about a forbidden pattern is not a violation. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

async function filesUnder(relativeDir: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(abs(relativeDir), { withFileTypes: true })) {
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(relative)));
    else if (entry.name.endsWith(".ts")) found.push(relative);
  }
  return found;
}

/** Every active TypeScript source in the workspace, so a rule can be checked repository-wide. */
async function allSourceFiles(): Promise<readonly string[]> {
  const roots = ["apps", "packages", "tests", "scripts"];
  const found: string[] = [];
  for (const root of roots) {
    if (!(await exists(root))) continue;
    for (const file of await filesUnder(root)) {
      // Normalise before filtering: on Windows `path.join` produces backslashes, and a `/dist/` test
      // against a backslash path silently keeps generated output in scope.
      const normalized = file.replaceAll("\\", "/");
      if (normalized.includes("node_modules") || normalized.includes("/dist/")) continue;
      // The top-level `tests/` tree is a test tree even where its path has no `/test/` segment.
      if (normalized.startsWith("tests/")) continue;
      found.push(normalized);
    }
  }
  return found;
}

/**
 * The workspace's production sources only.
 *
 * A guard that asserts "nobody else declares this" must exclude tests: a test fixture is allowed — and
 * often required — to build a Tool of its own, and treating a fixture as a second implementation would
 * make the rule unfalsifiable in the other direction.
 */
async function sourceFilesUnder(relativeDir: string): Promise<readonly string[]> {
  return (await allSourceFiles()).filter(
    (file) => file.startsWith(`${relativeDir}/`) && !file.includes("/test/"),
  );
}

const NINE = [
  "read_file",
  "list_directory",
  "find_files",
  "search_text",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "git_status",
  "git_diff",
] as const;

describe("Phase 4E guard — builtin ownership", () => {
  it("declares all nine builtins in @caelush/coding-agent, one file each", async () => {
    const files = await filesUnder("packages/coding-agent/src/tools/builtins");

    for (const name of NINE) {
      const file = files.find(
        (entry) => path.basename(entry) === `${name.replaceAll("_", "-")}.ts`,
      );
      expect(file, name).toBeDefined();
      const text = await readFile(abs(file!), "utf8");
      // Each one really declares its Tool, rather than re-exporting another module's.
      expect(text, name).toMatch(new RegExp(`name: "${name}"`));
      expect(text, name).toContain("defineCodingTool({");
    }

    // And the default set composes exactly those nine, in the frozen order.
    const defaultTools = code(
      await read("packages/coding-agent/src/tools/builtins/default-tools.ts"),
    );
    const order = [...defaultTools.matchAll(/^\s{2}"([a-z_]+)",$/gm)].map((match) => match[1]);
    expect(order).toEqual([...NINE]);
  });

  it("declares the nine builtins in exactly one place in production source", async () => {
    // Which package declares each Tool's provider-visible name, and how many times. Tests are excluded:
    // a fixture may construct a Tool, and that is not a second implementation of a Coding builtin.
    const declarations = new Map<string, string[]>(NINE.map((name) => [name, []]));
    for (const file of await allSourceFiles()) {
      if (file.includes("/test/")) continue;
      const text = code(await read(file));
      for (const name of NINE) {
        if (text.includes(`name: "${name}"`)) declarations.get(name)!.push(file);
      }
    }

    for (const [name, where] of declarations) {
      expect(where, name).toEqual([
        `packages/coding-agent/src/tools/builtins/${name.replaceAll("_", "-")}.ts`,
      ]);
    }

    // And the default set composes exactly those nine, in the frozen order.
    const defaultTools = code(
      await read("packages/coding-agent/src/tools/builtins/default-tools.ts"),
    );
    const order = [...defaultTools.matchAll(/^\s{2}"([a-z_]+)",$/gm)].map((match) => match[1]);
    expect(order).toEqual([...NINE]);
  });

  it("has no second business implementation of any builtin", async () => {
    // A builtin's provider-visible surface exists in its own module and nowhere else in production
    // source. A file that names a Tool is a consumer, and a consumer may not restate the Tool's
    // contract — the name plus schema is what a Tool *is* in this architecture.
    const ownerDir = "packages/coding-agent/src/tools/builtins";
    for (const file of await allSourceFiles()) {
      if (file.includes("/test/")) continue;
      if (file.startsWith(`${ownerDir}/`)) continue;

      const text = code(await read(file));
      for (const name of NINE) {
        if (!text.includes(`name: "${name}"`)) continue;
        expect(file, `${name} redeclared`).toBe(ownerDir);
      }
    }
  });

  it("declares each of the nine Coding factories exactly once", async () => {
    const expected: readonly (readonly [string, string])[] = [
      ["createReadFileTool", "read-file.ts"],
      ["createListDirectoryTool", "list-directory.ts"],
      ["createFindFilesTool", "find-files.ts"],
      ["createSearchTextTool", "search-text.ts"],
      ["createApplyPatchTool", "apply-patch.ts"],
      ["createExecCommandTool", "exec-command.ts"],
      ["createWriteStdinTool", "write-stdin.ts"],
      ["createGitStatusTool", "git-status.ts"],
      ["createGitDiffTool", "git-diff.ts"],
    ];

    const declared = new Map<string, string[]>(expected.map(([name]) => [name, []]));
    for (const file of await allSourceFiles()) {
      const text = code(await read(file));
      const normalized = file.replaceAll("\\", "/");
      for (const [name] of expected) {
        if (new RegExp(`export function ${name}\\(`).test(text))
          declared.get(name)!.push(normalized);
      }
    }

    for (const [name, fileName] of expected) {
      expect(declared.get(name), name).toEqual([`${ownerDirPath()}/${fileName}`]);
    }
  });

  it("re-exports the canonical Coding security facts, effects and approval identity", async () => {
    // Each of the three modules the round owns must contain the algorithm, not a delegation to a
    // second copy. Phase 4F removed the legacy package that used to hold the delegating twins, so the
    // statement is now the strong one: this is where the function objects live.
    const securityFacts = code(
      await read("packages/coding-agent/src/tools/security/security-facts.ts"),
    );
    expect(securityFacts).toContain("inspectPatchTargets");
    expect(securityFacts).toContain("projectReadFileSecurityFacts");

    const effects = code(
      await read("packages/coding-agent/src/tools/effects/effect-projectors.ts"),
    );
    // The patch effect projector switches on the change kind: one algorithm, in the Coding layer.
    expect(effects).toContain("export function projectPatchEffects(");
    expect(effects).toContain(".kind ===");
    expect(effects).toContain("export function projectReadFileEffect(");

    const approval = code(
      await read("packages/coding-agent/src/tools/security/approval-identity.ts"),
    );
    expect(approval).toContain("computeCodingToolApprovalKey");
    expect(approval).toContain("createHash");
    expect(approval).toContain("canonicalJsonString");

    const guidance = code(await read("packages/coding-agent/src/tools/prompt/prompt-snippets.ts"));
    expect(guidance).toContain("CODING_TOOL_PROMPT_SNIPPETS");
    expect(guidance).toContain("READ_FILE_PROMPT_SNIPPET");
  });
});

/** The one directory the nine Coding builtin modules live in, with forward slashes. */
function ownerDirPath(): string {
  return "packages/coding-agent/src/tools/builtins";
}

describe("Phase 4E guard — the Runtime boundary", () => {
  it("keeps RuntimeResolver and RuntimeWorkspaceScope out of the builtins", async () => {
    const files = await filesUnder("packages/coding-agent/src/tools/builtins");

    for (const file of files) {
      const text = code(await readFile(abs(file), "utf8"));
      const name = path.relative(repositoryRoot, abs(file));
      for (const forbidden of [
        "RuntimeResolver",
        "RuntimeWorkspaceScope",
        "RuntimeFileSystem",
        "RuntimeGitService",
        "RuntimeExecService",
        "resolveRuntimeWorkspace",
        "openWorkspace",
      ]) {
        expect(text, `${name} / ${forbidden}`).not.toContain(forbidden);
      }
      // A builtin reaches its capability through one narrow port, never a scope object.
      expect(text, name).not.toMatch(/\bscope\./);
      expect(text, name).not.toContain("node:fs");
      expect(text, name).not.toContain("node:child_process");
    }
  });

  it("names the one directory allowed to hold the broad Runtime types", async () => {
    const adapters = await filesUnder(
      "packages/coding-agent/src/tools/operations/runtime-adapters",
    );
    expect(adapters.length).toBeGreaterThan(0);

    const holders: string[] = [];
    for (const file of await filesUnder("packages/coding-agent/src")) {
      const text = code(await read(file));
      if (text.includes("RuntimeResolver") || text.includes("RuntimeWorkspaceScope")) {
        const relative = path.relative(repositoryRoot, abs(file)).replaceAll("\\", "/");
        holders.push(relative);
      }
    }

    for (const holder of holders) {
      expect(holder, holder).toContain(
        "packages/coding-agent/src/tools/operations/runtime-adapters/",
      );
    }

    const combined = (await Promise.all(adapters.map(async (file) => await read(file)))).join("\n");
    // The capability really is used there, and only there: the adapters open a workspace and reach
    // every capability family the Operations ports describe.
    for (const call of [
      "pathResolver.resolveExisting",
      "filesystem.readTextFile",
      "filesystem.readDirectory",
      "discovery.find",
      "textSearch.search",
      "patch.apply",
      "exec.execute",
      "exec.interact",
      "git.status",
      "git.diff",
    ]) {
      expect(combined, call).toContain(call);
    }
  });
});

describe("Phase 4E guard — dependency direction", () => {
  it("keeps the Coding product layer one-way: it depends on the Agent Kernel, never the reverse", async () => {
    const codingManifest = JSON.parse(await read("packages/coding-agent/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // The Coding product layer builds on the general Agent Tool Kernel and on nothing legacy.
    expect(codingManifest.dependencies?.["@caelush/agent"]).toBe("workspace:*");
    expect(codingManifest.dependencies?.["@caelush/tools"]).toBeUndefined();
    expect(codingManifest.devDependencies?.["@caelush/tools"]).toBeUndefined();

    const agentManifest = JSON.parse(await read("packages/agent/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // The Kernel may never depend back on the Coding product layer.
    expect(agentManifest.dependencies?.["@caelush/coding-agent"]).toBeUndefined();
    expect(agentManifest.devDependencies?.["@caelush/coding-agent"]).toBeUndefined();
    expect(agentManifest.dependencies?.["@caelush/tools"]).toBeUndefined();
  });

  it("keeps the retired legacy package out of the coding-agent source and out of the workspace", async () => {
    for (const file of await filesUnder("packages/coding-agent/src")) {
      const text = code(await read(file));
      expect(text, path.relative(repositoryRoot, abs(file))).not.toContain('"@caelush/tools"');
    }
    expect(await exists("packages/tools")).toBe(false);
  });
});

describe("Phase 4E guard — Operations declarations", () => {
  it("declares each of the eight Operations interfaces exactly once", async () => {
    const names = [
      "ReadFileOperations",
      "ListDirectoryOperations",
      "FindFilesOperations",
      "SearchTextOperations",
      "PatchOperations",
      "ExecOperations",
      "ProcessOperations",
      "GitOperations",
    ];

    const occurrences = new Map<string, string[]>(names.map((name) => [name, []]));
    for (const file of await filesUnder("packages/coding-agent/src/tools/operations")) {
      const text = code(await read(file));
      const relative = path.relative(repositoryRoot, abs(file)).replaceAll("\\", "/");
      for (const name of names) {
        if (new RegExp(`export interface ${name} \\{`).test(text)) {
          occurrences.get(name)!.push(relative);
        }
      }
    }

    for (const [name, where] of occurrences) {
      expect(where, name).toHaveLength(1);
    }
    // And no second declaration anywhere else in the repository's source.
    for (const root of ["packages/agent/src", "packages/core/src", "packages/security/src"]) {
      for (const file of await filesUnder(root)) {
        const text = code(await read(file));
        for (const name of names) {
          expect(text, `${file} / ${name}`).not.toMatch(new RegExp(`export interface ${name} \\{`));
        }
      }
    }
  });

  it("implements and publishes each Runtime Operations adapter", async () => {
    const files = await filesUnder("packages/coding-agent/src/tools/operations/runtime-adapters");
    const sources = new Map<string, string>();
    for (const file of files) {
      sources.set(file.replaceAll("\\", "/"), await read(file));
    }
    const combined = [...sources.values()].join("\n");
    const barrel =
      sources.get("packages/coding-agent/src/tools/operations/runtime-adapters/index.ts") ?? "";
    expect(barrel.length, "the adapter barrel").toBeGreaterThan(0);

    for (const factory of [
      "createRuntimeReadOnlyOperations",
      "createRuntimePatchOperations",
      "createRuntimeProcessOperations",
      "createRuntimeGitOperations",
      "resolveRuntimeWorkspace",
    ]) {
      // Declared by one of the adapter modules...
      expect(combined, `${factory} declared`).toContain(`function ${factory}`);
      // ...and reachable from the barrel the composition root imports.
      expect(barrel, `${factory} published`).toContain(factory);
    }
  });
});

describe("Phase 4E guard — the Coding definition field", () => {
  it("keeps the executable Tool on a field named `tool`, with no operations member", async () => {
    const text = code(await read("packages/coding-agent/src/tools/coding-tool-definition.ts"));

    expect(text).toMatch(/readonly tool: AgentTool;/);
    // The freeze forbids an `operations` field on the definition: listing a port there would turn
    // metadata into a capability handle. Operations are injected by closure.
    expect(text).not.toMatch(/readonly operations\s*[?:]/);
    expect(text).toContain("promptSnippet");
  });
});

describe("Phase 4E guard — prompt authority", () => {
  it("keeps promptSnippet out of AIToolSpec.description", async () => {
    // Phase 4F removed the legacy builder that used to fold *explicitly supplied* guidance into a
    // description. The rule is now absolute and repository-wide: nothing in the workspace appends
    // Coding guidance to a Tool description, and no Coding Tool supplies `modelGuidance` at all.
    // That is what keeps usage guidance in the budgeted Context block, where Phase 4E put it.
    for (const file of await allSourceFiles()) {
      const text = code(await read(file));
      expect(text, `${file} / appendToolModelGuidance`).not.toContain("appendToolModelGuidance");
      expect(text, `${file} / ToolModelGuidance`).not.toContain("ToolModelGuidance");
      expect(text, `${file} / createBuiltinToolModelGuidance`).not.toContain(
        "createBuiltinToolModelGuidance",
      );
    }
    expect(await exists("packages/tools")).toBe(false);
  });

  it("gives ToolPromptContextProvider a real production composition reference", async () => {
    const source = await read("apps/daemon/src/daemon-composition.ts");

    expect(source).toContain("createToolPromptContextProvider()");
    expect(source).toContain("toolGuidance,");
    expect(source).toContain("toContextGuidanceItem");
    // The guidance reaches the renderer through the Context build input, not through a request the
    // budget never measured.
    const adapter = await read("packages/core/src/legacy-context-runtime-adapter.ts");
    expect(adapter).toContain("toolGuidanceItems");
    const builder = await read("packages/context/src/context-builder.ts");
    expect(builder).toContain("toolGuidanceItems");
    const renderer = await read("packages/context/src/context-renderer.ts");
    expect(renderer).toContain("renderToolGuidance");
  });
});

describe("Phase 4E guard — production composition", () => {
  it("has the daemon compose the target Coding layer", async () => {
    const source = code(await read("apps/daemon/src/daemon-composition.ts"));

    expect(source).toContain("createDefaultCodingTools(");
    expect(source).toContain("createRuntimeReadOnlyOperations(");
    expect(source).toContain("createRuntimePatchOperations(");
    expect(source).toContain("createRuntimeProcessOperations(");
    expect(source).toContain("createRuntimeGitOperations(");
    // The legacy default builder is no longer named in the composition root.
    expect(source).not.toContain("createDefaultBuiltinToolRegistrations");
  });

  it("has the daemon bootstrap compose the target Coding layer too", async () => {
    const source = code(await read("apps/daemon/src/daemon.ts"));

    expect(source).toContain("createDefaultCodingTools(");
    expect(source).not.toContain("createDefaultBuiltinToolRegistrations");
    expect(source).not.toContain("buildCodingCatalog");
  });

  it("never reintroduces the legacy Dispatcher into production", async () => {
    for (const file of [
      "apps/daemon/src/daemon-composition.ts",
      "apps/daemon/src/daemon.ts",
      "packages/core/src/run-controller.ts",
    ]) {
      const text = code(await read(file).catch(() => ""));
      expect(text, file).not.toContain("new ToolDispatcher(");
      expect(text, file).not.toContain("createV1SecureToolDispatcher(");
    }
  });

  it("reads a Coding Tool's durable risk from the catalog rather than a second Tool description", async () => {
    const adapter = code(
      await read("packages/coding-agent/src/tools/admission/tool-admission-port.ts"),
    );

    // The Coding catalog is the authority for a Coding Tool's risk; a Tool it does not describe has no
    // Coding metadata at all, which is what keeps a plugin Tool a first-class citizen.
    expect(adapter).toContain("options.catalog?.get(toolName)?.security.riskLevel");
    expect(adapter).toContain("options.registry.resolve(toolName)");

    const composition = await read("apps/daemon/src/daemon-composition.ts");
    expect(composition).toContain("catalog: codingCatalog,");
    // The overlay is built from the definitions the registry was built from, against that registry, so
    // a dangling overlay is refused rather than left behind.
    const catalogFactory = code(await read("apps/daemon/src/daemon-composition.ts"));
    expect(
      catalogFactory.includes("new CodingToolCatalogBuilder().forRegistry(") ||
        catalogFactory.includes("createCodingToolCatalog("),
    ).toBe(true);
  });
});

describe("Phase 4E guard — the Phase 4D pipeline is still production", () => {
  it("keeps the canonical batch, coordinator, pipeline and feedback authorities", async () => {
    const source = code(await read("apps/daemon/src/daemon-composition.ts"));

    expect(source).toContain("createToolBatchCoordinator({");
    expect(source).toContain("createDurableToolExecutionCoordinator({");
    expect(source).toContain("createModelToolFeedbackProjector({");
    expect(source).toContain("createToolResultBatchNormalizer()");
    expect(source).toContain("createToolCallPreparer(");
    expect(source).not.toContain("new ToolBatchCoordinator(");
  });

  it("keeps the legacy batch coordinator and Dispatcher out of the production root", async () => {
    const source = code(await read("apps/daemon/src/daemon-composition.ts"));

    // A TypeScript *reference*, not the bare word: the doc comments explain the cutover in prose.
    expect(source).not.toMatch(/\bToolBatchCoordinator\s*[;,)<]/);
    expect(source).not.toMatch(/\bToolDispatcher\s*[;,)<]/);
  });
});

describe("Phase 4E guard — the surfaces 4E deliberately preserved are now retired", () => {
  it("records that Phase 4F removed @caelush/tools rather than leaving it in the workspace", async () => {
    expect(await exists("packages/tools")).toBe(false);
    expect(await exists("packages/tools/package.json")).toBe(false);
    expect(await exists("packages/tools/src/index.ts")).toBe(false);
  });

  it("leaves no legacy Tool symbol declared anywhere in production source", async () => {
    for (const root of ["packages", "apps"]) {
      for (const file of await sourceFilesUnder(root)) {
        const text = code(await read(file));
        // A `class`/`interface`/`type` declaration is the thing that must be gone. A guard or a
        // migration record may still *name* a retired symbol — several deliberately do, to assert that
        // it stays gone — so this test binds every production source, not every file in the tree.
        for (const declaration of [
          "class ToolDispatcher",
          "class ToolRegistryBuilder",
          "class ToolPreflight",
          "class ToolFailureMemory",
          "interface ToolRegistration",
          "interface ToolBatchItemResult",
          "class ToolBatchCoordinator",
        ]) {
          expect(text, `${file} / ${declaration}`).not.toContain(declaration);
        }
      }
    }
  });

  it("leaves protocol.ToolDefinition and its schema retired", async () => {
    const protocolTool = code(await read("packages/protocol/src/tool.ts"));
    expect(protocolTool).not.toContain("ToolDefinitionSchema");
    expect(protocolTool).not.toContain("export type ToolDefinition");
    // The durable identity primitives the round must keep are untouched.
    expect(protocolTool).toContain("export const ToolNameSchema = z");
    expect(protocolTool).toContain("export const ToolInvocationSchema = z");
    expect(protocolTool).toContain("export type ToolInvocation =");
    expect(protocolTool).toContain(".strict()");
  });
});
