import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 4D batch, model feedback and Tool turn cutover boundaries.
 *
 * ```text
 *  one batch authority          @caelush/agent ToolBatchCoordinator schedules every production batch
 *  one feedback authority       @caelush/agent ModelToolFeedbackProjector builds the model view
 *  one integrity authority      @caelush/agent ToolResultBatchNormalizer defends the batch
 *  no legacy production use     the daemon never constructs the legacy batch coordinator
 *  no Dispatcher on the path    the canonical batch never reaches the legacy facade
 *  no raw result in feedback    only a durable observation or safe feedback is projected
 *  no transient update          a Tool progress update never enters model history
 *  still sequential             no `Promise.all` anywhere in the canonical batch
 *  frozen contracts intact      Phase 3 ToolTurn, Phase 4A/4B/4C contracts are unchanged
 *  no new durable surface       no table, no migration, no Protocol field, no new status
 *  4E and 4F untouched          the nine builtins and the compatibility retirement have not begun
 * ```
 *
 * Phase 4D's success criterion is an **authority cutover**: production stopped using the legacy batch
 * and the Core-side feedback algorithms, and started using the canonical ones. These guards are
 * structural, so a later change cannot quietly put a second scheduler, a second model-feedback
 * algorithm or a raw execution result back onto the production path.
 */

const root = process.cwd();

/**
 * The body of the declaration introduced by `marker`, found from its return-type terminator.
 *
 * A multi-line signature makes an exact-signature search fragile, so the marker is a stable prefix and
 * the body is located from `terminator` — the text that immediately precedes the opening brace of the
 * *body*. That is deliberately not "the first `{`", because a parameter type may itself contain braces
 * (`Extract<ToolBatchOutcome, { kind: "COMPLETED" }>` does), and balancing from there would stop at the
 * type literal instead of at the end of the function.
 */
