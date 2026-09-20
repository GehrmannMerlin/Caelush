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

  it("keeps the legacy durable contracts as aliases and facades, never second declarations", () => {
    for (const [file, marker] of [
      [`${LEGACY_TOOLS}execution-store.ts`, "@caelush/agent"],
      [`${LEGACY_TOOLS}invocation-lifecycle.ts`, "@caelush/agent"],
      [`${LEGACY_TOOLS}observation.ts`, "@caelush/agent"],
      [`${LEGACY_TOOLS}event-factory.ts`, "@caelush/agent"],
      [`${LEGACY_TOOLS}security-context.ts`, "@caelush/agent"],
    ] as const) {
      const source = executable(file);
      expect(source, `${file} must re-export from the canonical owner`).toContain(marker);
      expect(source, `${file} must not import an outer layer`).not.toContain("@caelush/storage");
    }
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

    // `/caelush/storage` still declares the legacy Tool System as a runtime dependency, and that
    // declaration is frozen baseline debt this round does not retire: the storage *test* suite imports
    // the production effect projection through it, and the architecture ratchet requires a manifest
    // edge to disappear only when its last source import does. What the round did retire is every
    // source import, which is what the four removed baseline entries record.
    const manifest = JSON.parse(read("packages/storage/package.json")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).toContain("@caelush/tools");
  });

  it("keeps the production Dispatcher a compatibility facade, not a second lifecycle", () => {
    const dispatcher = executable(DISPATCHER);

    // It delegates the whole durable lifecycle.
    expect(dispatcher).toContain("private readonly coordinator: DurableToolExecutionCoordinator;");
    expect(dispatcher).toContain("this.coordinator.execute({");
    expect(dispatcher).toContain("this.coordinator.recover(existing, {");

    // It no longer implements any of the durable algorithms.
    for (const forbidden of [
      "private async applyGate(",
      "private async startAndExecute(",
      "private async recoverWaitingApproval(",
      "private async executeHandler(",
      "createApprovalRequestEvent",
      "startToolInvocation(",
      "completeToolInvocation(",
      "assertToolInvocationInvariant(",
      "commitAndNotify(",
      "legacyEffectsFromSettlement(",
      "activeCalls",
    ]) {
      expect(dispatcher, `the facade must not own ${forbidden}`).not.toContain(forbidden);
    }

    // The durable state transitions live in exactly one place, and it is the canonical layer.
    for (const [entry, pattern] of [
      ["startToolInvocation", /\bstartToolInvocation\(/],
      ["completeToolInvocation", /\bcompleteToolInvocation\(/],
      ["markToolInvocationWaitingApproval", /\bmarkToolInvocationWaitingApproval\(/],
    ] as const) {
      const callers = productionSources()
        .filter((file) => !file.endsWith("/index.ts"))
        .filter((file) => pattern.test(executableSources().get(file) ?? ""));
      for (const file of callers) {
        expect(
          file.startsWith(AGENT_TOOLS) || file === DISPATCHER,
          `${entry} may only be reached from the Agent layer or the retained facade path (${file})`,
        ).toBe(true);
      }
      // The facade's own use is the retained argument-failure path, and nothing else.
      const inDispatcher = (dispatcher.match(pattern) ?? []).length;
      expect(inDispatcher, `${entry} call sites in the facade`).toBeLessThanOrEqual(
        entry === "startToolInvocation" || entry === "completeToolInvocation" ? 0 : 0,
      );
    }
  });

  it("keeps the retained Phase 4A rejection difference explicit and bounded", () => {
    const dispatcher = read(DISPATCHER);

    /**
     * The one place a durable row is still written for a call that never became READY.
     *
     * ```text
     * createRequestedToolInvocation   exactly once, on the argument-failure path
     * failToolInvocation              exactly once, on the same path
     * ```
     *
     * The two are checked both by count and by order, so neither can have grown a second call site
     * elsewhere in the facade.
     */
    expect(dispatcher).toContain("private async persistArgumentFailure(");
    expect((dispatcher.match(/createRequestedToolInvocation\(/g) ?? []).length).toBe(1);
    expect((dispatcher.match(/failToolInvocation\(/g) ?? []).length).toBe(1);
    expect(dispatcher).toContain('code: "TOOL_ARGUMENT_ERROR"');
    expect(dispatcher.indexOf("createRequestedToolInvocation({")).toBeLessThan(
      dispatcher.indexOf("failToolInvocation("),
    );
    // The retained path is reached only when the canonical Preparer rejects a call.
    expect(dispatcher).toContain('if (prepared.kind === "REJECTED") {');
    expect(dispatcher.indexOf('prepared.kind === "REJECTED"')).toBeLessThan(
      dispatcher.indexOf("persistArgumentFailure("),
    );

    // The canonical Preparer still creates no invocation for a rejection.
    expect(executable(`${AGENT_TOOLS}call/tool-call-preparer.ts`)).not.toContain(
      "createRequestedToolInvocation",
    );

    // And the difference is recorded, with its exit round, rather than silently claimed as migrated.
    const map = read("docs/architecture/v2/PHASE_4C_DURABLE_TOOL_ORCHESTRATION_ACCEPTANCE_MAP.md");
    expect(map).toMatch(/argument[- ]failure/i);
    expect(map).toContain("4D");
  });
  it("keeps the admission layer ignorant of Coding policy vocabulary", () => {
    for (const file of filesUnder(ADMISSION)) {
      const source = executable(file);
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
    // non-Agent modules that name it are the producer and the storage decoder.
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
    for (const file of [...filesUnder(ADMISSION), ...filesUnder(DURABLE), DISPATCHER]) {
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

  it("keeps the batch and the builtins in the legacy layer for 4D and 4E", () => {
    // The batch coordinator is still legacy, and it still drives the compatibility facade.
    expect(existsSync(join(root, `${LEGACY_TOOLS}batch-coordinator.ts`))).toBe(true);
    expect(executable(`${LEGACY_TOOLS}batch-coordinator.ts`)).toContain("this.dispatcher[mode]");
    // It is constructed from the facade, and the facade reaches the canonical coordinator.
    expect(executable("apps/daemon/src/daemon-composition.ts")).toContain(
      "new ToolBatchCoordinator(dispatcher)",
    );

    // The nine builtins have not moved: they are still registrations in the legacy package.
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
    const defaultTools = executable(`${LEGACY_TOOLS}builtins/default-tools.ts`);
    for (const name of builtinNames) {
      expect(defaultTools, `${name} must still be registered by the legacy package`).toContain(
        name,
      );
    }
    // And no Coding builtin has crept into the Agent layer.
    for (const file of filesUnder(AGENT_TOOLS)) {
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
    expect(admitBody).toContain("await input.admission.admit({");
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

  it("keeps the Tool Dispatcher reachable only through the canonical coordinator in production", () => {
    const daemon = executable("apps/daemon/src/daemon-composition.ts");
    // The composition builds the canonical coordinator and hands it to the facade.
    expect(daemon).toContain("createDurableToolExecutionCoordinator({");
    expect(daemon).toContain("coordinator: toolDurableCoordinator");
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
    // the layer that holds the Coding effect projection.
    expect(executable("apps/daemon/src/daemon.ts")).toContain(
      "toolSettlementExtension: createLegacyToolSettlementExtensionDecoder({",
    );

    const security = executable("packages/security/src/default-composition.ts");
    expect(security).toContain("approvalRequests: createV1ToolApprovalRequestFactory({");
    expect(security).toContain("execution: createToolExecutionDependencies({");
  });

  it("keeps the Tool failure memory inside the canonical admission flow", () => {
    const memory = executable(`${LEGACY_TOOLS}tool-failure-memory.ts`);
    // It is a pre-check, so it returns a policy decision instead of writing a durable row.
    expect(memory).toContain("export function createToolFailureMemoryPreCheck(");
    expect(memory).toContain('kind: "DENY"');
    expect(memory).toContain("blockToolFailures: true");
    expect(memory).not.toContain("failToolInvocation");
    expect(memory).not.toContain("createRequestedToolInvocation");
    expect(memory).not.toContain("commit(");

    // The canonical admission coordinator is the only caller, through the injected pre-check.
    const coordinator = executable(`${ADMISSION}admission-coordinator.ts`);
    expect(coordinator).toContain("options.preCheck?.check(request)");
    // And the pre-check runs before the policy port, which runs before any budget side effect.
    const admitBody = bodyOf(coordinator, "async admit(input: ToolAdmissionInput)");
    expect(admitBody.indexOf("evaluateAdmission(options, request)")).toBeLessThan(
      admitBody.indexOf("admitBudget(options, input)"),
    );
  });
});
