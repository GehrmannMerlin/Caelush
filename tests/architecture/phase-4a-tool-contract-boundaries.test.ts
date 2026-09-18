import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 4A Tool contract, registry and call-preparation boundary guards.
 *
 * ```text
 * one executable Tool contract          @caelush/agent, extended from the frozen AIToolSpec
 * one schema compiler                   the canonical schema runtime, and no second AJV instance
 * one registry authority                the canonical registry; the legacy one only projects it
 * one argument-preparation path         the canonical Preparer; the legacy one only formats outcomes
 * one Coding overlay                    @caelush/coding-agent, keyed by the registry's ToolName
 * no Coding vocabulary in the kernel    a general AgentTool cannot carry product policy
 * no second execution authority         this round adds no scheduler, executor or durable pipeline
 * ```
 *
 * Phase 4A's success criterion is an **authority switch**: the executable Tool contract, schema
 * compilation, registration/resolution and argument preparation moved into `@caelush/agent`, and
 * `@caelush/tools` became a compatibility facade over them. These guards are structural, so a later
 * refactor cannot quietly reintroduce a second compiler, a second registry, a second normalization
 * or a Coding field on the general Tool.
 */

const root = process.cwd();

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8").replaceAll("\r\n", "\n");
}

/** Every file under a directory, whatever its extension. */
function allFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...allFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** A file's executable code, with its documentation removed. */
function executable(relativePath: string): string {
  return read(relativePath)
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every production source file in the workspace, excluding builds and tests. */
function productionSources(): string[] {
  return [...sourceFiles(join(root, "packages")), ...sourceFiles(join(root, "apps"))]
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .filter((file) => !file.includes("/dist/") && !file.includes("/test/"));
}

function filesUnder(prefix: string): string[] {
  return productionSources().filter((file) => file.startsWith(prefix));
}

function importsFrom(source: string): string[] {
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] as string);
}

const AGENT_TOOLS = "packages/agent/src/tools/";
const CODING_TOOLS = "packages/coding-agent/src/tools/";
const LEGACY_TOOLS = "packages/tools/src/";

