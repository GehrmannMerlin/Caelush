import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 3D durable Tool turn boundary guards.
 *
 * ```text
 * Coordinator        pure: it decides which batch is next
 * RunExecutionDriver executes one effect, through a port
 * RunController      the only object that commits a lifecycle transition
 * Tool adapter       the only object that knows the legacy Tool batch request
 * ```
 *
 * Phase 3D's success criterion is an **authority switch**, not a directory rename: Tool execution
 * authority moved into the frozen `RunExecutionDriver`, and the Run Layer's main loop stopped
 * executing Tool batches inline. These guards are structural, so a later refactor cannot quietly put a
 * `ToolBatchCoordinator.execute` call back into the loop, re-widen `ToolTurnRequest` with a workspace,
 * or let an internal Tool identifier reach a model-facing contract.
 *
 * The contract-level half lives in `packages/agent/test/contracts/`, which fails `pnpm typecheck` on
 * any shape drift; these are the structural half.
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

/** A file's executable code, with its documentation removed. */
function executable(relativePath: string): string {
  return read(relativePath)
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every production source file in the workspace, excluding builds and tests. */
function productionSources(): string[] {
  return sourceFiles(join(root, "packages"))
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .filter((file) => !file.includes("/dist/") && !file.includes("/test/"));
}

/**
 * The region of a file that belongs to one class member or module function.
 *
 * ```text
 * from   the member's own declaration line
 * to     the next member declaration at the same indentation, or the end of the file
 * ```
 *
 * These guards assert *ordering* and *absence* inside one region — that a driver call precedes a
 * commit, that no `catch` exists in a settlement — and both are properties of a region rather than of
 * a precise brace. Reading the region by indentation is enough, and it is robust against everything a
 * brace count is not: an inline object type in a signature, a mapped type, a destructured parameter
 * and a callback body all live inside the region without moving its edges.
 *
 * The file is formatted by the repository's own Prettier configuration, so declaration indentation is
 * a property the workspace guarantees rather than one this reads a guess from.
 */
function memberRegion(source: string, declaration: string): string {
  const lines = source.split("\n");
  const from = lines.findIndex((line) => line.includes(declaration));
  if (from < 0) return "";
  const indent = /^[ \t]*/.exec(lines[from]!)?.[0] ?? "";
  const memberEnd = lines.findIndex(
    (line, index) =>
      index > from && line.startsWith(`${indent}private `) && line.trimEnd().endsWith("("),
  );
  return lines.slice(from, memberEnd < 0 ? lines.length : memberEnd).join("\n");
}

/** The index of `needle` inside `source`, asserting it is present first. */
function at(source: string, needle: string): number {
  const index = source.indexOf(needle);
  expect(index, `${needle} must be present`).toBeGreaterThan(-1);
  return index;
}

describe("Phase 3D durable Tool turn driver boundaries", () => {
  it("drives EXECUTE_TOOL_BATCH through the frozen Run execution driver", () => {
    const controller = executable("packages/core/src/run-controller.ts");

    // The Tool directive is executed by the driver, over the run-scoped adapter.
    const execute = memberRegion(controller, "private async executeToolBatchDirective(");
    expect(execute.length).toBeGreaterThan(0);
    expect(execute).toContain("createRunExecutionDriver({");
    expect(execute).toContain("toolTurns: turnDriver.coordinator");
    expect(execute).toContain("await driver.execute(directive");

    // The adapter is created per directive, from the snapshot the coordinator decided from, and the
    // entry mode is threaded in rather than derived.
    const resolve = memberRegion(controller, "private toolTurnDriver(");
    expect(resolve).toContain("createRunToolTurnDriverFactory(");
    expect(resolve).toContain("requestedMode");
    expect(resolve).toContain("snapshot.run.id");

    // And the real adapter is a real `ToolTurnCoordinator` over the canonical Tool System.
    const adapter = executable("packages/core/src/run-tool-turn-coordinator.ts");
    expect(adapter).toContain("createRunToolTurnDriverFactory(");
    expect(adapter).toContain("readonly coordinator: ToolTurnCoordinator;");
    // Phase 4D: one entry point. `ToolTurnRequest.mode` still exists, is still validated and is still
    // recorded, but it no longer selects `recover()` vs `execute()` — the durable coordinator owns
    // per-call recovery, so both entries are the canonical `execute()`.
    expect(adapter).toContain("dependencies.batches.execute(");
    expect(adapter).not.toContain("dependencies.batches.recover(");
  });
  it("keeps every deferred port out of production and each effect on its own real port", () => {
    // No production file may carry a deferred port any more: Phase 3D replaced the Tool one and Phase
    // 3E replaced the completion one, so either name appearing again would mean a port nobody
    // implemented was being bound into a driver.
    const carriers = productionSources().filter(
      (file) =>
        read(file).includes("DEFERRED_TOOL_TURN_COORDINATOR") ||
        read(file).includes("DEFERRED_COMPLETION_GATE"),
    );
    expect(carriers).toEqual([]);

    // Each effect binds a *misroute* guard for the other two rather than a second execution path.
    const deferred = executable("packages/core/src/run-agent-deferred-ports.ts");
    expect(deferred).toContain("export const MISROUTED_TOOL_TURN_COORDINATOR");
    expect(deferred).toContain("export const MISROUTED_COMPLETION_GATE");

    const controller = executable("packages/core/src/run-controller.ts");
    expect(controller).toContain("toolTurns: MISROUTED_TOOL_TURN_COORDINATOR");
    expect(controller).toContain("completionGate: MISROUTED_COMPLETION_GATE");
    // The Tool effect's own composition binds the real Tool coordinator and a misrouted completion
    // gate, so a Tool batch can never evaluate completion.
    expect(controller).toContain("toolTurns: turnDriver.coordinator");
    // The completion effect binds the real gate, with both other ports misrouted. Phase 3F moved the
    // gate *construction* out of the Run Layer, so what the Run Layer binds is the gate the resolved
    // completion evaluation carries — still a real gate, still driven by this same frozen driver.
    expect(controller).toContain("completionGate: resolved.gate");
    expect(controller).not.toContain("createRunCompletionGate(");
  });

  it("removes every inline Tool decision from the RunController main loop", () => {
    const controller = executable("packages/core/src/run-controller.ts");

    // No direct Tool execution, no resource governor, no inline observation projection, and no inline
    // approval or resource persistence. Each of these lived in the pre-Phase-3D loop, and each is now
    // the adapter's or the typed settlement's.
    for (const forbidden of [
      "coordinator.execute(request)",
      "coordinator.recover(request)",
      "new ResourceGovernor(",
      "evaluateToolBatch(",
      "toLLMToolResultMessages(",
      "ResourceGovernor.replanResults(",
      "resourceToolBatchDecision",
      "recordResourceReplan",
      "recordResourceObservation",
      "persistCompleteToolResultsLocked",
      "persistWaitingApprovalLocked",
      "persistWaitingResourceLocked",
      "fingerprintToolBatch(",
      "fingerprintToolResultBatch(",
      "driveToolBoundariesLocked",
    ]) {
      expect(controller, `run-controller must not contain ${forbidden}`).not.toContain(forbidden);
    }

    // What remains is one driver call and a typed settlement, and both are named methods rather than
    // an inline branch.
    expect(controller).toContain("await this.executeToolBatchDirective(");
    expect(controller).toContain("await this.settleToolEffect(");
    expect(controller).toContain("classifyToolEffectSettlement({");

    // The entry mode is threaded in and refreshed in exactly three places — a settled Tool batch, a
    // completed Agent turn and a settled completion — because those are the three points at which the
    // next batch stops being the one the caller entered with. A fourth refresh would mean the loop had
    // re-derived the mode from something other than its own entry.
    const modeRefreshes = controller.match(/^\s+mode = "EXECUTE";$/gm) ?? [];
    expect(modeRefreshes).toHaveLength(3);
  });

  it("routes every Tool turn result to exactly one typed settlement authority", () => {
    const router = executable("packages/core/src/run-tool-effect-settlement.ts");

    // Classification reads the frozen result and the Core-private observation only.
    expect(router).toContain("readonly result: ToolTurnResult;");
    expect(router).toContain("readonly observation: RunToolTurnObservation;");
    // Each route is a named authority, and there is no generic fallback.
    for (const route of ["CANONICAL_TOOL_EFFECT", "RESOURCE_COMPATIBILITY", "BUDGET_AUTHORITY"]) {
      expect(router, route).toContain(route);
    }
    // No message parsing decides a route, and nothing is caught.
    expect(router).not.toContain(".message");
    expect(router).not.toContain("catch");
    // The replan count is refused rather than defaulted when the observation does not carry one.
    expect(router).toContain("requireReplanCount");
    expect(router).toMatch(/replanCount === undefined/);
    // The budget route narrows the frozen block and never re-derives the numbers.
    expect(router).toContain("requireExceededBlock");

    // And the controller's own settlement never catches a planner error into a compatibility route.
    const controller = executable("packages/core/src/run-controller.ts");
    const settle = memberRegion(controller, "private async settleCanonicalToolTurn(");
    expect(settle.length).toBeGreaterThan(0);
    expect(settle).not.toContain("catch");
    // Ordering is the contract: plan, materialize, commit, notify, then post-commit progress.
    const plan = at(settle, "this.transitionPlanner.plan(");
    const materialize = at(settle, "this.eventMaterializer.materialize(");
    const commit = at(settle, "await this.commit(materialized)");
    const notify = at(settle, "this.notify(committed.events)");
    const progress = at(settle, "await this.recordToolTurnProgress(");
    expect(materialize).toBeGreaterThan(plan);
    expect(commit).toBeGreaterThan(materialize);
    expect(notify).toBeGreaterThan(commit);
    expect(progress).toBeGreaterThan(notify);
  });

  it("keeps the frozen Tool request and result free of host facts", () => {
    const port = read("packages/agent/src/run/ports/tool-turn.ts");

    // The request still carries the frozen mode, the requesting Step, the decision, the observation
    // policy and the signal — and nothing a host owns.
    for (const forbidden of [
      "workspace",
      "runtime",
      "securityContext",
      "permissionProfile",
      "approvalPolicy",
      "resourcePolicy",
      "budget",
      "runId",
      "sessionId",
      "store",
    ]) {
      expect(port, `ToolTurnRequest must not carry ${forbidden}`).not.toContain(
        `readonly ${forbidden}`,
      );
    }
    // The discriminants are exactly the five that were frozen, and no failure vocabulary was added.
    for (const kind of [
      '"COMPLETED"',
      '"WAITING_APPROVAL"',
      '"BUDGET_EXCEEDED"',
      '"RESOURCE_WAIT"',
      '"REPLAN"',
    ]) {
      expect(port).toContain(kind);
    }
    const discriminants = port.slice(
      at(port, "export type ToolTurnResult"),
      at(port, "export const TOOL_TURN_RESULT_KINDS"),
    );
    for (const forbidden of ["FAILED", "CANCELLED", "INFRASTRUCTURE_ERROR", "UNCERTAIN"]) {
      expect(discriminants, `ToolTurnResult must not declare ${forbidden}`).not.toContain(
        forbidden,
      );
    }

    // `AgentToolResult` is still exactly the four model-facing fields.
    const result = port.slice(
      at(port, "export interface AgentToolResult"),
      at(port, "export interface WaitingApprovalBoundary"),
    );
    for (const field of ["externalCallId", "toolName", "content", "isError"]) {
      expect(result, `AgentToolResult must carry ${field}`).toContain(field);
    }
    for (const forbidden of [
      "invocationId",
      "observationId",
      "rawArtifactRef",
      "workspace",
      "runtime",
      "details",
      "args",
    ]) {
      expect(result, `AgentToolResult must not carry ${forbidden}`).not.toContain(forbidden);
    }

    // The frozen effect context is unchanged too.
    const driver = read("packages/agent/src/run/run-execution-driver.ts");
    for (const forbidden of [
      "workspace",
      "cwd",
      "runtime",
      "verificationPlan",
      "budget",
      "store",
    ]) {
      expect(driver, `RunExecutionEffectContext must not carry ${forbidden}`).not.toContain(
        `readonly ${forbidden}:`,
      );
    }
  });

  it("keeps the run-scoped adapter the only Core object that speaks a Tool batch", () => {
    // The canonical `ToolBatchRequest` is declared by the Agent Tool System, and Core may name it only
    // in the one run-scoped adapter that translates the frozen Tool turn into it. Phase 4D moved the
    // declaration from the legacy Tool System to `@caelush/agent`; Phase 4F deleted the legacy
    // declaration, so the list below is the complete set of places the name exists at all.
    const builders = productionSources().filter((file) =>
      /\bToolBatchRequest\b/.test(executable(file)),
    );
    expect(builders.sort()).toEqual([
      "packages/agent/src/index.ts",
      "packages/agent/src/tools/batch/batch-coordinator.ts",
      "packages/agent/src/tools/batch/batch-types.ts",
      "packages/agent/src/tools/index.ts",
      "packages/core/src/run-tool-turn-coordinator.ts",
    ]);

    // The RunController holds the batch *port* and hands it to the adapter; it never builds a request
    // from it, and it names none of the Tool Layer's own types. That is what "the Run Layer does not
    // understand the Tool batch" means structurally.
    const controller = executable("packages/core/src/run-controller.ts");
    expect(controller).toContain("private toolTurnDependencies(");
    for (const forbidden of [
      "ToolBatchItem",
      "ToolSecurityContext",
      "ToolExecutionEnvironment",
      "ToolBatchOutcome",
      "ToolBatchRequest",
      "items:",
    ]) {
      expect(controller, `run-controller must not name ${forbidden}`).not.toContain(forbidden);
    }

    // The Tool Layer knows nothing about Core: the dependency direction is one-way. Comments are
    // stripped, because the Agent layer legitimately *describes* in prose which transitions stayed in
    // Core; what it may not do is import it.
    for (const file of productionSources().filter(
      (path) =>
        path.startsWith("packages/coding-agent/") ||
        path.startsWith("packages/agent/") ||
        path.startsWith("packages/tools/"),
    )) {
      expect(executable(file), `${file} must not depend on Core`).not.toContain("@caelush/core");
    }
  });

  it("keeps the daemon the composition root for Tool execution", () => {
    const daemon = executable("apps/daemon/src/daemon-composition.ts");
    // The composition root builds the registry and — since Phase 4D — the *canonical* batch coordinator
    // over the dispatcher's own durable coordinator. The legacy Dispatcher facade is no longer composed:
    // its only production consumer was the legacy batch.
    expect(daemon).toContain("createToolBatchCoordinator({");
    expect(daemon).not.toContain("createV1SecureToolDispatcher({");
    // It does not construct the legacy batch coordinator either: that facade is not a production
    // authority.
    expect(daemon).not.toContain("new ToolBatchCoordinator(dispatcher)");
    // ...and it composes the canonical durable coordinator and the Agent-owned bounded model
    // feedback projection. Raw observation recovery remains an internal durable Tool concern and
    // never becomes a second host-owned model projection.
    expect(daemon).toContain("createDurableToolExecutionCoordinator({");
    expect(daemon).toContain("createModelToolFeedbackProjector({");
    expect(daemon).toContain("projection: toContextObservationProjection(),");
    // It does not build a Tool batch request, a security context or an environment: those belong to
    // the adapter.
    expect(daemon).not.toContain("new ResourceGovernor(");
    expect(daemon).not.toContain("ToolBatchItem");
    expect(daemon).not.toContain("ToolExecutionEnvironment");
  });

  it("keeps raw observation pointers out of every model-facing contract", () => {
    // The legacy durable encoding may still carry the pointer; the canonical Run contracts may not.
    for (const file of [
      "packages/agent/src/run/ports/tool-turn.ts",
      "packages/agent/src/run/continuation/continuation.ts",
    ]) {
      expect(read(file), `${file} must not declare rawArtifactRef`).not.toContain("rawArtifactRef");
    }
    // The canonical AI Tool-result contract carries the four model-facing fields and nothing else.
    const message = read("packages/ai/src/messages/message.ts");
    const toolResult = message.slice(
      at(message, "export interface AIToolResultMessage"),
      at(message, "export interface AIToolResultMessage") + 400,
    );
    expect(toolResult).toContain("toolCallId");
    expect(toolResult).not.toContain("rawArtifactRef");
    expect(toolResult).not.toContain("invocationId");
    expect(toolResult).not.toContain("observationId");

    // The pointer is resolved through a port instead, and the port's only implementation reads the
    // Tool execution ledger by the identity the invocation ran under.
    const recovery = executable("packages/core/src/run-tool-observation-recovery.ts");
    expect(recovery).toContain("export interface ToolRawObservationRefResolver {");
    expect(recovery).toContain("findByExternalCall(");
    expect(recovery).toContain("observation?.rawArtifactRef");

    // The retired Context adapter no longer exists; the recovery resolver remains the only place that
    // can resolve the durable pointer, and its result is consumed before model projection.
    expect(existsSync(join(root, "packages/core/src/legacy-context-runtime-adapter.ts"))).toBe(
      false,
    );
  });

  it("keeps sequential Tool semantics and introduces no parallelism", () => {
    // The canonical Agent batch is the production scheduler, and it is strictly sequential: an ordinary
    // `for` over the calls, and no `Promise.all` anywhere in the batch or its planner.
    const canonical = executable("packages/agent/src/tools/batch/batch-coordinator.ts");
    expect(canonical).toContain("for (const call of request.calls)");
    expect(canonical).not.toContain("Promise.all");
    const planner = executable("packages/agent/src/tools/batch/batch-planner.ts");
    expect(planner).not.toContain("Promise.all");
    // Phase 4F removed the legacy batch, so there is no second sequential scheduler to check.
    expect(existsSync(join(root, "packages/tools/src/batch-coordinator.ts"))).toBe(false);
    // And no Tool execution path reaches for a fan-out primitive.
    for (const file of productionSources().filter((path) =>
      /\/(?:tools|batch|durable|execution)\//.test(path),
    )) {
      expect(executable(file), `${file} must not introduce parallelism`).not.toMatch(
        /\bPromise\.all\b|\bPromise\.allSettled\b|\bnew Worker\b/,
      );
    }

    // And the adapter asks the Tool Layer for exactly one batch per turn: one `execute` call site,
    // never a per-item loop and never a second entry point.
    const adapter = executable("packages/core/src/run-tool-turn-coordinator.ts");
    expect(adapter).not.toContain("Promise.all");
    const callSites = adapter.match(/dependencies\.batches\.(?:recover|execute)\(/g) ?? [];
    expect(callSites).toEqual(["dependencies.batches.execute("]);
  });

  it("keeps the Tool result batch a complete, ordered set", () => {
    const adapter = executable("packages/core/src/run-tool-turn-coordinator.ts");
    // A `WAITING_APPROVAL` outcome reports no partial results: the batch is not complete, so the model
    // is shown none of it and the durable invocations are the recovery authority.
    expect(adapter).toContain("completedResults: [],");
    // Phase 4D: the frozen results are produced by the canonical projector and then proven by the
    // canonical normalizer, in source order. Core no longer owns either algorithm.
    expect(adapter).toContain("context.feedback.project(");
    expect(adapter).toContain("context.normalizer.normalize(");
    // The Context token projection is still the one observation algorithm, reached through the seam.
    const projection = executable("packages/core/src/agent-tool-batch.ts");
    expect(projection).toContain("createToolObservationBatchProjector()");
    expect(projection).toContain("export function toContextObservationProjection(");
    // The projection rejects a mismatched batch rather than reordering it. Phase 4F replaced the legacy
    // per-item result with the canonical durable snapshot, so the identity check reads the invocation
    // the snapshot belongs to — and it still refuses a batch that does not line up.
    expect(projection).toContain("snapshot.invocation.toolName !== request.toolName");
    expect(projection).toContain("snapshot.invocation.externalCallId !== request.externalCallId");
    expect(projection).toContain("throw new ToolBatchResultConversionError()");
    expect(projection).not.toContain(".sort(");
  });

  it("keeps the Tool turn adapter's host facts captured, not derived", () => {
    const adapter = executable("packages/core/src/run-tool-turn-coordinator.ts");
    const controller = executable("packages/core/src/run-controller.ts");

    // The environment and security context come from the durable Run and its AgentState, and the
    // capture lives here rather than in the Run Layer — which is what stops a post-commit observation
    // and an execution from disagreeing about the policy a batch ran under.
    expect(adapter).toContain("export function captureRunToolTurnFacts(");
    expect(adapter).toContain("workspace: input.snapshot.run.workspace");
    expect(adapter).toContain("runtime: input.snapshot.run.runtime");
    expect(adapter).toContain(
      "securityContext: createToolSecurityContext(input.snapshot.run, state)",
    );
    expect(controller).toContain("captureRunToolTurnFacts({");
    expect(controller).not.toContain("createToolSecurityContext(");
    // The effective mode strengthens and never downgrades.
    expect(adapter).toContain('effectiveMode: requestedMode === "RECOVER" ? "RECOVER" : "EXECUTE"');
    // The observation policy prefers the durable continuation over the host runtime, and it is read
    // from a *function* parameter rather than from a field, so the check is on the resolver's own body
    // and on the one place that consults the host.
    const policy = memberRegion(adapter, "function resolveToolObservationPolicy(");
    expect(policy.length).toBeGreaterThan(0);
    expect(at(policy, "const durable = continuation.observationPolicy;")).toBeLessThan(
      at(policy, "hostObservationPolicy?.()"),
    );
    // And the request identity is verified against the durable continuation, never trusted.
    expect(adapter).toContain("function assertRequestMatchesContext(");
    expect(adapter).toContain("request.sourceStepId !== context.continuation.sourceStepId");
    expect(adapter).toContain("semanticEqual(request.pendingDecision, context.pendingDecision)");
    // The legacy request is built from the durable continuation rather than from the request.
    expect(adapter).toContain("context.pendingDecision.toolRequests");
  });

  it("keeps a Tool settlement CAS from advancing resource progress", () => {
    const controller = executable("packages/core/src/run-controller.ts");

    // Progress is recorded strictly after the commit and its notification.
    const settle = memberRegion(controller, "private async settleCanonicalToolTurn(");
    expect(settle.length).toBeGreaterThan(0);
    expect(at(settle, "await this.commit(materialized)")).toBeLessThan(
      at(settle, "await this.recordToolTurnProgress("),
    );
    expect(at(settle, "this.notify(committed.events)")).toBeLessThan(
      at(settle, "await this.recordToolTurnProgress("),
    );

    // The loop drives the effect, reloads from the durable revision the Tool Layer left behind, and
    // only then settles — which is what keeps a lost settlement CAS from duplicating physical work.
    const loopStart = at(controller, "private async driveRunExecutionLocked(");
    const loop = controller.slice(loopStart);
    expect(at(loop, "const execution = await this.executeToolBatchDirective(")).toBeLessThan(
      at(loop, "await this.settleToolEffect("),
    );
    expect(at(loop, "snapshot = await this.load(snapshot.run.id);")).toBeLessThan(
      at(loop, "await this.settleToolEffect("),
    );
    // Cancellation is re-read after the effect and before any settlement of it.
    expect(loop).toContain("this.finalizeAbortedExecution(snapshot)");

    // A Tool effect that fails does so through the Run failure authority, and the two failure kinds
    // stay distinct: a malformed model batch is a model error, an infrastructure exception is a Tool
    // runtime error whose internal text never becomes a model-facing result.
    const execute = memberRegion(controller, "private async executeToolBatchDirective(");
    expect(execute).toContain("this.failBoundaryLocked(snapshot, agentError, error)");
    expect(execute).toContain('phase: "TOOL" as const');
    expect(execute).toContain('phase: "LLM" as const');
    expect(execute).toContain("error instanceof ToolBatchInputError");
  });
});
