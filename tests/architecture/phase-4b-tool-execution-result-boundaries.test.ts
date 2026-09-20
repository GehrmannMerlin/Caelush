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
    // not the observation factory, not the event factory, not the SQLite execution store.
    for (const file of [
      `${LEGACY_TOOLS}invocation-lifecycle.ts`,
      `${LEGACY_TOOLS}observation.ts`,
      `${LEGACY_TOOLS}event-factory.ts`,
      `${LEGACY_TOOLS}tool-effects.ts`,
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
    const consumers = productionSources().filter((file) =>
      /\bToolExecutionUpdate\b/.test(executableSources().get(file) ?? ""),
    );
    for (const file of consumers) {
      expect(
        file.startsWith(EXECUTION) ||
          file.startsWith(`${AGENT_TOOLS}types/`) ||
          file === "packages/security/src/tool-update-sanitizer.ts" ||
          file.endsWith("/index.ts"),
        `${file} must not reach a transient update type`,
      ).toBe(true);
    }
    expect(consumers.length).toBeGreaterThan(0);
  });

  it("keeps the legacy shell delegating instead of executing", () => {
    const dispatcher = executable(DISPATCHER);

    // The canonical pair is required, not optional, and the shell holds no fallback.
    expect(dispatcher).toContain("readonly execution: {");
    expect(dispatcher).toContain(
      "readonly invocationExecutorFactory: ToolInvocationExecutorFactory;",
    );
    expect(dispatcher).toContain("readonly resultPipelineFactory: ToolResultPipelineFactory;");
    expect(dispatcher).toContain("readonly updateSanitizer: ToolExecutionUpdateSanitizerPort;");
    /**
     * Phase 4C moved the *consumer* of the pair to the canonical durable coordinator.
     *
     * ```text
     * before 4C   this shell bound the pair and called it, and ran the lifecycle around it
     * after 4C    the shell binds the pair and hands it to DurableToolExecutionCoordinator
     *             the shell itself holds a coordinator and delegates every durable step to it
     * ```
     *
     * The 4B guarantee is restated, not weakened: the execution authority is still
     * `@caelush/agent`'s and the shell still contains no execution algorithm of its own.
     */
    expect(dispatcher).toContain("readonly execution: {");
    expect(dispatcher).toContain("private readonly coordinator: DurableToolExecutionCoordinator;");
    expect(dispatcher).toContain("createDurableToolExecutionCoordinator({");

    // The execution algorithm, the update lifecycle, the sanitize/revalidate sequence and the generic
    // bounding are gone from the shell. The check is scoped to the execution method, because the
    // sanitizer *is* legitimately named once, as the result pipeline's configuration.
    expect(dispatcher).not.toMatch(/\bhandler\s*\.\s*execute\b/);
    expect(dispatcher).not.toContain("await executor.execute({");
    expect(dispatcher).not.toContain("acceptingUpdates");
    expect(dispatcher).not.toContain("updateSanitizer.sanitize");
    expect(dispatcher).not.toContain("ToolExecutionResultValidationError");
    expect(dispatcher).not.toContain("validateToolExecutionResult(");
    // It bounds *failure* content, which never reaches the canonical result pipeline.
    expect(dispatcher).not.toContain("boundToolResultContent(content, this.outputPolicy)");
    expect(dispatcher).toContain("boundToolModelContent");
    expect(dispatcher).not.toContain("outputValidator.validate");
    // The canonical pair is *bound* here and *called* by the coordinator, never by this shell.
    expect(dispatcher).toContain("const createInvocationExecutor:");
    expect(dispatcher).toContain("const createResultPipeline:");

    // The shell no longer owns the durable boundary either: it delegates the whole lifecycle, and the
    // only lifecycle-shaped code left is the retained Phase 4A argument-failure compatibility path.
    expect(dispatcher).not.toContain(
      "startToolInvocation(snapshot.invocation, this.options.clock.now())",
    );
    expect(dispatcher).not.toContain("completeToolInvocation(");
    // The only observation this facade builds is the argument-failure one, scoped to that method.
    expect((dispatcher.match(/createToolObservation\(/g) ?? []).length).toBe(1);
    expect(dispatcher).not.toContain("legacyEffectsFromSettlement");
    const argumentFailure = dispatcher.slice(
      dispatcher.indexOf("private async persistArgumentFailure("),
    );
    expect(argumentFailure).toContain("createRequestedToolInvocation({");
    expect(argumentFailure).toContain("failToolInvocation(");
    // The one durable row this facade still writes is the historical argument failure, and it is
    // scoped to that method: the file contains no other `failToolInvocation(` call site.
    expect((dispatcher.match(/failToolInvocation\(/g) ?? []).length).toBe(1);
  });

  it("keeps the legacy result modules delegating rather than reimplementing", () => {
    const legacyValidation = executable(`${LEGACY_TOOLS}result-validation.ts`);
    expect(legacyValidation).toContain("return validateToolResult({");
    expect(legacyValidation).not.toContain("Object.getPrototypeOf");
    expect(legacyValidation).not.toContain("canonicalJsonString");
    expect(legacyValidation).not.toContain("outputValidator.validate");

    const legacyPolicy = executable(`${LEGACY_TOOLS}output-policy.ts`);
    expect(legacyPolicy).toContain(
      "return boundToolResultContent(content, toCanonicalToolResultLimits(policy));",
    );
    expect(legacyPolicy).not.toContain("for (const character of content)");

    const legacySanitizerPort = executable(`${LEGACY_TOOLS}result-sanitizer.ts`);
    expect(legacySanitizerPort).toContain(
      'export type { ToolResultSanitizerPort } from "@caelush/agent";',
    );
    expect(legacySanitizerPort).not.toContain("interface ToolResultSanitizerPort");

    const legacyDisposition = executable(`${LEGACY_TOOLS}execution-disposition.ts`);
    expect(legacyDisposition).toContain(
      'export { UNCERTAIN_SIDE_EFFECT, ToolExecutionUncertainError } from "@caelush/agent";',
    );
    expect(legacyDisposition).not.toContain("class ToolExecutionUncertainError");
    expect(executable(`${LEGACY_TOOLS}errors.ts`)).not.toContain(
      "class ToolExecutionUncertainError",
    );
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

    const bridge = executable(`${LEGACY_TOOLS}settlement-extension-bridge.ts`);
    expect(bridge).toContain("CODING_TOOL_EFFECTS_EXTENSION_KIND");
    expect(bridge).toContain("effectProjector({");

    /**
     * Which production modules resolve that constant, after Phase 4C.
     *
     * ```text
     * settlement-extension-bridge.ts   produces the extension, and decodes it back into ToolEffect[]
     * storage/tool-settlement-extension-adapter.ts   names the kind the decoder accepts
     * ```
     *
     * The *shell* no longer decodes it: reading the Coding effects back out is the storage
     * compatibility boundary's job now, which is why `dispatcher.ts` is absent from this list and the
     * storage adapter is present. The Agent barrels re-export the declaration itself.
     */
    const kindReaders = productionSources()
      .filter((file) => !file.endsWith("/index.ts"))
      .filter(
        (file) =>
          executable(file).includes("CODING_TOOL_EFFECTS_EXTENSION_KIND") &&
          !file.startsWith(AGENT_TOOLS),
      );
    expect(kindReaders.sort()).toEqual([
      "packages/storage/src/tool-settlement-extension-adapter.ts",
      `${LEGACY_TOOLS}settlement-extension-bridge.ts`,
    ]);
    // The Agent result layer declares the generic constant and never compares it to anything.
    expect(executable(`${RESULT}result-policy.ts`)).toContain(
      'export const CODING_TOOL_EFFECTS_EXTENSION_KIND = "caelush.coding.effects.v1";',
    );
  });

  it("keeps the production composition bound to the canonical execution pair", () => {
    const security = executable("packages/security/src/default-composition.ts");
    expect(security).toContain("execution:");
    expect(security).toContain("createToolExecutionDependencies({");
    expect(security).toContain("resultSanitizer: security.resultSanitizer,");
    expect(security).toContain("updateSanitizer: options.updateSanitizer,");
    expect(security).toContain('"gate" | "execution" | "presentation"');

    /**
     * The binding itself is written once, in the legacy Tool System's execution factory: the pair, the
     * effect bridge and the effect-event projection all come from there, and the dispatcher holds no
     * result sanitizer of its own.
     */
    expect(executable(DISPATCHER)).toContain("const createInvocationExecutor: ");
    expect(executable(DISPATCHER)).toContain("const createResultPipeline: ");
    expect(executable(DISPATCHER)).toContain(
      "settlementExtension: createLegacyToolSettlementExtensionProjector({",
    );

    /**
     * And the security composition is the only production construction of a dispatcher.
     *
     * Phase 4C keeps that true and adds one more: the same composition is where the canonical durable
     * coordinator is handed to the facade, so the *lifecycle* authority is stated at the composition
     * root rather than inside the shell. The two assertions together are what make "the shell is a
     * facade" checkable.
     */
    const constructors = productionSources().filter((file) =>
      (executableSources().get(file) ?? "").includes("new ToolDispatcher("),
    );
    expect(constructors).toEqual(["packages/security/src/default-composition.ts"]);

    const coordinatorBuilders = productionSources().filter((file) =>
      (executableSources().get(file) ?? "").includes("createDurableToolExecutionCoordinator({"),
    );
    expect(coordinatorBuilders.sort()).toEqual([
      "apps/daemon/src/daemon-composition.ts",
      "packages/tools/src/dispatcher.ts",
    ]);
  });
});
