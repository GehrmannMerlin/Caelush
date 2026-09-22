import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 4B Tool execution and result boundary guards.
 *
 * ```text
 * one execution authority        @caelush/agent ToolInvocationExecutor calls the canonical AgentTool
 * one result authority           @caelush/agent ToolResultPipeline owns validate/sanitize/revalidate
 * one update path                sanitize -> ordered delivery, drop on failure, no raw fallback
 * no second implementation       the legacy shell delegates instead of owning an algorithm
 * no durable update              a transient update never reaches an observation or an event
 * no widened authority           admission, approval, budget, settlement and batch stay where they are
 * ```
 *
 * Phase 4B's success criterion is an **authority switch**, not a rewrite: the durable shell still
 * decides whether and when a Tool runs, and no longer decides how. These guards are structural, so a
 * later refactor cannot quietly put a `handler.execute()` call, a second schema check or a second
 * truncation back into the legacy dispatcher.
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

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8").replaceAll("\r\n", "\n");
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

/** The body of an interface declaration, matching braces so nested types do not truncate it. */
function interfaceBody(source: string, declaration: string): string {
  const start = source.indexOf(`${declaration} {`);
  if (start < 0) return "";
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

const AGENT_TOOLS = "packages/agent/src/tools/";
const EXECUTION = `${AGENT_TOOLS}execution/`;
const RESULT = `${AGENT_TOOLS}result/`;
const LEGACY_TOOLS = "packages/tools/src/";
const DISPATCHER = `${LEGACY_TOOLS}dispatcher.ts`;

/**
 * Every production file's executable code, read once.
 *
 * These guards scan the whole production tree, and reading and stripping each file once — rather than
 * once per assertion — is what keeps a whole-repository assertion inside the default test timeout.
 */
let executableCache: Map<string, string> | undefined;

function executableSources(): Map<string, string> {
  if (executableCache === undefined) {
    executableCache = new Map(productionSources().map((file) => [file, executable(file)] as const));
  }
  return executableCache;
}

describe("Phase 4B Agent Tool execution boundaries", () => {
  it("keeps the executor and result layers free of outer layers", () => {
    const forbidden = [
      "@caelush/tools",
      "@caelush/coding-agent",
      "@caelush/security",
      "@caelush/storage",
      "@caelush/runtime",
      "@caelush/core",
      "@caelush/context",
      "@caelush/verification",
      "@caelush/events",
      "@caelush/llm",
      "node:fs",
      "node:child_process",
    ];
    const violations: string[] = [];
    for (const file of [...filesUnder(EXECUTION), ...filesUnder(RESULT)]) {
      for (const specifier of importsFrom(executable(file))) {
        if (forbidden.includes(specifier)) violations.push(`${file} -> ${specifier}`);
        if (specifier.includes("apps/")) violations.push(`${file} -> ${specifier} (host)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the executor free of admission, durability and Run vocabulary", () => {
    const executor = executable(`${EXECUTION}invocation-executor.ts`);

    // The frozen public contract, exactly: call, identity, environment, signal.
    expect(executor).toContain("export interface ToolInvocationExecutor {");
    expect(executor).toContain("readonly call: PreparedToolCall;");
    expect(executor).toContain("readonly identity: ToolExecutionIdentity;");
    expect(executor).toContain("readonly environment: ToolExecutionEnvironment;");
    expect(executor).toContain("readonly signal: AbortSignal;");
    const contract = executor.slice(
      executor.indexOf("export interface ToolInvocationExecutor {"),
      executor.indexOf("}", executor.indexOf("export interface ToolInvocationExecutor {")),
    );
    expect(contract.match(/readonly /g) ?? []).toHaveLength(4);

    for (const forbidden of [
      "approval",
      "Approval",
      "budget",
      "Budget",
      "commit(",
      "Storage",
      "RunStatus",
      "RunController",
      "CompletionGate",
      "Verification",
      "batch",
      "Batch",
      "observation",
      "Observation",
      "ToolInvocationSchema",
      "createRequestedToolInvocation",
      "startToolInvocation",
    ]) {
      expect(executor, `the executor must not mention ${forbidden}`).not.toContain(forbidden);
    }
    // It executes the canonical AgentTool and nothing else.
    expect(executor).toContain("input.call.resolved.tool.execute({");
    expect(executor).not.toMatch(/\bhandler\s*\.\s*execute\b/);
  });

  it("keeps the result pipeline free of storage, events, models and Run state", () => {
    const pipeline = executable(`${RESULT}result-pipeline.ts`);
    const policy = executable(`${RESULT}result-policy.ts`);
    const validator = executable(`${RESULT}result-validator.ts`);

    for (const forbidden of [
      "Storage",
      "EventBus",
      "publish",
      "notify",
      "RunController",
      "RunStatus",
      "approval",
      "budget",
      "model",
      "Context",
    ]) {
      for (const [name, source] of [
        ["result-pipeline", pipeline],
        ["result-policy", policy],
        ["result-validator", validator],
      ] as const) {
        expect(source, `${name} must not mention ${forbidden}`).not.toContain(forbidden);
      }
    }
    expect(pipeline).toContain("export interface ToolResultPipeline {");
    expect(pipeline).toContain("readonly rawResult: AgentToolResult;");
    expect(pipeline).toContain("readonly now: TimestampMs;");
  });

  it("owns the frozen result contracts with one declaration each", () => {
    const policy = executable(`${RESULT}result-policy.ts`);
    const limits = interfaceBody(policy, "export interface ToolResultLimits");
    expect(limits).toContain("readonly maxDurableContentBytes: number;");
    expect(limits).toContain("readonly maxDetailsBytes: number;");
    expect(limits.match(/readonly /g) ?? []).toHaveLength(2);

    const extension = interfaceBody(policy, "export interface ToolSettlementExtension");
    expect(extension).toContain("readonly kind: string;");
    expect(extension).toContain("readonly payload: JsonObject;");
    /**
     * Phase 4C added the third and final field, an opaque durable-event channel.
     *
     * ```text
     * kind      what the host calls this extension
     * payload   the host's own data
     * events    host-domain durable events that settle with the invocation
     * ```
     *
     * The set stays closed at three, and the pass-through property 4B froze is unchanged: the Agent
     * layer carries `events` and never inspects a `type`, a `payload` or a `kind`. The assertion is
     * restated here rather than removed, so a fourth field has to be argued for explicitly.
     */
    const extensionFields = extension.match(/readonly \w+[?:]/g) ?? [];
    expect(extensionFields).toHaveLength(3);
    expect(extension).toContain("readonly events?: readonly DurableToolEventDraft[] | undefined;");

    const pipeline = executable(`${RESULT}result-pipeline.ts`);
    const settlement = interfaceBody(pipeline, "export interface PreparedToolSettlement");
    expect(settlement).toContain("readonly result: AgentToolResult;");
    expect(settlement).toContain("readonly effects?: ToolSettlementExtension | undefined;");

    // One declaration site each, barrel files aside.
    for (const [entry, pattern] of [
      ["ToolResultLimits", /\binterface ToolResultLimits\b/],
      ["ToolSettlementExtension", /\binterface ToolSettlementExtension\b/],
      ["PreparedToolSettlement", /\binterface PreparedToolSettlement\b/],
      ["ToolResultPipeline", /\binterface ToolResultPipeline\b/],
      ["ToolResultSanitizerPort", /\binterface ToolResultSanitizerPort\b/],
      ["ToolInvocationExecutor", /\binterface ToolInvocationExecutor\b/],
      ["ToolExecutionUpdateSanitizerPort", /\binterface ToolExecutionUpdateSanitizerPort\b/],
    ] as const) {
      const declarers = productionSources()
        .filter((file) => !file.endsWith("/index.ts"))
        .filter((file) => pattern.test(executableSources().get(file) ?? ""));
      expect(declarers, `${entry} must be declared once`).toHaveLength(1);
      expect(
        declarers[0]!.startsWith(AGENT_TOOLS),
        `${entry} belongs to the Agent Tool layer`,
      ).toBe(true);
    }
  });

  it("keeps one result validation and one bounding algorithm", () => {
    // The exact-shape reader, the details budget and the schema call live in one module.
    const shapeReaders = productionSources().filter((file) =>
      executable(file).includes("export function readResultShape("),
    );
    expect(shapeReaders).toEqual([`${RESULT}result-validator.ts`]);

    // The UTF-8 bound has exactly one implementation.
    const bounders = productionSources().filter((file) =>
      executable(file).includes("export function boundToolResultContent("),
    );
    expect(bounders).toEqual([`${RESULT}result-policy.ts`]);
    const boundBody = executable(`${RESULT}result-policy.ts`);
    expect(boundBody).toMatch(
      /Buffer\.byteLength\(\s*content,\s*"utf8",?\s*\)\s*<=\s*limits\.maxDurableContentBytes/,
    );
    // Whole characters only: the prefix is grown one code point at a time.
    expect(boundBody).toContain("for (const character of content) {");

    // No result module creates a schema compiler.
    for (const file of filesUnder(RESULT)) {
      const source = executable(file);
      expect(source, `${file} must not compile a schema`).not.toContain("new Ajv(");
      expect(source, `${file} must not recompile a schema`).not.toContain(".compile(");
      expect(source, `${file} must not import a schema runtime`).not.toContain("ToolSchemaRuntime");
    }
    // The pipeline validates with the registry's compiled validator.
    expect(boundBody.length).toBeGreaterThan(0);
    expect(executable(`${RESULT}result-validator.ts`)).toContain(
      "input.resolved.resultValidator.validate(shape.details)",
    );
  });

  it("keeps the transient update path safe and ordered", () => {
    const executor = executable(`${EXECUTION}invocation-executor.ts`);
    const port = executable(`${EXECUTION}update-sanitizer-port.ts`);

    // The port is the frozen three-field contract with a nullable result.
    expect(port).toContain("export interface ToolExecutionUpdateSanitizerPort {");
    expect(port).toContain("readonly toolName: ToolName;");
    expect(port).toContain("readonly invocation: ToolInvocation;");
    expect(port).toContain("readonly update: ToolExecutionUpdate;");
    expect(port).toContain("}): ToolExecutionUpdate | null;");

    // The lifecycle: accept, sanitize, drop on failure, deliver through one ordered chain.
    expect(executor).toContain("let acceptingUpdates = true;");
    expect(executor).toContain("if (!acceptingUpdates) {");
    expect(executor).toContain('dropped("SANITIZER_FAILED", error);');
    expect(executor).toContain('dropped("ORPHAN");');
    expect(executor).toContain("chain = chain");
    expect(executor).toContain("await chain;");
    // No fallback path: the raw update is never forwarded after a sanitizer problem.
    expect(executor).not.toContain(
      "transientUpdates.publish({\n              toolName: input.invocation.toolName,\n              invocation: input.invocation,\n              update,\n            })",
    );
  });

  it("keeps a transient update out of every durable path", () => {
    // No durable module consumes, produces or routes a transient update: not the invocation lifecycle,
    // not the observation factory, not the durable event factories, not the SQLite execution store.
    // Phase 4F removed the legacy modules that used to be named here, so the canonical ones are named.
    for (const file of [
      `${AGENT_TOOLS}durable/invocation-lifecycle.ts`,
      `${AGENT_TOOLS}durable/observation.ts`,
      `${AGENT_TOOLS}durable/durable-events.ts`,
      `packages/coding-agent/src/tools/effects/effect-projectors.ts`,
      `packages/storage/src/tool-execution-store.ts`,
    ]) {
      const source = executable(file);
      expect(source, `${file} must not consume a transient update`).not.toMatch(
        /\bToolExecutionUpdate\b/,
      );
      expect(source, `${file} must not import the update layer`).not.toContain("update-sanitizer");
    }

    // The update type is a Tool-execution concern: it is reachable from the Agent execution and type
    // layers, the coding-free Security sanitizer that implements the port, and type barrels. It is not
    // reachable from a durable store, a coordinator or a host route.
    //
    // Phase 4E added the one further legitimate consumer: a Coding builtin that *publishes* transient
    // output. `exec_command` and `write_stdin` project the Operations `onOutput` callback onto the
    // canonical update sink, which is exactly the integration Phase 4B's infrastructure was built for.
    // The allowlist is a directory, not a file: a Tool that publishes progress is a consumer by design.
    const consumers = productionSources().filter((file) =>
      /\bToolExecutionUpdate\b/.test(executableSources().get(file) ?? ""),
    );
    for (const file of consumers) {
      expect(
        file.startsWith(EXECUTION) ||
          file.startsWith(`${AGENT_TOOLS}types/`) ||
          file.startsWith("packages/coding-agent/src/tools/builtins/") ||
          file === "packages/security/src/tool-update-sanitizer.ts" ||
          file.endsWith("/index.ts"),
        `${file} must not reach a transient update type`,
      ).toBe(true);
    }
    expect(consumers.length).toBeGreaterThan(0);
  });

  it("keeps the retired shell out of the repository instead of merely delegating", () => {
    /**
     * Phase 4B's guarantee was "the execution authority is `@caelush/agent`'s, and the legacy shell
     * contains no execution algorithm of its own". Phase 4F satisfies it more strongly: the shell is
     * gone, so the only execution authority is the Agent package's.
     *
     * ```text
     * 4B   the shell binds the canonical pair and holds a coordinator
     * 4D   the canonical batch drives the coordinator directly; the shell has no production caller
     * 4F   the shell, its factories and its compatibility modules are deleted
     * ```
     */
    expect(existsSync(join(root, DISPATCHER))).toBe(false);

    // The one execution algorithm is the Agent package's, and nothing else constructs an executor.
    for (const file of productionSources()) {
      const source = executableSources().get(file) ?? "";
      expect(source, `${file} must not construct a second invocation executor`).not.toContain(
        "new ToolInvocationExecutor(",
      );
    }

    // The canonical executor is where the transient update lifecycle lives, once.
    const executor = executable(`${EXECUTION}invocation-executor.ts`);
    expect(executor).toContain("let acceptingUpdates = true;");
    expect(executor).toContain("export function createToolInvocationExecutor(");
    const lifecycleOwners = productionSources().filter((file) =>
      executable(file).includes("let acceptingUpdates = true;"),
    );
    expect(lifecycleOwners).toEqual([`${EXECUTION}invocation-executor.ts`]);
  });

  it("keeps the result modules canonical rather than delegating to a second copy", () => {
    // Phase 4B asserted that the legacy result modules *delegated* to the canonical ones. Phase 4F
    // removed them, so the statement is now the strong one: the canonical modules are the only ones,
    // and none of them restates an algorithm the other owns.
    expect(existsSync(join(root, "packages/tools"))).toBe(false);

    const validation = executable(`${RESULT}result-validator.ts`);
    expect(validation).toContain("export function validateToolResult(");
    expect(validation).toContain("ToolResultValidationError");

    const policy = executable(`${RESULT}result-policy.ts`);
    expect(policy).toContain("export function boundToolResultContent(");
    expect(policy).toContain("TOOL_RESULT_TRUNCATION_MARKER");
    // The whole-character prefix is the one UTF-8 boundary decision in the repository.
    const boundaryOwners = productionSources().filter((file) =>
      executable(file).includes("function wholeCharacterPrefix("),
    );
    expect(boundaryOwners).toEqual([`${RESULT}result-policy.ts`]);

    const sanitizerPort = executable(`${RESULT}result-sanitizer-port.ts`);
    expect(sanitizerPort).toContain("export interface ToolResultSanitizerPort");

    const disposition = executable(`${EXECUTION}execution-disposition.ts`);
    expect(disposition).toContain("export const UNCERTAIN_SIDE_EFFECT");
    expect(disposition).toContain("export class ToolExecutionUncertainError extends Error {");
    // One declaration of the uncertain-execution class, in the Agent package.
    const classOwners = productionSources().filter((file) =>
      executable(file).includes("class ToolExecutionUncertainError"),
    );
    expect(classOwners).toEqual([`${EXECUTION}execution-disposition.ts`]);
  });

  it("keeps the uncertainty vocabulary canonical and recognizable", () => {
    const disposition = executable(`${EXECUTION}execution-disposition.ts`);
    expect(disposition).toContain(
      'export const UNCERTAIN_SIDE_EFFECT = "UNCERTAIN_SIDE_EFFECT" as const;',
    );
    expect(disposition).toContain("export class ToolExecutionUncertainError extends Error {");
    expect(disposition).toContain(
      "readonly executionDisposition: UncertainSideEffect = UNCERTAIN_SIDE_EFFECT;",
    );
    expect(disposition).toContain("export function isToolExecutionUncertainError(");

    // Recognition is structural, never a message match.
    const executor = executable(`${EXECUTION}invocation-executor.ts`);
    expect(executor).toContain("if (error instanceof ToolExecutionUncertainError) return error;");
    expect(executor).toContain("if (isToolExecutionUncertainError(error)) {");
    expect(executor).not.toMatch(/String\(error\)/);
    expect(executor).not.toMatch(/\.message\.includes\(/);
  });

  it("adds no parallelism, no migration and no protocol change", () => {
    for (const file of [...filesUnder(EXECUTION), ...filesUnder(RESULT)]) {
      const source = executable(file);
      expect(source, `${file} must not introduce parallelism`).not.toMatch(
        /\bPromise\.all\b|\bPromise\.allSettled\b|\bnew Worker\b/,
      );
      expect(source, `${file} must not declare a coordinator`).not.toMatch(
        /\bclass (?:ToolAdmissionCoordinator|ToolSettlementCoordinator|DurableToolExecutionCoordinator|ToolBatchCoordinator)\b/,
      );
    }

    const migrationFiles = allFiles(join(root, "packages", "storage", "drizzle")).map((path) =>
      relative(root, path).replaceAll("\\", "/"),
    );
    expect(migrationFiles.length).toBeGreaterThan(0);
    for (const file of migrationFiles) {
      expect(read(file), `${file} must not mention Phase 4B`).not.toMatch(
        /\b(?:ToolResultPipeline|ToolInvocationExecutor|tool_execution_updates)\b/,
      );
    }
  });
  it("keeps Phases 3 and 4A structurally unchanged", () => {
    // Phase 3 Tool turn contract.
    const toolTurn = executable("packages/agent/src/run/ports/tool-turn.ts");
    const turnResult = toolTurn.slice(
      toolTurn.indexOf("export interface AgentToolResult {"),
      toolTurn.indexOf("}", toolTurn.indexOf("export interface AgentToolResult {")),
    );
    expect(turnResult.match(/readonly /g) ?? []).toHaveLength(4);
    expect(turnResult).not.toContain("details");
    expect(executable("packages/agent/src/index.ts")).toContain(
      'export type { AgentToolResult as AgentToolExecutionResult } from "./tools/types/tool-result.js";',
    );

    // Phase 4A contracts.
    const agentTool = executable(`${AGENT_TOOLS}types/agent-tool.ts`);
    expect(agentTool).toContain("extends AIToolSpec {");
    for (const forbidden of [
      "riskLevel",
      "requiredCapabilities",
      "effectProjector",
      "promptSnippet",
    ]) {
      expect(agentTool, `AgentTool must not declare ${forbidden}`).not.toContain(forbidden);
    }
    const registry = executable(`${AGENT_TOOLS}registry/registry.ts`);
    expect(registry).toContain("readonly tool: AgentTool;");
    expect(registry).toContain("readonly inputValidator: CompiledToolSchema;");
    expect(registry).toContain("readonly resultValidator: CompiledToolSchema;");
    const preparer = executable(`${AGENT_TOOLS}call/tool-call-preparer.ts`);
    expect(preparer).toContain("export type ToolCallPreparationOutcome =");
    expect(preparer).toContain('readonly kind: "READY";');
    expect(preparer).toContain('readonly kind: "REJECTED";');
  });

  it("keeps the Agent layer ignorant of Coding effect kinds", () => {
    /**
     * The Agent layer declares *its own* generic extension kind constant, because the frozen contract
     * names one; it never knows a Coding effect vocabulary, never switches on a kind, and never
     * imports a Coding effect type. The bridge that does understand the Coding kind lives in the
     * legacy composition, which is the layer that already owns `ToolEffect[]`.
     */
    for (const file of [
      ...filesUnder(EXECUTION),
      ...filesUnder(RESULT),
      `${AGENT_TOOLS}types/tool-result.ts`,
    ]) {
      const source = executable(file);
      expect(source, `${file} must not import a Coding effect type`).not.toContain("ToolEffect");
      // Discriminating on its *own* declared unions is fine; resolving a settlement extension's
      // opaque `kind` is not.
      expect(source, `${file} must not branch on an extension kind`).not.toMatch(
        /switch\s*\(\s*\w*[Ee]xtension\w*\.kind\s*\)/,
      );
      expect(source, `${file} must not compare an extension kind`).not.toMatch(
        /[Ee]xtension\.kind\s*===/,
      );
    }

    // The Coding layer's settlement extension is where the effect projector is read out of the
    // catalog. Phase 4F moved it there from the legacy package, so it is named here rather than in
    // `packages/tools`.
    const bridge = executable(
      "packages/coding-agent/src/tools/settlement/settlement-extension-projector.ts",
    );
    expect(bridge).toContain("CODING_TOOL_EFFECTS_PAYLOAD_KIND");
    expect(bridge).toContain("codingToolEffectsPayload(effects)");
    expect(bridge).toContain("catalog.get(call.resolved.tool.name)");

    /**
     * Which production modules resolve that constant, after Phase 4F.
     *
     * ```text
     * coding-agent/tools/settlement/settlement-extension.ts            produces and decodes the extension
     * storage/tool-settlement-extension-adapter.ts                     names the kind the decoder accepts
     * ```
     *
     * The Coding effect vocabulary lives in the Coding product layer, which is the only layer that may
     * interpret it. The Agent result layer merely *declares* the generic constant and never compares it,
     * and the storage adapter names it without decoding an effect itself.
     */
    const kindReaders = productionSources()
      .filter((file) => !file.endsWith("/index.ts"))
      .filter(
        (file) =>
          executable(file).includes("CODING_TOOL_EFFECTS_EXTENSION_KIND") &&
          !file.startsWith(AGENT_TOOLS),
      );
    expect(kindReaders.sort()).toEqual([
      "packages/coding-agent/src/tools/settlement/settlement-extension.ts",
      "packages/storage/src/tool-settlement-extension-adapter.ts",
    ]);
    // The Agent result layer declares the generic constant and never compares it to anything.
    expect(executable(`${RESULT}result-policy.ts`)).toContain(
      'export const CODING_TOOL_EFFECTS_EXTENSION_KIND = "caelush.coding.effects.v1";',
    );
  });

  it("keeps the production composition bound to the canonical execution pair", () => {
    // Phase 4F replaced the legacy `createToolExecutionDependencies` facade with the two canonical
    // factories, constructed where the layer that knows the host's policy composes them.
    const daemon = executable("apps/daemon/src/daemon-composition.ts");
    expect(daemon).toContain("createToolInvocationExecutor({");
    expect(daemon).toContain("createToolResultPipeline({");
    expect(daemon).toContain("sanitizer: toolSecurity.resultSanitizer,");
    expect(daemon).toContain("settlementExtension: createCodingToolSettlementExtensionProjector({");

    // The executor and the pipeline are declared exactly once, in the Agent package.
    for (const factory of [
      "export function createToolInvocationExecutor(",
      "export function createToolResultPipeline(",
    ]) {
      const declarers = productionSources().filter((file) => executable(file).includes(factory));
      expect(declarers, factory).toHaveLength(1);
      expect(declarers[0]!.startsWith(AGENT_TOOLS), factory).toBe(true);
    }

    /**
     * And exactly one production file builds the durable execution coordinator: the composition root
     * that owns the host's policy. Phase 4F removed the legacy facade that used to be the second one.
     */
    const coordinatorBuilders = productionSources().filter((file) =>
      (executableSources().get(file) ?? "").includes("createDurableToolExecutionCoordinator({"),
    );
    expect(coordinatorBuilders).toEqual(["apps/daemon/src/daemon-composition.ts"]);
  });
});
