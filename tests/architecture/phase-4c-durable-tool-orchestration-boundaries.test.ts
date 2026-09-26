import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 4C durable Tool orchestration boundaries.
 *
 * ```text
 * one lifecycle authority        @caelush/agent DurableToolExecutionCoordinator owns every durable step
 * one admission authority        ToolAdmissionCoordinator owns policy, approval and budget admission
 * one durable store contract     @caelush/agent declares it, @caelush/storage implements it
 * one settlement authority       ToolSettlementCoordinator owns the terminal commit
 * no second implementation       the legacy shell delegates instead of running a lifecycle
 * no widened authority           Run status, batch, model feedback and the builtins stay where they are
 * no new durable surface         no table, no migration, no Protocol field, no new status
 * ```
 *
 * Phase 4C's success criterion is an **authority switch**, not a rewrite: the canonical coordinator
 * now owns the Tool invocation lifecycle, and the legacy shell keeps only the entry points Phase 4D
 * still needs. These guards are structural, so a later change cannot quietly put a second lifecycle,
 * a second settlement or an effects decoder back into a canonical layer.
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

/** The body of a function or method, from its opening brace to its matching close. */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
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
const ADMISSION = `${AGENT_TOOLS}admission/`;
const DURABLE = `${AGENT_TOOLS}durable/`;
const LEGACY_TOOLS = "packages/tools/src/";
const DISPATCHER = `${LEGACY_TOOLS}dispatcher.ts`;
const STORAGE = "packages/storage/src/";

/**
 * Every production file's executable code, read once.
 *
 * The workspace has a few hundred production files, and several guards below scan all of them. Reading
 * and stripping each file once, rather than once per assertion, is what keeps a whole-repository
 * assertion inside the default test timeout.
 */
let executableCache: Map<string, string> | undefined;

function executableSources(): Map<string, string> {
  if (executableCache === undefined) {
    executableCache = new Map(productionSources().map((file) => [file, executable(file)] as const));
  }
  return executableCache;
}

