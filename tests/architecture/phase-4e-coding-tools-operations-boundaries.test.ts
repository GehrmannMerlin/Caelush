import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 4E — the Coding Tool product layer authority guard.
 *
 * ```text
 * @caelush/coding-agent   the nine Coding builtin business implementations
 * @caelush/tools          compatibility facades that delegate there and own no algorithm
 * apps/daemon             composes the target layer; the legacy default builder is not on the path
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
 * asserts where the implementations are, that the legacy modules contain none, and that production
 * actually executes the target ones.
 *
 * It is a *source* guard, deliberately. The runtime behaviour is proven by the builtin suites, the
 * Operations contract suite, the Runtime adapter suite, the fidelity suite and the daemon E2E suites;
 * what a source guard adds is the thing those cannot see — that a second copy did not quietly return.
 */

const repositoryRoot = process.cwd();

function abs(...parts: readonly string[]): string {
  return path.join(repositoryRoot, ...parts);
}

async function read(relativePath: string): Promise<string> {
  return await readFile(abs(relativePath), "utf8");
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
      const file = files.find((entry) => path.basename(entry) === `${name.replaceAll("_", "-")}.ts`);
      expect(file, name).toBeDefined();
      const text = await readFile(abs(file!), "utf8");
      // Each one really declares its Tool, rather than re-exporting another module's.
      expect(text, name).toMatch(new RegExp(`name: "${name}"`));
      expect(text, name).toContain("defineCodingTool({");
    }

    // And the default set composes exactly those nine, in the frozen order.
    const defaultTools = code(await read("packages/coding-agent/src/tools/builtins/default-tools.ts"));
    const order = [...defaultTools.matchAll(/^\s{2}"([a-z_]+)",$/gm)].map((match) => match[1]);
    expect(order).toEqual([...NINE]);
  });

  it("keeps the nine authoritative implementations out of @caelush/tools", async () => {
    const files = await filesUnder("packages/tools/src/builtins");

    for (const file of files) {
      const text = code(await readFile(abs(file), "utf8"));
      const name = path.relative(repositoryRoot, abs(file)).replaceAll("\\", "/");
      // `result.ts` is the shared helper module and is asserted separately: it is a re-export list.
      if (name === "packages/tools/src/builtins/result.ts") continue;

      // A facade may not declare a Tool's provider-visible surface...
      expect(text, name).not.toContain("inputSchema");
      expect(text, name).not.toContain("additionalProperties");
      // ...nor its argument bounds...
      expect(text, name).not.toContain("positiveBoundedInteger");
      expect(text, name).not.toContain("DEFAULT_LIMIT =");
      // ...nor its failure vocabulary...
      expect(text, name).not.toContain("errorResult(");
      // ...nor its result shaping...
      expect(text, name).not.toContain("successResult(");
      // ...nor a Runtime scope of its own.
      expect(text, name).not.toContain("withRuntimeScope");
      expect(text, name).not.toContain("openWorkspace");
      expect(text, name).not.toMatch(/\bscope\./);
    }
  });

  it("keeps the legacy builtin result helpers a re-export list", async () => {
    const text = code(await read("packages/tools/src/builtins/result.ts"));

    // One bound table and one pair of details schemas, both in the Coding product layer. The legacy
    // module names them and declares nothing.
    expect(text).toContain('from "@caelush/coding-agent"');
    expect(text).not.toContain("export const");
    expect(text).not.toContain("export function");
    expect(text).not.toContain("additionalProperties");
    // And it does not bring back the per-call runtime resolution the round removed.
    expect(text).not.toContain("withRuntimeScope");
    expect(text).not.toContain("RuntimeResolver");
  });

  it("makes every legacy builtin module delegate to a Coding factory", async () => {
    const expected: readonly (readonly [string, string])[] = [
      ["read-file.ts", "createReadFileTool"],
      ["list-directory.ts", "createListDirectoryTool"],
      ["find-files.ts", "createFindFilesTool"],
      ["search-text.ts", "createSearchTextTool"],
      ["apply-patch.ts", "createApplyPatchTool"],
      ["exec-command.ts", "createExecCommandTool"],
      ["write-stdin.ts", "createWriteStdinTool"],
      ["git-status.ts", "createGitStatusTool"],
      ["git-diff.ts", "createGitDiffTool"],
    ];

    for (const [fileName, factory] of expected) {
      const text = await read(`packages/tools/src/builtins/${fileName}`);
      expect(text, fileName).toContain(`from "@caelush/coding-agent"`);
      expect(text, fileName).toContain(factory);
      // The delegation is the whole body: the module adapts a CodingToolDefinition and returns.
      expect(text, fileName).toContain("toLegacyToolRegistration(");
      expect(text, fileName).toContain("createRuntime");
    }
  });

  it("keeps the legacy security facts, effects and approval identity as re-exports", async () => {
    // Each of the three modules the round re-pointed must read as a delegation list, not as a second
    // algorithm. The projectors themselves are asserted to be the canonical function objects by the
    // authority-fidelity suite; this is the source-side statement of the same fact.
    const securityFacts = code(await read("packages/tools/src/builtins/security-facts.ts"));
    expect(securityFacts).toContain('from "@caelush/coding-agent"');
    expect(securityFacts).not.toContain("inspectPatchTargets");
    expect(securityFacts).not.toContain("replaceAll");

    const effects = code(await read("packages/tools/src/tool-effects.ts"));
    expect(effects).toContain('from "@caelush/coding-agent"');
    expect(effects).not.toContain("changeType ===");
    expect(effects).not.toContain("switch (effect.type)");

    const approval = code(await read("packages/tools/src/approval-key.ts"));
    expect(approval).toContain("computeCodingToolApprovalKey");
    expect(approval).not.toContain("createHash");
    expect(approval).not.toContain("canonicalJsonString");

    const guidance = code(await read("packages/tools/src/model-guidance.ts"));
    expect(guidance).toContain("CODING_TOOL_PROMPT_SNIPPETS");
    // The eight-field table is gone: the text has one source, the Coding prompt snippet.
    expect(guidance).not.toContain("purpose: \"Read bounded UTF-8 text.\"");
  });
});

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
    const adapters = await filesUnder("packages/coding-agent/src/tools/operations/runtime-adapters");
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
  it("lets @caelush/tools depend on @caelush/coding-agent and never the reverse", async () => {
    const toolsManifest = JSON.parse(await read("packages/tools/package.json")) as {
      dependencies?: Record<string, string>;
    };
    expect(toolsManifest.dependencies?.["@caelush/coding-agent"]).toBe("workspace:*");

    const codingManifest = JSON.parse(await read("packages/coding-agent/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(codingManifest.dependencies?.["@caelush/tools"]).toBeUndefined();
    expect(codingManifest.devDependencies?.["@caelush/tools"]).toBeUndefined();
  });

  it("keeps @caelush/tools out of the coding-agent source", async () => {
    for (const file of await filesUnder("packages/coding-agent/src")) {
      const text = code(await read(file));
      expect(text, path.relative(repositoryRoot, abs(file))).not.toContain('"@caelush/tools"');
    }
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
    for (const root of ["packages/tools/src", "packages/agent/src", "packages/core/src"]) {
      for (const file of await filesUnder(root)) {
        const text = code(await read(file));
        for (const name of names) {
          expect(text, `${file} / ${name}`).not.toMatch(
            new RegExp(`export interface ${name} \\{`),
          );
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
    // The legacy builder still folds *explicitly supplied* guidance into a description, which is public
    // API until Phase 4F. What must not happen is the Coding snippet being appended there.
    const builder = code(await read("packages/tools/src/registry-builder.ts"));
    expect(builder).toContain("appendToolModelGuidance");
    expect(builder).not.toContain("promptSnippet");

    // And no builtin facade supplies guidance at all.
    for (const file of await filesUnder("packages/tools/src/builtins")) {
      const text = code(await read(file));
      expect(text, file).not.toContain("modelGuidance");
    }
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

  it("reads a Coding Tool's durable risk from the catalog rather than a legacy definition", async () => {
    const adapter = code(await read("packages/tools/src/tool-admission-adapter.ts"));

    // `catalog` is consulted first; the registered definition is the fallback for a generic Tool that
    // has no Coding metadata at all, which is what keeps a plugin Tool a first-class citizen.
    expect(adapter).toContain("options.catalog?.get(toolName)?.security.riskLevel");
    expect(adapter).toContain("definitionsByName.get(toolName) ?? options.registry.resolve(toolName)?.definition");

    const composition = await read("apps/daemon/src/daemon-composition.ts");
    expect(composition).toContain("catalog: codingCatalog,");
    expect(composition).toContain("await builtToolRegistry.buildCodingCatalog()");
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

describe("Phase 4E guard — no early Phase 4F", () => {
  it("keeps @caelush/tools, its public surface and protocol.ToolDefinition", async () => {
    const manifest = JSON.parse(await read("packages/tools/package.json")) as { exports?: unknown };
    expect(manifest.exports).toBeDefined();

    const index = await read("packages/tools/src/index.ts");
    for (const legacyName of [
      "ToolRegistryBuilder",
      "ToolDispatcher",
      "computeToolApprovalKey",
      "createDefaultBuiltinToolRegistrations",
      "createGitToolRegistrations",
      "createReadOnlyFilesystemToolRegistrations",
      "createFileMutationToolRegistrations",
      "createShellToolRegistrations",
      "createExecCommandRegistration",
      "createWriteStdinRegistration",
      "createGitStatusRegistration",
      "createGitDiffRegistration",
      "ToolDefinition",
      "ToolExecutionResult",
      "ToolBatchCoordinator",
    ]) {
      expect(index, legacyName).toContain(legacyName);
    }

    // `protocol.ToolDefinition` is untouched: still the seven-field strict schema.
    const protocolTool = code(await read("packages/protocol/src/tool.ts"));
    expect(protocolTool).toContain("export const ToolDefinitionSchema = z");
    expect(protocolTool).toContain("inputSchema: JsonObjectSchema");
    expect(protocolTool).toContain("outputSchema: JsonObjectSchema");
    expect(protocolTool).toContain('.strict()');
  });

  it("keeps the legacy direct compatibility APIs callable", async () => {
    // A representative set of names the round promised to keep until Phase 4F. The fidelity suite proves
    // they work; this proves each still has a declaration on the legacy package's surface.
    const declarations = (
      await Promise.all((await filesUnder("packages/tools/src")).map(async (file) => await read(file)))
    ).join("\n");

    for (const name of [
      "createReadFileRegistration",
      "createListDirectoryRegistration",
      "createFindFilesRegistration",
      "createSearchTextRegistration",
      "createApplyPatchRegistration",
      "createExecCommandRegistration",
      "createWriteStdinRegistration",
      "createGitStatusRegistration",
      "createGitDiffRegistration",
      "createDefaultBuiltinToolRegistrations",
      "createGitToolRegistrations",
      "createReadOnlyFilesystemToolRegistrations",
      "createFileMutationToolRegistrations",
      "createShellToolRegistrations",
      "createCodingToolAdmissionPort",
      "createCodingToolDurableMetadataPort",
      "createLegacyToolSettlementExtensionProjector",
      "createLegacyToolSettlementExtensionDecoder",
      "filterToolRegistryForEnvironment",
      "computeToolApprovalKey",
    ]) {
      expect(declarations, name).toContain(`export function ${name}`);
    }

    for (const name of [
      "ToolRegistryBuilder",
      "ToolDispatcher",
      "ToolPreflight",
      "ToolFailureMemory",
      "ToolBatchCoordinator",
    ]) {
      expect(declarations, name).toContain(`export class ${name}`);
    }
  });
});