describe("Phase 4A Agent Tool package boundaries", () => {
  it("keeps the Agent Tool framework free of Coding, Runtime, Storage and legacy Tool code", () => {
    const forbidden = [
      "@caelush/coding-agent",
      "@caelush/runtime",
      "@caelush/storage",
      "@caelush/tools",
      "@caelush/security",
      "@caelush/context",
      "@caelush/core",
      "@caelush/verification",
      "@caelush/events",
      "@caelush/llm",
      "@caelush/memory",
    ];
    const violations: string[] = [];
    for (const file of filesUnder(AGENT_TOOLS)) {
      for (const specifier of importsFrom(executable(file))) {
        if (forbidden.includes(specifier)) violations.push(`${file} -> ${specifier}`);
        if (specifier.startsWith("@caelush/agent/") || specifier.startsWith("@caelush/protocol/")) {
          violations.push(`${file} -> ${specifier} (subpath)`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps a general AgentTool free of every Coding field", () => {
    const declaration = executable("packages/agent/src/tools/types/agent-tool.ts");

    // The contract is exactly `AIToolSpec` plus execution: a general Tool has no product policy.
    expect(declaration).toContain("export interface AgentTool<");
    expect(declaration).toContain("extends AIToolSpec {");
    expect(declaration).toContain("readonly label: string;");
    expect(declaration).toContain("readonly resultDetailsSchema: JsonObject;");
    expect(declaration).toContain("readonly executionMode: ToolExecutionMode;");
    expect(declaration).toContain("readonly prepareArguments?:");
    expect(declaration).toContain("readonly execute: (");

    for (const forbidden of [
      "riskLevel",
      "requiredCapabilities",
      "runtimeRequirements",
      "securityFactsProjector",
      "effectProjector",
      "presentation",
      "promptSnippet",
      "RuntimeResolver",
      "ApprovalRepository",
      "operations",
    ]) {
      expect(declaration, `AgentTool must not declare ${forbidden}`).not.toContain(forbidden);
    }
    // And it does not restate the AI tool contract: there is one `AIToolSpec`.
    expect(declaration).not.toContain("export interface AIToolSpec");
    expect(join(root, "packages/agent/src/tools/types/agent-tool.ts")).toBeTruthy();
    expect(executable("packages/agent/src/tools/types/agent-tool.ts")).toContain('@caelush/ai"');
  });

  it("keeps the canonical registry free of Security and effect metadata", () => {
    for (const file of ["registry.ts", "registry-builder.ts"]) {
      const source = executable(`${AGENT_TOOLS}registry/${file}`);
      for (const forbidden of [
        "riskLevel",
        "requiredCapabilities",
        "runtimeRequirements",
        "securityFactsProjector",
        "effectProjector",
        "promptSnippet",
        "CodingTool",
      ]) {
        expect(source, `${file} must not carry ${forbidden}`).not.toContain(forbidden);
      }
    }

    // `ResolvedAgentTool` has exactly three fields, so a Coding field has nowhere to hide.
    const registry = executable(`${AGENT_TOOLS}registry/registry.ts`);
    expect(registry).toContain("export interface ResolvedAgentTool {");
    const resolvedBody = registry.slice(
      registry.indexOf("export interface ResolvedAgentTool {"),
      registry.indexOf("}", registry.indexOf("export interface ResolvedAgentTool {")),
    );
    expect(resolvedBody.match(/readonly /g) ?? []).toHaveLength(3);
    expect(resolvedBody).toContain("readonly tool: AgentTool;");
    expect(resolvedBody).toContain("readonly inputValidator: CompiledToolSchema;");
    expect(resolvedBody).toContain("readonly resultValidator: CompiledToolSchema;");
  });

  it("keeps the model-facing projection to exactly three fields", () => {
    const registry = executable(`${AGENT_TOOLS}registry/registry.ts`);
    const builder = executable(`${AGENT_TOOLS}registry/registry-builder.ts`);

    // The spec the registry stores is built from three fields and nothing else.
    const specBlock = builder.slice(
      builder.indexOf("const spec: AIToolSpec"),
      builder.indexOf("const clonedTool"),
    );
    expect(specBlock).toContain("name,");
    expect(specBlock).toContain("description: tool.description,");
    expect(specBlock).toContain("inputSchema: clonedSchema,");
    for (const leaked of ["label", "resultDetailsSchema", "executionMode", "prepareArguments"]) {
      expect(specBlock, `the model spec must not carry ${leaked}`).not.toContain(leaked);
    }
    expect(registry).toContain("modelSpecs(): readonly AIToolSpec[];");
  });

  it("keeps one schema compiler and no second argument-validation rule", () => {
    // Exactly one production module imports the schema compiler library.
    const compilerImporters = productionSources().filter((file) =>
      /from\s+["']ajv["']/.test(read(file)),
    );
    expect(compilerImporters).toEqual(["packages/agent/src/tools/schema/schema-runtime.ts"]);

    // Exactly one module declares the frozen AJV policy.
    const policyDeclarers = productionSources().filter((file) =>
      executable(file).includes("coerceTypes: false"),
    );
    expect(policyDeclarers).toEqual(["packages/agent/src/tools/schema/schema-runtime.ts"]);

    // Exactly one module declares the numeric compatibility normalization itself.
    const normalizationDeclarers = productionSources().filter((file) =>
      executable(file).includes("function parseNumericString("),
    );
    expect(normalizationDeclarers).toEqual([
      "packages/coding-agent/src/tools/legacy-argument-normalization.ts",
    ]);
  });

  it("keeps the target packages from importing the legacy Tool System", () => {
    const violations: string[] = [];
    for (const file of [...filesUnder(AGENT_TOOLS), ...filesUnder(CODING_TOOLS)]) {
      for (const specifier of importsFrom(executable(file))) {
        if (specifier === "@caelush/tools" || specifier.startsWith("@caelush/tools/")) {
          violations.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);

    // And each mechanism has exactly one declaration site, in the package that now owns it. A
    // second declaration anywhere would be a second authority with the same name; a barrel file
    // (`index.ts`) re-exporting is the whole point of a facade and is not a declaration.
    for (const [entry, declaration, owner] of [
      ["ToolRegistryBuilder", /\bclass ToolRegistryBuilder\b/, LEGACY_TOOLS],
      ["ToolPreflight", /\bclass ToolPreflight\b/, LEGACY_TOOLS],
      ["validateToolArguments", /\bfunction validateToolArguments\(/, LEGACY_TOOLS],
      ["ToolSchemaRuntime", /\bclass ToolSchemaRuntime\b/, `${AGENT_TOOLS}schema/`],
    ] as const) {
      const declarers = productionSources()
        .filter((file) => !file.endsWith("/index.ts"))
        .filter((file) => declaration.test(executable(file)));
      expect(declarers, `${entry} must be declared once`).toHaveLength(1);
      expect(declarers[0]!.startsWith(owner), `${entry} belongs to ${owner}`).toBe(true);
    }
  });

  it("declares the legacy package as a delegating facade, not a second implementation", () => {
    // The registry builder delegates to the canonical builder and declares no compiler of its own.
    const builder = executable(`${LEGACY_TOOLS}registry-builder.ts`);
    expect(builder).toContain("new DefaultAgentToolRegistryBuilder(this.canonicalOptions)");
    expect(builder).toContain("this.canonical.register(classified.agentTool)");
    expect(builder).toContain("this.canonical.build()");
    expect(builder).not.toContain("new Ajv(");
    expect(builder).not.toContain("compileSchema(");

    // Schema compilation is re-exported, not reimplemented.
    const schemaRuntime = executable(`${LEGACY_TOOLS}schema-runtime.ts`);
    expect(schemaRuntime).toContain("export { ToolSchemaRuntime");
    expect(schemaRuntime).not.toContain("new Ajv(");

    // Preflight delegates resolution and validation to the canonical implementations.
    const preflight = executable(`${LEGACY_TOOLS}preflight.ts`);
    expect(preflight).toContain("this.registry.resolve(toolName)");
    expect(preflight).toContain("validateToolArguments(tool, args");
    expect(preflight).not.toContain("inputValidator.validate(");

    // The one argument-validation entry point validates with the compiler that built the validator.
    const argumentValidation = executable(`${LEGACY_TOOLS}legacy-argument-validation.ts`);
    expect(argumentValidation).toContain("normalizeToolArgumentsForCompatibility");
    expect(argumentValidation).toContain("tool.inputValidator.validate(normalized)");
    expect(argumentValidation).not.toContain("new Ajv(");
    expect(argumentValidation).not.toContain("function parseNumericString(");

    // A legacy definition becomes a canonical Tool through exactly one classification function.
    const adapters = executable(`${LEGACY_TOOLS}tool-adapters.ts`);
    expect(adapters).toContain("export function resolveAgentToolRegistration(");
    expect(adapters).toContain("export function createLegacyExecute(");
    expect(adapters).not.toContain("new Ajv(");

    // The dispatcher prepares every call through the canonical Preparer.
    const dispatcher = executable(`${LEGACY_TOOLS}dispatcher.ts`);
    expect(dispatcher).toContain("createToolCallPreparer(options.registry.agentRegistry()");
    expect(dispatcher).toContain("return this.canonicalPreparer.prepare(request);");
    expect(dispatcher).toContain("this.prepareToolCall({");
  });

  it("keeps the Coding overlay in the Coding package, keyed by the registry's ToolName", () => {
    const contract = executable(`${CODING_TOOLS}coding-tool-definition.ts`);
    expect(contract).toContain("export interface CodingToolDefinition {");
    // The executable Tool's field is named `tool`, and Coding metadata is composed beside it.
    expect(contract).toContain("readonly tool: AgentTool;");
    expect(contract).toContain("readonly security: CodingToolSecurityMetadata;");
    expect(contract).toContain("readonly securityFactsProjector?:");
    expect(contract).toContain("readonly effectProjector?:");
    expect(contract).toContain("readonly presentation?: ToolPresentationPort");
    expect(contract).toContain("readonly promptSnippet?:");
    expect(contract).not.toContain("extends AgentTool");

    const catalog = executable(`${CODING_TOOLS}coding-tool-catalog.ts`);
    expect(catalog).toContain("export interface CodingToolCatalog {");
    expect(catalog).toContain("get(name: ToolName): CodingToolDefinition | undefined;");

    // The catalog refuses a dangling overlay when it is told which registry it belongs to.
    const catalogBuilder = executable(`${CODING_TOOLS}coding-tool-catalog-builder.ts`);
    expect(catalogBuilder).toContain("if (!registry.has(name))");
    expect(catalogBuilder).toContain('reason: "DANGLING_CODING_TOOL"');
  });

  it("adds no second execution authority and enables no parallelism", () => {
    // This round adds contracts, a registry and a Preparer — no executor, no scheduler, no pipeline.
    const toolFiles = [...filesUnder(AGENT_TOOLS), ...filesUnder(CODING_TOOLS)];
    const forbiddenDeclarations = [
      "class DurableToolExecutionCoordinator",
      "class ToolInvocationExecutor",
      "class ToolResultPipeline",
      "class ToolSettlementCoordinator",
      "class ToolAdmissionCoordinator",
      "class ToolBatchCoordinator",
      "NotImplemented",
    ];
    for (const file of toolFiles) {
      const source = executable(file);
      for (const forbidden of forbiddenDeclarations) {
        expect(source, `${file} must not declare ${forbidden}`).not.toContain(forbidden);
      }
    }

    // No production file gains a concurrency primitive for Tool execution.
    for (const file of [
      ...toolFiles,
      `${LEGACY_TOOLS}dispatcher.ts`,
      `${LEGACY_TOOLS}batch-coordinator.ts`,
    ]) {
      const source = executable(file);
      expect(source, `${file} must not introduce parallelism`).not.toMatch(
        /\bPromise\.all\b|\bPromise\.allSettled\b|\bnew Worker\b/,
      );
    }

    // The execution mode is a declaration only: nothing selects on it to schedule.
    const schedulers = productionSources().filter((file) =>
      /executionMode\s*===\s*"PARALLEL_SAFE"/.test(executable(file)),
    );
    expect(schedulers).toEqual([]);
  });

  it("adds no database migration and no public HTTP or SSE contract", () => {
    // The committed migration set is a directory, and this round adds no file to it.
    const migrationFiles = allFiles(join(root, "packages", "storage", "drizzle"))
      .map((path) => relative(root, path).replaceAll("\\", "/"))
      .filter((file) => !file.includes("/meta/") || file.endsWith("_journal.json"));
    expect(migrationFiles.length).toBeGreaterThan(0);
    for (const file of migrationFiles) {
      const contents = read(file);
      expect(contents, `${file} must not mention the new Tool contracts`).not.toMatch(
        /\b(?:AgentToolRegistry|ToolCallPreparer|CodingToolCatalog|agent_tools)\b/,
      );
    }

    const routeFiles = sourceFiles(join(root, "apps", "daemon", "src"))
      .map((path) => relative(root, path).replaceAll("\\", "/"))
      .filter((file) => /routes?\//.test(file));
    expect(routeFiles.length).toBeGreaterThan(0);
    for (const file of routeFiles) {
      const source = executable(file);
      expect(source, `${file} must not mention the new Tool contracts`).not.toMatch(
        /\b(?:AgentToolRegistry|ToolCallPreparer|CodingToolCatalog)\b/,
      );
    }
  });

  it("keeps the Phase 3 frozen Tool turn contract structurally unchanged", () => {
    const toolTurn = executable("packages/agent/src/run/ports/tool-turn.ts");
    const result = toolTurn.slice(
      toolTurn.indexOf("export interface AgentToolResult {"),
      toolTurn.indexOf("}", toolTurn.indexOf("export interface AgentToolResult {")),
    );
    expect(result.match(/readonly /g) ?? []).toHaveLength(4);
    expect(result).toContain("readonly externalCallId: string;");
    expect(result).toContain("readonly toolName: ToolName;");
    expect(result).toContain("readonly content: string;");
    expect(result).toContain("readonly isError: boolean;");
    expect(result).not.toContain("details");

    // The two frozen names are mapped, not merged: the Tool System's own declaration keeps its
    // fields inside `./tools/`, and the root entry publishes it under an explicit alias.
    const rootEntry = executable("packages/agent/src/index.ts");
    expect(rootEntry).toContain(
      'export type { AgentToolResult as AgentToolExecutionResult } from "./tools/types/tool-result.js";',
    );
    expect(rootEntry).toContain('} from "./run/ports/tool-turn.js";');
    const executionResult = executable("packages/agent/src/tools/types/tool-result.ts");
    const executionBody = executionResult.slice(
      executionResult.indexOf("export interface AgentToolResult<"),
      executionResult.lastIndexOf("}"),
    );
    expect(executionBody).toContain("readonly content: string;");
    expect(executionBody).toContain("readonly details: TDetails;");
    expect(executionBody).toContain("readonly isError: boolean;");
    expect(executionBody).not.toContain("externalCallId");

    // A prepared call carries the caller's identity unchanged; it never mints one.
    const preparer = executable(`${AGENT_TOOLS}call/tool-call-preparer-impl.ts`);
    expect(preparer).toContain("externalCallId: value.externalCallId,");
    expect(preparer).not.toMatch(/\bcreate(?:ToolInvocationId|ObservationId|EventId)\b/);
    expect(preparer).not.toMatch(/\brandomUUID\b|\bcrypto\b/);
    expect(preparer).not.toMatch(/\bexecute\s*\(/);
  });
});