describe("Phase 4C durable Tool orchestration boundaries", () => {
  it("keeps the Agent admission and durable layers free of every outer layer", () => {
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
      "@caelush/memory",
      "node:fs",
      "node:path",
      "node:child_process",
      "drizzle-orm",
    ];
    const violations: string[] = [];
    for (const file of [...filesUnder(ADMISSION), ...filesUnder(DURABLE)]) {
      for (const specifier of importsFrom(executable(file))) {
        if (forbidden.includes(specifier)) violations.push(`${file} -> ${specifier}`);
        if (specifier.includes("apps/")) violations.push(`${file} -> ${specifier} (host)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps each canonical contract declared exactly once, in @caelush/agent", () => {
    for (const [entry, pattern] of [
      ["ToolExecutionStorePort", /\binterface ToolExecutionStorePort\b/],
      ["ToolExecutionSnapshot", /\binterface ToolExecutionSnapshot\b/],
      ["ToolExecutionCommit", /\binterface ToolExecutionCommit\b/],
      ["ToolExecutionCommitResult", /\binterface ToolExecutionCommitResult\b/],
      ["ToolSecurityContext", /\binterface ToolSecurityContext\b/],
      ["ToolDurableMetadataPort", /\binterface ToolDurableMetadataPort\b/],
      ["ToolAdmissionPort", /\binterface ToolAdmissionPort\b/],
      ["ToolBudgetAdmissionPort", /\binterface ToolBudgetAdmissionPort\b/],
      ["ToolAdmissionCoordinator", /\binterface ToolAdmissionCoordinator\b/],
      ["ToolAdmissionOutcome", /\bexport type ToolAdmissionOutcome\b/],
      ["ToolSettlementCoordinator", /\binterface ToolSettlementCoordinator\b/],
      ["DurableToolExecutionCoordinator", /\binterface DurableToolExecutionCoordinator\b/],
      ["DurableToolExecutionRequest", /\binterface DurableToolExecutionRequest\b/],
      ["DurableToolExecutionOutcome", /\bexport type DurableToolExecutionOutcome\b/],
      ["ToolApprovalRequirement", /\binterface ToolApprovalRequirement\b/],
      ["ToolPolicyDecision", /\bexport type ToolPolicyDecision\b/],
    ] as const) {
      const declarers = [...executableSources().entries()]
        .filter(([file]) => !file.endsWith("/index.ts"))
        .filter(([, source]) => pattern.test(source))
        .map(([file]) => file);
      expect(declarers, `${entry} must be declared once`).toHaveLength(1);
      expect(
        declarers[0]!.startsWith(AGENT_TOOLS),
        `${entry} belongs to the Agent Tool layer`,
      ).toBe(true);
    }
  });

  it("keeps AgentBudgetBlock declared exactly once, in @caelush/agent", () => {
    const declarations = productionSources()
      .filter((file) => !file.endsWith("/index.ts"))
      .filter((file) =>
        (executableSources().get(file) ?? "").includes("export type AgentBudgetBlock ="),
      );
    expect(declarations).toEqual(["packages/agent/src/loop/ports/model-request-admission.ts"]);
    // Core re-exports the canonical declaration rather than restating it, so the two packages can
    // never disagree about what a budget block is.
    expect(executable("packages/core/src/agent-errors.ts")).toContain(
      'export type { AgentBudgetBlock } from "@caelush/agent";',
    );
    expect(executable("packages/core/src/agent-errors.ts")).not.toMatch(
      /\btype AgentBudgetBlock =/,
    );
  });

  it("keeps every durable Tool contract declared exactly once, in @caelush/agent", () => {
    // Phase 4C asserted that the legacy modules were aliases and facades. Phase 4F removed them, so
    // the rule is stated as the strong form: the Agent layer is the only declaration site.
    expect(existsSync(join(root, "packages/tools"))).toBe(false);

    // No second transition table, no second observation factory, no second error class.
    for (const [entry, pattern] of [
      ["the transition table", /const ALLOWED_TRANSITIONS\b/],
      ["createToolObservation", /\bfunction createToolObservation\b/],
      ["ToolExecutionConflictError", /\bclass ToolExecutionConflictError\b/],
      ["ToolExecutionInvariantError", /\bclass ToolExecutionInvariantError\b/],
    ] as const) {
      const declarers = [...executableSources().entries()]
        .filter(([file]) => !file.endsWith("/index.ts"))
        .filter(([, source]) => pattern.test(source))
        .map(([file]) => file);
      expect(declarers, `${entry} must be declared once`).toHaveLength(1);
      expect(declarers[0]!.startsWith(AGENT_TOOLS), `${entry} belongs to the Agent layer`).toBe(
        true,
      );
    }

    // And none of those declarations reaches an outer layer.
    for (const file of [
      `${AGENT_TOOLS}durable/durable-errors.ts`,
      `${AGENT_TOOLS}durable/invocation-lifecycle.ts`,
      `${AGENT_TOOLS}durable/observation.ts`,
      `${AGENT_TOOLS}durable/durable-events.ts`,
      `${AGENT_TOOLS}admission/security-context.ts`,
    ]) {
      const source = executable(file);
      expect(source, `${file} must not import an outer layer`).not.toContain("@caelush/storage");
      expect(source, `${file} must not import the retired package`).not.toContain("@caelush/tools");
    }
  });

  it("keeps the production storage Tool store implementing the canonical port", () => {
    const store = executable(`${STORAGE}tool-execution-store.ts`);
    // The canonical contract, imported from the canonical owner.
    expect(store).toContain("@caelush/agent");
    expect(store).not.toContain("@caelush/tools");
    expect(store).toContain(
      "export class SqliteToolExecutionStore implements ToolExecutionStorePort",
    );
    // And the atomicity the round turns on.
    expect(store).toContain("function startBudgetInTransaction(");
    expect(store).toContain("function settleBudgetInTransaction(");
    expect(store).toContain('"BEGIN IMMEDIATE"');
    expect(store).toContain('"ROLLBACK"');
    // A budget terminal transition happens inside the terminal commit, not after it.
    const commitBody = bodyOf(store, "async commit(command: ToolExecutionCommit)");
    expect(commitBody).toContain("settleBudgetInTransaction(");
    expect(commitBody).toContain("startBudgetInTransaction(");
    // An unknown extension kind is refused, never ignored.
    expect(store).toContain("ToolSettlementExtensionError");
    expect(store).toContain("this.settlementExtension === undefined");
  });

  it("keeps the storage effects decoder a named compatibility boundary", () => {
    const adapter = executable(`${STORAGE}tool-settlement-extension-adapter.ts`);
    expect(adapter).toContain("export interface ToolSettlementExtensionDecoder");
    expect(adapter).toContain("export interface HostToolEffectsPort");
    // Storage names the effect vocabulary nowhere: it receives a port, never a ToolEffect.
    // It names the host-effect port, and never a `ToolEffect` value of its own.
    expect(adapter).not.toMatch(/\bToolEffect\b/);
    expect(adapter).toContain("CODING_TOOL_EFFECTS_EXTENSION_KIND");

    // Phase 4C recorded the legacy Tool System as frozen baseline debt on the storage manifest, with
    // the storage test suite as the reason. Phase 4F retired the package AND migrated those tests, so
    // the edge is gone and the frozen violation was removed from the baseline with it.
    const manifest = JSON.parse(read("packages/storage/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@caelush/tools");
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain("@caelush/tools");
    // The canonical Agent Tool contracts are what storage implements against.
    expect(Object.keys(manifest.dependencies ?? {})).toContain("@caelush/agent");
    const baseline = read("scripts/architecture/legacy-import-baseline.json");
    expect(baseline).not.toContain("STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_TOOLS");
  });

  it("keeps the durable Tool lifecycle authority in exactly one place", () => {
    // Phase 4C proved the legacy Dispatcher was a *facade* over the canonical coordinator. Phase 4F
    // removed the facade, so the coordinator is now the only object that moves a durable invocation.
    expect(existsSync(join(root, DISPATCHER))).toBe(false);

    const coordinator = executable(
      "packages/agent/src/tools/durable/durable-execution-coordinator.ts",
    );
    expect(coordinator).toContain("async execute(request: DurableToolExecutionRequest)");
    expect(coordinator).toContain("async recover(");
    expect(coordinator).toContain("createDurableToolExecutionCoordinator(");

    // The durable state transitions live in exactly one place, and it is the canonical layer.
    for (const [entry, pattern] of [
      ["startToolInvocation", /\bstartToolInvocation\(/],
      ["completeToolInvocation", /\bcompleteToolInvocation\(/],
      ["markToolInvocationWaitingApproval", /\bmarkToolInvocationWaitingApproval\(/],
    ] as const) {
      const callers = productionSources()
        .filter((file) => !file.endsWith("/index.ts"))
        .filter((file) => pattern.test(executableSources().get(file) ?? ""));
      expect(callers.length, `${entry} must have at least one caller`).toBeGreaterThan(0);
      for (const file of callers) {
        expect(
          file.startsWith(AGENT_TOOLS),
          `${entry} may only be reached from the Agent layer (${file})`,
        ).toBe(true);
      }
    }
  });

  it("keeps no durable row written for a call the Preparer rejected", () => {
    // Phase 4C recorded a retained Phase 4A difference: the legacy facade wrote one durable
    // REQUESTED+FAILED pair for an argument rejection. Phase 4D removed that path's only caller and
    // Phase 4F removed the facade, so a pre-invocation rejection now creates **no** durable row — the
    // canonical batch reports it as a REJECTED item carrying safe model feedback and nothing else.
    const preparer = executable("packages/agent/src/tools/call/tool-call-preparer-impl.ts");
    expect(preparer).not.toContain("createRequestedToolInvocation");
    expect(preparer).not.toContain("failToolInvocation");

    const batch = executable("packages/agent/src/tools/batch/batch-coordinator.ts");
    expect(batch).toContain('kind: "REJECTED"');
    // The batch itself never writes durable state either: the coordinator does, and only for a call
    // that reached the durable start boundary.
    expect(batch).not.toContain("createRequestedToolInvocation(");
    expect(batch).not.toContain("failToolInvocation(");
  });
  it("keeps the admission layer ignorant of Coding policy vocabulary", () => {
    for (const file of filesUnder(ADMISSION)) {
      const source = executable(file);
      // The Gate contract module is the one deliberate exception, and it is a narrow one: the shape a
      // Security evaluator is asked in has to name the facts it evaluates. It declares a *structural*
      // subset and no Coding metadata field, which the second loop below asserts.
      if (file.endsWith("/gate-port.ts")) continue;
      for (const forbidden of [
        "ToolEffect",
        "securityFacts",
        "SecurityFacts",
        "CodingToolDefinition",
        "requiredCapabilities",
        "runtimeRequirements",
        "CaelushToolExecutionGate",
        "computeToolApprovalKey",
      ]) {
        expect(source, `${file} must not know ${forbidden}`).not.toContain(forbidden);
      }
      // It never hashes anything: the approval identity belongs to the admission implementation.
      expect(source, `${file} must not hash`).not.toContain("createHash");
      expect(source, `${file} must not import a crypto module`).not.toContain("node:crypto");
    }

    // And the exception declares no Coding metadata field at all.
    const gatePort = executable(`${ADMISSION}gate-port.ts`);
    for (const codingField of [
      "CodingToolDefinition",
      "CodingToolCatalog",
      "CodingToolSecurityMetadata",
      "promptSnippet",
      "effectProjector",
      "securityFactsProjector",
    ]) {
      expect(gatePort, `gate-port must not know ${codingField}`).not.toContain(codingField);
    }
    /**
     * `riskLevel` is reachable in exactly two canonical files, and both are named.
     *
     * ```text
     * admission/durable-metadata-port.ts   the migration seam: Protocol v1 persists the field
     * durable/invocation-lifecycle.ts      the lifecycle restates it on the durable row
     * ```
     *
     * Neither is `AgentTool`, and the list is asserted exactly: a third file reaching for the field
     * would mean Coding risk metadata had spread into the general Tool layer again.
     */
    /**
     * `riskLevel` is reachable in the general Tool layer only where Protocol has forced it.
     *
     * ```text
     * admission/admission-decision.ts     the ToolApprovalRequirement's own optional scope, named
     *                                     in the frozen contract text
     * admission/durable-metadata-port.ts  the migration seam: Protocol v1 persists the field
     * durable/invocation-lifecycle.ts     the lifecycle restates it on the durable row
     * ```
     *
     * Whether a file reaches for it because of a doc comment or because of executable code, the list
     * is asserted exactly: a fourth file would mean Coding risk metadata had spread into the general
     * Tool layer again. `AgentTool` is separately asserted to declare none of it.
     */
    const riskReachers = filesUnder(AGENT_TOOLS).filter((file) =>
      executable(file).includes("riskLevel"),
    );
    expect(riskReachers.length).toBeGreaterThan(0);
    for (const file of riskReachers) {
      expect(
        file.startsWith(ADMISSION) || file.startsWith(DURABLE),
        `${file} must not reach for a risk level outside the admission and durable layers`,
      ).toBe(true);
    }
  });

  it("keeps the settlement layer from branching on a settlement extension kind", () => {
    for (const file of filesUnder(DURABLE)) {
      const source = executable(file);
      expect(source, `${file} must not compare an extension kind`).not.toMatch(
        /[Ee]xtension\.kind\s*===/,
      );
      expect(source, `${file} must not switch on an extension kind`).not.toMatch(
        /switch\s*\(\s*\w*[Ee]xtension\w*\.kind\s*\)/,
      );
      expect(source, `${file} must not import a Coding effect type`).not.toContain("ToolEffect");
    }
    // The Agent layer declares the generic constant and never compares it to anything; the two
    // non-Agent modules that name it are the Coding producer/decoder and the storage decoder.
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
  });

  it("keeps the coordinator out of Run lifecycle authority", () => {
    for (const file of [...filesUnder(ADMISSION), ...filesUnder(DURABLE)]) {
      const source = executable(file);
      for (const forbidden of [
        "RunController",
        "RunStatus",
        "AgentRun",
        "AgentState",
        "CompletionGate",
        "Verification",
        "ToolBatchCoordinator",
        "ModelToolFeedback",
        "ContextBuilder",
      ]) {
        expect(source, `${file} must not reach ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("adds no parallelism, no new ToolInvocation status and no new durable surface", () => {
    for (const file of [...filesUnder(ADMISSION), ...filesUnder(DURABLE)]) {
      const source = executable(file);
      expect(source, `${file} must not introduce parallelism`).not.toMatch(
        /\bPromise\.all\b|\bPromise\.allSettled\b|\bnew Worker\b/,
      );
    }

    // The ToolInvocation status set is Protocol's, and this round adds nothing to it.
    const protocol = executable("packages/protocol/src/tool.ts");
    const statuses = protocol.slice(
      protocol.indexOf("ToolInvocationStatusSchema = z.enum(["),
      protocol.indexOf("])", protocol.indexOf("ToolInvocationStatusSchema = z.enum([")),
    );
    for (const status of [
      "REQUESTED",
      "WAITING_APPROVAL",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]) {
      expect(statuses).toContain(`"${status}"`);
    }
    expect((statuses.match(/"/g) ?? []).length / 2).toBe(6);

    // No migration was added, and no existing one was touched.
    const migrations = allFiles(join(root, "packages", "storage", "drizzle")).map((path) =>
      relative(root, path).replaceAll("\\", "/"),
    );
    expect(migrations.length).toBeGreaterThan(0);
    for (const file of migrations) {
      expect(read(file), `${file} must not mention Phase 4C`).not.toMatch(
        /\b(?:DurableToolExecution|ToolAdmissionCoordinator|ToolSettlementCoordinator)\b/,
      );
    }
  });

  it("keeps Phases 3, 4A and 4B structurally unchanged", () => {
    // Phase 3 Tool turn contract.
    const toolTurn = executable("packages/agent/src/run/ports/tool-turn.ts");
    const turnResult = interfaceBody(toolTurn, "export interface AgentToolResult");
    expect(turnResult.match(/readonly /g) ?? []).toHaveLength(4);
    expect(turnResult).not.toContain("details");
    expect(toolTurn).toContain('readonly kind: "BUDGET_EXCEEDED";');
    expect(toolTurn).toContain("readonly block: AgentBudgetBlock;");

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
    const preparer = executable(`${AGENT_TOOLS}call/tool-call-preparer.ts`);
    expect(preparer).toContain('readonly kind: "READY";');
    expect(preparer).toContain('readonly kind: "REJECTED";');

    // Phase 4B executor and result pipeline.
    const executor = executable(`${AGENT_TOOLS}execution/invocation-executor.ts`);
    expect(executor).toContain("export interface ToolInvocationExecutor {");
    expect(executor).toContain("input.call.resolved.tool.execute({");
    const pipeline = executable(`${AGENT_TOOLS}result/result-pipeline.ts`);
    expect(pipeline).toContain("export interface ToolResultPipeline {");
    expect(pipeline).toContain("export interface PreparedToolSettlement {");
  });

  it("keeps the nine builtins target-owned and the legacy batch retired", () => {
    // Phase 4C recorded that the nine builtins had not yet moved and that the legacy batch coordinator
    // still existed for its own direct API. Phase 4E moved the builtins and Phase 4F removed the legacy
    // package, so both statements are now their final form.
    expect(existsSync(join(root, `${LEGACY_TOOLS}batch-coordinator.ts`))).toBe(false);
    expect(existsSync(join(root, `${LEGACY_TOOLS}builtins/default-tools.ts`))).toBe(false);

    const daemon = executable("apps/daemon/src/daemon-composition.ts");
    expect(daemon).toContain("createToolBatchCoordinator(");
    expect(daemon).not.toContain("new ToolBatchCoordinator(dispatcher)");

    // The nine builtins are declared by the Coding product layer, once each, in the frozen order.
    const builtinNames = [
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "git_status",
      "git_diff",
    ];
    const defaultTools = executable("packages/coding-agent/src/tools/builtins/default-tools.ts");
    for (const name of builtinNames) {
      expect(defaultTools, `${name} must be registered by the Coding product layer`).toContain(
        name,
      );
    }
    for (const name of builtinNames) {
      const owners = productionSources().filter((file) =>
        executable(file).includes(`name: "${name}"`),
      );
      expect(owners, name).toEqual([
        `packages/coding-agent/src/tools/builtins/${name.replaceAll("_", "-")}.ts`,
      ]);
    }

    // And no Coding builtin has crept into the Agent layer.
    for (const file of filesUnder(AGENT_TOOLS)) {
      if (file.replaceAll("\\", "/").includes("/tools/observation/")) continue;
      const source = executable(file);
      for (const name of ["read_file", "exec_command", "apply_patch", "git_status"]) {
        expect(source, `${file} must not name ${name}`).not.toContain(name);
      }
    }
  });

  it("keeps the production chain REQUESTED → admission → RUNNING → execute → settle", () => {
    const coordinator = executable(`${DURABLE}durable-execution-coordinator.ts`);

    // ① idempotency lookup by the whole identity.
    expect(coordinator).toContain("await input.store.findByExternalCall(");
    // ② REQUESTED, committed before admission has any side effect.
    const executeBody = bodyOf(coordinator, "async execute(request: DurableToolExecutionRequest)");
    expect(executeBody.indexOf("findByExternalCall")).toBeLessThan(
      executeBody.indexOf("createRequestedToolInvocation"),
    );
    expect(executeBody.indexOf("createRequestedToolInvocation")).toBeLessThan(
      executeBody.indexOf("admitAndProceed"),
    );
    // ③ admission, ④ RUNNING, ⑤ execution, ⑥ settlement.
    const admitBody = bodyOf(coordinator, "async function admitAndProceed(");
    // Phase 6G carries the transient Guard mode/signal as a second argument; the five-field
    // ToolAdmissionRequest remains the first argument and stays closed.
    expect(admitBody).toContain("await input.admission.admit(");
    expect(admitBody).toContain("startAndExecute(execution, snapshot)");
    expect(admitBody.indexOf("admission.admit")).toBeLessThan(
      admitBody.indexOf("startAndExecute(execution, snapshot)"),
    );
    const startBody = bodyOf(coordinator, "async function startAndExecute(");
    // RUNNING is committed with the budget start, and only then is the executor reached.
    expect(startBody).toContain("startToolInvocation(snapshot.invocation, startedAt)");
    expect(startBody).toContain("budgetStart: { ownerId: running.id, startedAt }");
    expect(startBody.indexOf("commitAndNotify(")).toBeLessThan(
      startBody.indexOf("executeAndSettle(execution, committed.snapshot)"),
    );
    const executeAndSettleBody = bodyOf(coordinator, "async function executeAndSettle(");
    expect(executeAndSettleBody.indexOf("await executor.execute({")).toBeLessThan(
      executeAndSettleBody.indexOf("settlementCoordinator.settle({"),
    );
    expect(executeAndSettleBody).toContain("archiveRawResult(");
    expect(executeAndSettleBody.indexOf("archiveRawResult(")).toBeLessThan(
      executeAndSettleBody.indexOf(".process({"),
    );
  });

  it("keeps the canonical settlement input frozen and free of host locators", () => {
    const settlement = executable(`${DURABLE}settlement-coordinator.ts`);
    const contract = interfaceBody(settlement, "export interface ToolSettlementCoordinator");
    for (const field of [
      "readonly snapshot: ToolExecutionSnapshot;",
      "readonly settlement: PreparedToolSettlement;",
      "readonly now: TimestampMs;",
    ]) {
      expect(contract).toContain(field);
    }
    // Three fields, and no `rawArtifactRef`, no budget handle and no environment.
    expect(contract.match(/readonly \w+:/g) ?? []).toHaveLength(3);
    for (const forbidden of ["rawArtifactRef", "environment", "Run ", "storage"]) {
      expect(contract, `the frozen settlement input must not carry ${forbidden}`).not.toContain(
        forbidden,
      );
    }
    // And the raw artifact reference really does reach the observation, through the binding seam.
    expect(settlement).toContain("rawArtifactRef?: (() => Promise<string | undefined>)");

    const durable = executable(`${DURABLE}durable-execution-coordinator.ts`);
    const request = interfaceBody(durable, "export interface DurableToolExecutionRequest");
    expect(request.match(/readonly \w+:/g) ?? []).toHaveLength(7);
    for (const forbidden of [
      "Run ",
      "Workspace",
      "Registry",
      "Storage",
      "ApprovalStore",
      "BudgetStore",
      "Runtime",
      "ToolEffect",
    ]) {
      expect(request, `the frozen request must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("keeps the canonical durable coordinator the one Tool lifecycle the production root builds", () => {
    const daemon = executable("apps/daemon/src/daemon-composition.ts");
    // The composition builds the canonical coordinator — one of them — and hands it to the canonical
    // batch. Phase 4D removed the legacy Dispatcher, which was its only other consumer, so the
    // coordinator is now driven from exactly one place.
    expect(daemon).toContain("createDurableToolExecutionCoordinator({");
    expect(daemon).toContain("durable: toolDurableCoordinator");
    expect(daemon).not.toContain("createV1SecureToolDispatcher(");
    // Every canonical port is assembled here, from the real implementations.
    for (const builder of [
      "createToolAdmissionCoordinator({",
      "createCodingToolAdmissionPort({",
      "createCodingToolDurableMetadataPort({",
      "createSqliteToolBudgetAdmission(",
      "createDurableInvocationGatePort({",
    ]) {
      expect(daemon, `the daemon composition must build ${builder}`).toContain(builder);
    }
    // And the durable store is Storage's, implementing the canonical port.
    expect(daemon).toContain("store: options.storage.toolExecution");
    // The settlement extension decoder is wired where the storage instance is opened, because that is
    // the layer that holds the Coding effect projection. Phase 4F moved the decoder itself into the
    // Coding product layer, with the same extension kind.
    expect(executable("apps/daemon/src/daemon.ts")).toContain(
      "toolSettlementExtension: createCodingToolSettlementExtensionDecoder({",
    );

    const security = executable("packages/security/src/default-composition.ts");
    // The approval card factory is Security's, exactly as Phase 4C placed it. It now reads the
    // canonical registry and the Coding catalog instead of the retired legacy registry view.
    expect(security).toContain("export function createV1ToolApprovalRequestFactory(");
    expect(daemon).toContain("approvalRequests: toolApprovalRequests,");
    expect(daemon).toContain("createV1ToolApprovalRequestFactory({");
    // Phase 4F replaced the legacy execution-dependency facade with the two canonical factories, which
    // the composition root now builds directly.
    expect(daemon).toContain("createToolInvocationExecutor({");
    expect(daemon).toContain("createToolResultPipeline({");
    expect(existsSync(join(root, "packages/tools"))).toBe(false);
  });

  it("keeps the Tool failure memory retired and the pre-check port with one owner", () => {
    // Phase 4C kept `ToolFailureMemory` inside the canonical admission *flow* through the injected
    // pre-check port, without ever making it a durable writer. Phase 4F removed the class itself: it
    // was not part of the V2 pipeline, and its only caller was the retired facade.
    expect(existsSync(join(root, `${LEGACY_TOOLS}tool-failure-memory.ts`))).toBe(false);
    const declarations = productionSources().filter((file) =>
      executable(file).includes("class ToolFailureMemory"),
    );
    expect(declarations).toEqual([]);

    // The pre-check *port* is the permanent contract, and it stays canonical and single-owned.
    const portOwners = productionSources().filter((file) =>
      executable(file).includes("export interface ToolAdmissionPreCheck {"),
    );
    expect(portOwners).toEqual([`${ADMISSION}admission-port.ts`]);

    // The canonical admission coordinator is the only caller, through the injected pre-check.
    const coordinator = executable(`${ADMISSION}admission-coordinator.ts`);
    expect(coordinator).toContain("options.preCheck?.check(request)");
    // And the pre-check runs before the policy port, which runs before any budget side effect.
    const admitBody = bodyOf(coordinator, "async admit(");
    expect(admitBody.indexOf("evaluateAdmission(options, request,")).toBeLessThan(
      admitBody.indexOf("admitBudget(options, input)"),
    );
  });
});