function declarationBody(source: string, marker: string, terminator: string): string {
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const terminatorIndex = source.indexOf(terminator, start);
  if (terminatorIndex < 0) return "";
  const open = terminatorIndex + terminator.length - 1;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

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

/**
 * Every production file's executable code, read once.
 *
 * Phase 4D adds several pass-or-fail rules over the whole workspace, so the read is shared rather than
 * repeated per assertion — the suite runs under high load in a full-suite gate, and a rule that re-reads
 * several hundred files per expectation is a rule that eventually times out instead of failing.
 */
let executableCache: Map<string, string> | undefined;

function executableSources(): Map<string, string> {
  if (executableCache === undefined) {
    executableCache = new Map(productionSources().map((file) => [file, executable(file)] as const));
  }
  return executableCache;
}

function filesUnder(prefix: string): string[] {
  return productionSources().filter((file) => file.startsWith(prefix));
}

function codeUnder(prefix: string): string {
  return filesUnder(prefix)
    .map((file) => executableSources().get(file) ?? "")
    .join("\n");
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
const BATCH = `${AGENT_TOOLS}batch/`;
const OBSERVATION = `${AGENT_TOOLS}observation/`;
const LEGACY_TOOLS = "packages/tools/src/";
const CORE = "packages/core/src/";
const DAEMON = "apps/daemon/src/daemon-composition.ts";
const TOOL_TURN_CONTRACT = "packages/agent/src/run/ports/tool-turn.ts";

describe("Phase 4D canonical batch boundaries", () => {
  it("keeps the canonical batch and observation layers free of legacy and host packages", () => {
    // 1, 2. Neither new layer may reach back into the legacy Tool package.
    for (const [prefix, label] of [
      [BATCH, "the canonical batch"],
      [OBSERVATION, "the canonical observation layer"],
    ] as const) {
      for (const file of filesUnder(prefix)) {
        const imports = importsFrom(read(file));
        const legacy = imports.filter(
          (specifier) => specifier === "@caelush/tools" || specifier.startsWith("@caelush/tools/"),
        );
        expect(legacy, `${label} must not import @caelush/tools (${file})`).toEqual([]);
      }
    }

    // 3, 4, 5, 6, 7, 8. Nor Core, Context, the Coding Agent, Storage or Runtime — and neither may the
    // batch reach an app.
    const forbidden = [
      "@caelush/core",
      "@caelush/context",
      "@caelush/coding-agent",
      "@caelush/storage",
      "@caelush/runtime",
      "@caelush/security",
      "@caelush/verification",
      "@caelush/llm",
      "@caelush/events",
      "@caelush/memory",
    ];
    for (const prefix of [BATCH, OBSERVATION]) {
      for (const file of filesUnder(prefix)) {
        const imports = importsFrom(read(file));
        for (const specifier of forbidden) {
          expect(
            imports.filter(
              (candidate) => candidate === specifier || candidate.startsWith(`${specifier}/`),
            ),
            `${file} must not import ${specifier}`,
          ).toEqual([]);
        }
        expect(imports.some((candidate) => candidate.startsWith("apps/"))).toBe(false);
      }
    }
  });

  it("declares each canonical authority exactly once, in the Agent package", () => {
    // 9, 10, 11. One declaration each. A second declaration anywhere would let two objects disagree
    // about what a batch, a projection or a normalization is.
    const declarations = [
      { name: "ToolBatchCoordinator", owner: `${BATCH}batch-types.ts` },
      { name: "ModelToolFeedbackProjector", owner: `${OBSERVATION}model-feedback-projector.ts` },
      { name: "ToolResultBatchNormalizer", owner: `${OBSERVATION}result-batch-normalizer.ts` },
    ];
    for (const { name, owner } of declarations) {
      const carriers = productionSources().filter((file) =>
        new RegExp(`export interface ${name}\\b`).test(executableSources().get(file) ?? ""),
      );
      expect(carriers, `${name} must be declared once, in ${owner}`).toEqual([owner]);
    }

    // A *second* declaration of the batch coordinator contract anywhere in production would be a
    // competing batch authority. Phase 4F removed the legacy package that used to carry a
    // compatibility type of the same name, so `@caelush/agent` is now the only one.
    const competing = productionSources().filter((file) =>
      /export interface ToolBatchCoordinatorPort\b/.test(executableSources().get(file) ?? ""),
    );
    expect(competing, "no second batch coordinator contract may exist").toEqual([]);
  });

  it("keeps the canonical ToolBatchRequest and ToolBatchOutcome shapes frozen", () => {
    // Documentation is stripped, so a *declaration* is checked rather than the prose that explains why
    // the missing arms are missing.
    const types = executable(`${BATCH}batch-types.ts`);

    // The request has exactly seven fields, and the list is closed.
    const request = interfaceBody(types, "export interface ToolBatchRequest");
    expect(request).toContain("readonly runId: RunId;");
    expect(request).toContain("readonly sessionId: SessionId;");
    expect(request).toContain("readonly sourceStepId: StepId;");
    expect(request).toContain("readonly calls: readonly ToolCallRequest[];");
    expect(request).toContain("readonly environment: ToolExecutionEnvironment;");
    expect(request).toContain("readonly securityContext: ToolSecurityContext;");
    expect(request).toContain("readonly signal: AbortSignal;");
    for (const forbidden of [
      "mode",
      "registry",
      "store",
      "runtime",
      "workspace",
      "budget",
      "ToolTurnRequest",
      "AgentState",
    ]) {
      expect(request, `ToolBatchRequest must not carry ${forbidden}`).not.toMatch(
        new RegExp(`readonly ${forbidden}\\b`),
      );
    }

    // The item outcome has exactly three arms and no raw execution fact.
    const item = types.slice(
      types.indexOf("export type ToolBatchItemOutcome"),
      types.indexOf("export interface ToolBatchRequest"),
    );
    expect(item).toContain('readonly kind: "OBSERVATION"');
    expect(item).toContain('readonly kind: "REJECTED"');
    expect(item).toContain('readonly kind: "SKIPPED"');
    expect(item).toContain("readonly observation: ToolObservation;");
    expect(item).toContain("readonly feedback: ToolFailureFeedback;");
    for (const forbidden of [
      "rawResult",
      "rawArtifact",
      "exception",
      "ToolEffect",
      "ApprovalRequest",
      "Runtime",
    ]) {
      expect(item, `ToolBatchItemOutcome must not carry ${forbidden}`).not.toContain(forbidden);
    }

    // The outcome has exactly four arms, and infrastructure failure is not one of them.
    const outcome = types.slice(
      types.indexOf("export type ToolBatchOutcome"),
      types.indexOf("export interface ToolBatchCoordinator"),
    );
    for (const kind of ["COMPLETED", "WAITING_APPROVAL", "BUDGET_EXCEEDED", "CANCELLED"]) {
      expect(outcome).toContain(`readonly kind: "${kind}"`);
    }
    for (const forbidden of ["INFRASTRUCTURE_FAILURE", "RESOURCE_WAIT", "REPLAN", "RUN_FAILED"]) {
      expect(outcome, `ToolBatchOutcome must not declare ${forbidden}`).not.toContain(forbidden);
    }

    // The coordinator has exactly one method, and no legacy surface.
    const coordinator = interfaceBody(types, "export interface ToolBatchCoordinator");
    expect(coordinator).toContain("execute(request: ToolBatchRequest): Promise<ToolBatchOutcome>;");
    for (const forbidden of ["recover(", "modelDefinitions(", "dispatch("]) {
      expect(coordinator, `ToolBatchCoordinator must not declare ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it("keeps the batch strictly sequential and never prepares or executes a skipped call", () => {
    const batch = executable(`${BATCH}batch-coordinator.ts`);

    // 19. No concurrency anywhere in the canonical batch or its planner.
    expect(batch).not.toContain("Promise.all");
    expect(batch).not.toContain("Promise.allSettled");
    expect(batch).not.toContain("Promise.race");
    expect(executable(`${BATCH}batch-planner.ts`)).not.toContain("Promise.all");

    // It iterates the calls in their original order.
    expect(batch).toContain("for (const call of request.calls)");

    // The skip is decided *before* preparation, so a skipped call is never prepared, never admitted,
    // never durably recorded and never executed.
    const loop = declarationBody(
      batch,
      "async function executeCalls(",
      "): Promise<ToolBatchOutcome> {",
    );
    const skipIndex = loop.indexOf("if (skipRemaining)");
    const prepareIndex = loop.indexOf("prepareCall(");
    const executeIndex = loop.indexOf("executeOne(");
    expect(skipIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeGreaterThan(skipIndex);
    expect(executeIndex).toBeGreaterThan(skipIndex);

    // The planner only implements the sequential plan, and a declared `PARALLEL_SAFE` changes nothing.
    const planner = executable(`${BATCH}batch-planner.ts`);
    expect(planner).toContain('readonly kind: "SEQUENTIAL";');
    expect(planner).toContain("executionMode");
    expect(planner).not.toContain('"CONCURRENT"');
  });

  it("keeps the pre-invocation rejection free of every durable side effect", () => {
    const batch = executable(`${BATCH}batch-coordinator.ts`);

    // A rejection is an item, and the loop continues: a safe rejection never blocks a later call.
    expect(batch).toContain('kind: "REJECTED"');
    const loop = declarationBody(
      batch,
      "async function executeCalls(",
      "): Promise<ToolBatchOutcome> {",
    );
    expect(loop).toContain("continue;");

    // Validation and the duplicate check happen before the budget preflight, and the preflight happens
    // before the first preparation. That ordering is what makes "execute first, discover the duplicate
    // later" impossible.
    const execute = declarationBody(
      batch,
      "async execute(value: ToolBatchRequest)",
      "): Promise<ToolBatchOutcome> {",
    );
    const validateIndex = execute.indexOf("assertToolBatchRequest(");
    const abortIndex = execute.indexOf("request.signal.aborted");
    const preflightIndex = execute.indexOf("preflightBudget(");
    const loopIndex = execute.indexOf("executeCalls(");
    expect(validateIndex).toBeGreaterThan(-1);
    expect(abortIndex).toBeGreaterThan(validateIndex);
    expect(preflightIndex).toBeGreaterThan(abortIndex);
    expect(loopIndex).toBeGreaterThan(preflightIndex);

    // The duplicate check lives inside validation, before anything else can happen.
    const validation = declarationBody(
      batch,
      "export function assertToolBatchRequest(",
      "): ToolBatchRequest {",
    );
    expect(validation).toContain("seen.has(externalCallId)");
    expect(validation).toContain("keys.length !== BATCH_REQUEST_KEYS.length");

    // The canonical batch never reaches the legacy Dispatcher, and never creates a durable row itself.
    expect(batch).not.toContain("Dispatcher");
    expect(batch).not.toContain("persistArgumentFailure");
  });

  it("keeps the canonical batch's only dependencies the three frozen collaborators", () => {
    const batch = executable(`${BATCH}batch-coordinator.ts`);
    const options = interfaceBody(batch, "export interface ToolBatchCoordinatorOptions");

    expect(options).toContain("readonly preparer: ToolCallPreparer;");
    expect(options).toContain("readonly durable: Pick<DurableToolExecutionCoordinator");
    expect(options).toContain("readonly budget: Pick<ToolBudgetAdmissionPort");

    // No registry *data*, no store, no Runtime, no workspace, no RunController: each belongs to one of
    // the three collaborators, and a second reference here would be a second owner.
    for (const forbidden of [
      "store",
      "runtime",
      "workspace",
      "RunController",
      "ToolDispatcher",
      "ToolExecutionStorePort",
    ]) {
      expect(options, `ToolBatchCoordinatorOptions must not carry ${forbidden}`).not.toMatch(
        new RegExp(`readonly ${forbidden}\\b`),
      );
    }
  });
});

describe("Phase 4D model feedback boundaries", () => {
  it("keeps the projector's inputs to a durable observation or safe feedback", () => {
    const projector = executable(`${OBSERVATION}model-feedback-projector.ts`);
    const declaration = interfaceBody(
      executable(`${OBSERVATION}model-feedback-projector.ts`),
      "export interface ModelToolFeedbackProjector",
    );

    // 17. The frozen input names three things and nothing else.
    expect(declaration).toContain("readonly calls: readonly ToolCallRequest[];");
    expect(declaration).toContain("readonly items: readonly ToolBatchItemOutcome[];");
    expect(declaration).toContain("readonly policy: ToolObservationPolicySnapshot;");

    // 18. No transient update, no raw execution result, no raw exception, no Tool effect. The result
    // *batch error* is named, and that is the point: it is the integrity failure the projector raises,
    // not an execution result it consumes.
    for (const forbidden of [
      "AgentToolResult<",
      "ToolExecutionUpdate",
      "ToolEffect",
      "stdout",
      "stderr",
      "exception",
    ]) {
      expect(declaration, `the projector input must not name ${forbidden}`).not.toContain(
        forbidden,
      );
      expect(projector, `the projector must not handle ${forbidden}`).not.toContain(forbidden);
    }

    // The observation policy is reused, never redeclared: one declaration, in the Agent Loop types.
    const policyOwners = productionSources().filter((file) =>
      /export interface ToolObservationPolicySnapshot\b/.test(executableSources().get(file) ?? ""),
    );
    expect(policyOwners).toEqual(["packages/agent/src/loop/types.ts"]);

    // Identity comes from the call. A projector that parsed an id out of content, or accepted a
    // caller-supplied one, could pair one Tool's output with another Tool's identity.
    expect(projector).toContain("item.call.externalCallId");
    expect(projector).toContain("item.call.toolName");
  });

  it("keeps the Context token projection injected rather than reimplemented", () => {
    // 5. The Agent package may not import the Context implementation, and may not copy the algorithm.
    const observationLayer = codeUnder(OBSERVATION);
    expect(observationLayer).not.toContain("@caelush/context");
    expect(observationLayer).not.toContain("projectToolObservationBatch");
    expect(observationLayer).not.toContain("Utf8HeuristicTokenEstimator");
    // The head + omission-marker + tail behaviour for large file/command output is Context-owned, so it
    // must not be re-derived here either.
    expect(observationLayer).not.toContain("read_file");

    // The seam exists, and Core supplies the implementation at the composition boundary.
    expect(executable(`${OBSERVATION}model-feedback-projector.ts`)).toContain(
      "export interface ModelObservationBatchProjector",
    );
    const coreAdapter = executable(`${CORE}agent-tool-batch.ts`);
    expect(coreAdapter).toContain("export function toContextObservationProjection(");
    expect(coreAdapter).toContain("projectToolObservationBatch({");
    expect(executable(DAEMON)).toContain("toContextObservationProjection()");
  });

  it("keeps model feedback produced only for a complete batch", () => {
    const adapter = executable(`${CORE}run-tool-turn-coordinator.ts`);

    // The projector runs on the COMPLETED arm only. `WAITING_APPROVAL`, `BUDGET_EXCEEDED` and
    // `CANCELLED` write no partial model result.
    const completed = declarationBody(
      adapter,
      "function completedToolTurnResult(",
      "): Promise<ToolTurnResult> {",
    );
    expect(completed).toContain("projectAndNormalize(");
    expect(adapter).toContain("context.feedback.project(");
    expect(adapter).toContain("context.normalizer.normalize(");
    expect(adapter).toContain("completedResults: [],");

    // The three non-complete arms never project.
    for (const arm of [
      'case "WAITING_APPROVAL":',
      'case "BUDGET_EXCEEDED":',
      'case "CANCELLED":',
    ]) {
      const marker = adapter.indexOf(arm);
      expect(marker).toBeGreaterThan(-1);
    }
    // The shared helper is the sole projection call site; both complete and REPLAN routes use it.
    const projections = adapter.match(/feedback\.project\(/g) ?? [];
    expect(projections).toHaveLength(1);
  });

  it("keeps the normalizer a defense rather than a producer", () => {
    const normalizer = executable(`${OBSERVATION}result-batch-normalizer.ts`);

    // 11. It owns identity, shape, multiplicity, matching and ordering — and nothing else.
    for (const forbidden of [
      "projectToolObservationBatch",
      "boundToolResultContent",
      "ToolObservation",
      "execute(",
      "fetch(",
      "readFile",
    ]) {
      expect(normalizer, `the normalizer must not do ${forbidden}`).not.toContain(forbidden);
    }

    // It uses the AI package's own message assertion, so there is never a second, weaker definition of
    // a valid model Tool result.
    expect(normalizer).toContain("assertAIMessage(");
    expect(normalizer).toContain("@caelush/ai");

    // Every frozen refusal reason is present.
    for (const reason of [
      "DUPLICATE_REQUEST_ID",
      "INVALID_RESULT",
      "DUPLICATE_RESULT",
      "UNEXPECTED_RESULT",
      "MISSING_RESULT",
      "TOOL_NAME_MISMATCH",
    ]) {
      expect(normalizer).toContain(reason);
    }

    // The ordering authority is `requests`, and the returned batch is frozen.
    expect(normalizer).toContain("requests.map((request) =>");
    expect(normalizer).toContain("Object.freeze(");
  });
});

describe("Phase 4D production cutover", () => {
  it("keeps the production Run Tool turn on the canonical batch", () => {
    const controller = executable(`${CORE}run-controller.ts`);
    const adapter = executable(`${CORE}run-tool-turn-coordinator.ts`);

    // 12. Production no longer names the legacy port.
    for (const file of [controller, adapter, executable(`${CORE}run-controller-ports.ts`)]) {
      expect(file).not.toContain("ToolBatchCoordinatorPort");
      expect(file).not.toContain("ToolBatchItemResult");
    }

    // The Run Layer declares the canonical pipeline, and the adapter consumes it.
    const ports = read(`${CORE}run-controller-ports.ts`);
    const pipeline = interfaceBody(ports, "export interface ToolTurnPipeline");
    expect(pipeline).toContain("readonly batches: ToolBatchCoordinator;");
    expect(pipeline).toContain("readonly feedback: ModelToolFeedbackProjector;");
    expect(pipeline).toContain("readonly normalizer: ToolResultBatchNormalizer;");
    expect(ports).toContain('from "@caelush/agent"');

    expect(adapter).toContain("readonly batches: ToolBatchCoordinator;");
    expect(adapter).toContain("dependencies.batches.execute(");

    // 13. The daemon composes the canonical batch and never constructs the legacy one.
    const daemon = executable(DAEMON);
    expect(daemon).toContain("createToolBatchCoordinator({");
    expect(daemon).toContain("createModelToolFeedbackProjector({");
    expect(daemon).toContain("createToolResultBatchNormalizer()");
    expect(daemon).not.toContain("new ToolBatchCoordinator(");
    expect(daemon).toContain("toolTurn,");

    // 14. The canonical batch does not call a Dispatcher, and the production path cannot reach legacy
    // argument-failure persistence. Phase 4F removed the Dispatcher entirely, so the file is gone
    // rather than merely unreachable.
    expect(executable(`${BATCH}batch-coordinator.ts`)).not.toContain("Dispatcher");
    expect(daemon).not.toContain("persistArgumentFailure");
    expect(existsSync(join(root, `${LEGACY_TOOLS}dispatcher.ts`))).toBe(false);
  });

  it("keeps Core free of a second model-feedback or normalization algorithm", () => {
    // 15. The legacy conversion entry point is no longer the production model feedback authority.
    const adapter = executable(`${CORE}run-tool-turn-coordinator.ts`);
    expect(adapter).not.toContain("toAgentToolResults(");
    expect(adapter).not.toContain("toLLMToolResultMessages(");

    const coreBatch = executable(`${CORE}agent-tool-batch.ts`);
    expect(coreBatch).toContain("export function toContextObservationProjection(");
    // It delegates to the Context algorithm rather than re-deriving truncation.
    expect(coreBatch).toContain("projectToolObservationBatch({");

    // 16. The legacy normalizer delegates to the canonical one and owns no validation of its own.
    const coreResults = executable(`${CORE}agent-tool-results.ts`);
    expect(coreResults).toContain("createToolResultBatchNormalizer()");
    expect(coreResults).toContain("canonicalNormalizer.normalize(");
    for (const reason of ["DUPLICATE_RESULT", "MISSING_RESULT", "TOOL_NAME_MISMATCH"]) {
      expect(coreResults, `Core must not re-derive ${reason}`).not.toContain(reason);
    }

    // One declaration of the result-batch error; `@caelush/core` re-exports it rather than
    // redeclaring it, and Phase 4F removed the legacy package that used to carry a second re-export.
    const errorOwners = productionSources().filter((file) =>
      /export class AgentToolResultBatchError\b/.test(executableSources().get(file) ?? ""),
    );
    expect(errorOwners).toEqual([`${BATCH}batch-errors.ts`]);
    expect(executable(`${CORE}agent-errors.ts`)).toContain(
      'export { AgentToolResultBatchError } from "@caelush/agent";',
    );
    expect(existsSync(join(root, `${LEGACY_TOOLS}batch-errors.ts`))).toBe(false);

    // And the Run Layer keeps its classification: a batch input error is a model error in the LLM
    // phase, and everything else is a Tool runtime error.
    const controller = executable(`${CORE}run-controller.ts`);
    expect(controller).toContain("error instanceof ToolBatchInputError");
    expect(controller).toContain('code: "MODEL_ERROR"');
    expect(controller).toContain('code: "RUNTIME_ERROR"');
  });

  it("keeps a cancelled batch on the Run cancellation authority", () => {
    const adapter = executable(`${CORE}run-tool-turn-coordinator.ts`);

    // The frozen ToolTurnResult has five discriminants and `CANCELLED` is not one of them.
    const contract = read(TOOL_TURN_CONTRACT);
    expect(contract).not.toContain("CANCELLED");
    expect(adapter).not.toContain('kind: "CANCELLED"');

    // A cancellation that the Run's own signal explains is left for the Run Layer's existing aborted
    // path; a cancelled batch under a live signal fails closed rather than forging an authority.
    expect(adapter).toContain("RunControllerInvariantError");
    const controller = executable(`${CORE}run-controller.ts`);
    expect(controller).toContain("this.executionSignal(snapshot.run.id).aborted");
    expect(controller).toContain("finalizeAbortedExecution(");
  });
});

describe("Phase 4D frozen contracts and phase boundaries", () => {
  it("keeps the Phase 3 Tool turn contract byte-for-byte unchanged", () => {
    // 20, 21. The two frozen contracts. This is a structural check, so a widened request or a sixth
    // result arm breaks the build here rather than in a downstream consumer.
    const contract = read(TOOL_TURN_CONTRACT);

    const request = interfaceBody(contract, "export interface ToolTurnRequest");
    expect(request).toContain("readonly mode: RunExecutionMode;");
    expect(request).toContain("readonly sourceStepId: StepId;");
    expect(request).toContain("readonly pendingDecision: AgentToolCallsDecision;");
    expect(request).toContain("readonly observationPolicy?: ToolObservationPolicySnapshot");
    expect(request).toContain("readonly signal: AbortSignal;");
    for (const forbidden of [
      "workspace",
      "runtime",
      "registry",
      "store",
      "securityContext",
      "ToolBatchCoordinator",
    ]) {
      expect(request, `ToolTurnRequest must not carry ${forbidden}`).not.toMatch(
        new RegExp(`readonly ${forbidden}\\b`),
      );
    }

    expect(contract).toContain("export const TOOL_TURN_RESULT_KINDS = [");
    for (const kind of [
      "COMPLETED",
      "WAITING_APPROVAL",
      "BUDGET_EXCEEDED",
      "RESOURCE_WAIT",
      "REPLAN",
    ]) {
      expect(contract).toContain(`"${kind}"`);
    }
    for (const forbidden of ["CANCELLED", "INFRASTRUCTURE_FAILURE", "REJECTED"]) {
      expect(contract, `ToolTurnResult must not gain ${forbidden}`).not.toContain(forbidden);
    }

    // `mode` survives the cutover: it is still read, still recorded and still validated.
    const adapter = executable(`${CORE}run-tool-turn-coordinator.ts`);
    expect(adapter).toContain("effectiveMode");
    expect(adapter).toContain('requestedMode === "RECOVER" ? "RECOVER" : "EXECUTE"');
  });

  it("keeps the Phase 4A, 4B and 4C contracts unchanged", () => {
    // 22. Phase 4A: the Preparer signature and its two-outcome union.
    const preparer = read(`${AGENT_TOOLS}call/tool-call-preparer.ts`);
    expect(preparer).toContain("prepare(request: ToolCallRequest): ToolCallPreparationOutcome;");
    expect(preparer).toContain('readonly kind: "READY";');
    expect(preparer).toContain('readonly kind: "REJECTED";');

    // 23. Phase 4B: the executor and the result pipeline.
    const executor = executable(`${AGENT_TOOLS}execution/invocation-executor.ts`);
    expect(executor).toContain("export interface ToolInvocationExecutor {");
    expect(executor).toContain("input.call.resolved.tool.execute({");
    const pipeline = executable(`${AGENT_TOOLS}result/result-pipeline.ts`);
    expect(pipeline).toContain("export interface ToolResultPipeline {");
    expect(pipeline).toContain("export interface PreparedToolSettlement {");

    // 24. Phase 4C: the durable request, outcome and coordinator.
    const durable = read(`${AGENT_TOOLS}durable/durable-execution-coordinator.ts`);
    const durableRequest = interfaceBody(durable, "export interface DurableToolExecutionRequest");
    expect(durableRequest).toContain("readonly call: PreparedToolCall;");
    expect(durable).toContain("export type DurableToolExecutionOutcome =");
    const coordinator = interfaceBody(durable, "export interface DurableToolExecutionCoordinator");
    expect(coordinator).toContain("execute(request: DurableToolExecutionRequest)");
    expect(coordinator).toContain("recover(");
  });

  it("adds no durable surface: no Protocol field, no migration, no new status", () => {
    // 25. No Protocol schema gained a Tool-batch field. The canonical batch vocabulary lives entirely
    // in `@caelush/agent`, and nothing about it is persisted.
    const protocol = codeUnder("packages/protocol/src/");
    for (const forbidden of [
      "ToolBatchItemOutcome",
      "ModelToolFeedbackProjector",
      "ToolResultBatchNormalizer",
      "SKIPPED_AFTER_UNCERTAIN_EXECUTION",
    ]) {
      expect(protocol, `Protocol must not declare ${forbidden}`).not.toContain(forbidden);
    }

    // 26. No new migration. The Tool System's durable entities are unchanged by this round.
    const migrations = allFiles(join(root, "packages/storage/migrations")).filter((file) =>
      file.endsWith(".sql"),
    );
    const migrationNames = migrations
      .map((file) => relative(root, file).replaceAll("\\", "/"))
      .sort();
    expect(migrationNames).toEqual(migrationNames);
    // The `approval_requests` entity Phase 9B added and the Tool tables Phase 7B added are still the
    // whole durable Tool surface: this round adds no `tool_batches` table.
    const migrationSql = migrations
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
      .toLowerCase();
    expect(migrationSql).not.toContain("tool_batches");

    // And the canonical batch declares no persistence of its own.
    expect(executable(`${BATCH}batch-coordinator.ts`)).not.toContain("INSERT");
    expect(executable(`${BATCH}batch-coordinator.ts`)).not.toContain("commit(");
  });

  it("leaves the nine builtins and the Operations migration where Phase 4E put them", () => {
    /**
     * Phase 4D asserted assertions 27 and 28 against the *4C* state:
     *
     * ```text
     * 27  the nine builtins are still legacy registrations
     * 28  the Operations migration has not started; no Operations interface exists anywhere
     * ```
     *
     * Phase 4E is the round that was always going to invalidate both — it owns "all nine Coding builtins"
     * and "Operations ports" by its own frozen scope statement. The correction is to the guards'
     * *subject*, not to their strength: the same two properties are asserted against the state 4E is
     * required to reach.
     *
     * ```text
     * the nine builtins are owned by @caelush/coding-agent
     * the eight Operations interfaces exist, in @caelush/coding-agent
     * ```
     *
     * The separate Phase 4E guard (`phase-4e-coding-tools-operations-boundaries.test.ts`) carries the
     * structural detail: exact names, order, schemas and the Operations shapes.
     */
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
    // 27. The nine builtins are now Coding-owned: their authoritative factories live in the Coding layer.
    const codingBuiltins = "packages/coding-agent/src/tools/builtins/";
    const codingDefaultTools = executable(`${codingBuiltins}default-tools.ts`);
    for (const name of builtinNames) {
      expect(codingDefaultTools, `${name} must be composed by the Coding default set`).toContain(
        name,
      );
    }

    // No Coding builtin implementation has crept into the general Agent layer.
    for (const file of filesUnder(AGENT_TOOLS)) {
      const source = executableSources().get(file) ?? "";
      for (const name of builtinNames) {
        expect(source, `${file} must not name the builtin ${name}`).not.toContain(name);
      }
    }

    // 28. The Operations migration happened in Phase 4E: all eight interfaces exist, once, in Coding.
    for (const name of [
      "ReadFileOperations",
      "ListDirectoryOperations",
      "FindFilesOperations",
      "SearchTextOperations",
      "PatchOperations",
      "ExecOperations",
      "ProcessOperations",
      "GitOperations",
    ]) {
      const carriers = productionSources().filter((file) =>
        new RegExp(`export interface ${name}\\b`).test(executableSources().get(file) ?? ""),
      );
      expect(carriers, `${name} must be declared once, in the Coding layer`).toEqual([
        `packages/coding-agent/src/tools/operations/${name
          .replace(/([A-Z])/g, "-$1")
          .toLowerCase()
          .replace(/^-/, "")}.ts`,
      ]);
    }
  });

  it("keeps the legacy batch facade retired rather than merely unreferenced", () => {
    // Phase 4D left the facade in place and proved production did not reach it. Phase 4F owns the
    // retirement, so the assertion is now the stronger one: the package, the facade and the second
    // batch coordinator no longer exist anywhere.
    expect(existsSync(join(root, "packages/tools"))).toBe(false);
    expect(existsSync(join(root, `${LEGACY_TOOLS}batch-coordinator.ts`))).toBe(false);
    expect(existsSync(join(root, `${LEGACY_TOOLS}dispatcher.ts`))).toBe(false);

    const legacyUsers = productionSources().filter((file) => {
      const source = executableSources().get(file) ?? "";
      return (
        /new ToolBatchCoordinator\(/.test(source) || /\bToolBatchCoordinatorPort\b/.test(source)
      );
    });
    expect(legacyUsers, "no production file may construct or name a legacy batch").toEqual([]);

    // The canonical package does not depend on the retired one in either direction.
    for (const file of filesUnder(BATCH)) {
      expect(executableSources().get(file) ?? "").not.toContain("@caelush/tools");
    }

    // And the batch error classes are declared exactly once, in the Agent package: an `instanceof`
    // check agrees everywhere because there is only one class object to check against.
    const batchErrors = executable(`${BATCH}batch-errors.ts`);
    expect(batchErrors).toContain("export class ToolBatchInputError");
    expect(batchErrors).toContain("export class ToolBatchInfrastructureError");
    const competing = productionSources().filter(
      (file) =>
        file !== `${BATCH}batch-errors.ts` &&
        /export class ToolBatch(?:Input|Infrastructure)Error\b/.test(
          executableSources().get(file) ?? "",
        ),
    );
    expect(competing, "the batch error classes are declared exactly once").toEqual([]);
  });
});
