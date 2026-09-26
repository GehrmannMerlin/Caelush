import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 3E completion authority guards.
 *
 * ```text
 * Coordinator        pure: it decides that a candidate is evaluated next
 * RunExecutionDriver executes one effect, through a port
 * CompletionGate     the production coding verification workflow, behind the frozen contract
 * RunController      the only object that commits a lifecycle transition
 * ```
 *
 * Phase 3E's success criterion is an **authority switch**: the coding verification workflow left the
 * Run Layer and moved behind the frozen `CompletionGate`. These guards are structural, so a later
 * refactor cannot quietly move a `verifyWorkspaceInspection` call back into the Run Layer, widen the
 * frozen completion request with a workspace or a store, replace the typed settlement router with a
 * `catch`, or let a verification plan become part of a general Run snapshot again.
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
  return [...sourceFiles(join(root, "packages")), ...sourceFiles(join(root, "apps"))]
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .filter((file) => !file.includes("/dist/") && !file.includes("/test/"));
}

/** The index of `needle` inside `source`, asserting it is present first. */
function at(source: string, needle: string): number {
  const index = source.indexOf(needle);
  expect(index, `${needle} must be present`).toBeGreaterThan(-1);
  return index;
}

/** The Run Layer's executable source, for guards that span two files. */
function controllerSource(): string {
  return executable("packages/core/src/run-controller.ts");
}

describe("Phase 3E completion authority boundaries", () => {
  it("drives EVALUATE_COMPLETION through the frozen Run execution driver", () => {
    const controller = executable("packages/core/src/run-controller.ts");
    const loop = controller.slice(at(controller, "private async driveRunExecutionLocked("));

    // The completion directive is executed by the driver, over the real run-scoped gate, and the
    // effect is settled by the Run Layer's own typed router.
    expect(loop).toContain('if (directive.kind === "EVALUATE_COMPLETION")');
    expect(loop).toContain("this.completionGate({ snapshot, mode })");
    expect(loop).toContain("await this.executeCompletionDirective(");
    expect(loop).toContain("this.settleCompletionEffect(");
    // The driver call precedes the settlement, and the durable revision the gate left behind is
    // re-read in between — which is what keeps a lost settlement from repeating verification.
    const completionBranch = loop.slice(at(loop, 'if (directive.kind === "EVALUATE_COMPLETION")'));
    expect(at(completionBranch, "await this.executeCompletionDirective(")).toBeLessThan(
      at(completionBranch, "snapshot = await this.load(snapshot.run.id);"),
    );
    expect(at(completionBranch, "snapshot = await this.load(snapshot.run.id);")).toBeLessThan(
      at(completionBranch, "await this.settleCompletionEffect("),
    );

    const execute = controller.slice(
      at(controller, "private async executeCompletionDirective("),
      at(controller, "private async settleCompletionEffect("),
    );
    expect(execute).toContain("createRunExecutionDriver({");
    expect(execute).toContain("completionGate: resolved.gate");
    // A completion evaluation binds misroute guards for the two effects it must never drive.
    expect(execute).toContain("agentLoop: MISROUTED_AGENT_LOOP");
    expect(execute).toContain("toolTurns: MISROUTED_TOOL_TURN_COORDINATOR");
    expect(execute).toContain("turn: { stepId: directive.sourceStepId, sequence: 0 }");
    // A completion evaluation performs no provider turn of its own, so it reports none.
    expect(controller).toContain('providerTurnState: "NOT_STARTED"');
  });

  it("removes every inline verification authority from the RunController", () => {
    const controller = executable("packages/core/src/run-controller.ts");

    // The eleven methods Phase 3E moved out. Each name reappearing would mean the workflow had grown
    // a second home.
    for (const removed of [
      "driveProjectVerificationLocked",
      "driveChangeVerificationLocked",
      "settleStaleVerificationChecksLocked",
      "finalizePassedVerificationLocked",
      "failVerificationLocked",
      "maybeStartVerificationRepairLocked",
      "genericTaskEvidence",
      "persistCompleteToolResultsLocked",
    ]) {
      expect(controller, `run-controller must not declare ${removed}`).not.toContain(removed);
    }

    // And none of the verification subsystem's own functions may be called from the Run Layer: they
    // are the gate's, and the Run Layer must not be able to reach a verification verdict itself.
    for (const forbidden of [
      "VerificationStageRunner",
      "verifyWorkspaceInspection(",
      "reviewGitChangeset(",
      "evaluateVerification(",
      "computeVerificationEvidenceDigest(",
      "createVerificationCompletionSeal(",
      "buildTaskReviewBundle(",
      "repairCycleForPlanCount(",
      "computeWorkspaceFreshnessHash(",
      "computeVerificationCandidateTextHash(",
    ]) {
      expect(controller, `run-controller must not call ${forbidden}`).not.toContain(forbidden);
    }

    // The Run Layer knows the completion gate by exactly one name: the port it asks for an
    // evaluation. Phase 3F moved gate *construction* into the assembly, so the Run Layer building a
    // gate again — anywhere, for any reason — would mean it had gone back to composing verification.
    expect(controller).not.toContain("createRunCompletionGate(");
    expect(controller).not.toContain("createRunCandidateBoundaryPlanner(");
    expect(controller).toContain("this.completionAssembly");
    expect(controller).toContain("assembly.openEvaluation({");
    expect(controller).toContain("assembly.planCandidateBoundary({");
    // And it reaches the verification subsystem by no name at all any more.
    expect(controller).not.toContain("@caelush/verification");

    // The factory is *called* from exactly one production module — the assembly — and exactly once.
    // The declaring module only exports it, so it is excluded from the caller set.
    const gateCreators = productionSources()
      .filter((file) => file !== "packages/core/src/run-completion-gate.ts")
      .filter((file) => executable(file).includes("createRunCompletionGate("));
    expect(gateCreators).toEqual(["packages/core/src/run-completion-assembly.ts"]);
    const factories = executable("packages/core/src/run-completion-assembly.ts").match(
      /createRunCompletionGate\(/g,
    );
    expect(factories).toHaveLength(1);
  });

  it("keeps the whole coding verification workflow inside the gate", () => {
    // The gate owns the contract; one module owns the workflow; one module owns the host facts.
    const gate = executable("packages/core/src/run-completion-gate.ts");
    expect(gate).toContain("export const CODING_COMPLETION_GATE_ID");
    expect(gate).toContain("export function createRunCompletionGate(");
    expect(gate).toContain("export function createRunCandidateBoundaryPlanner(");
    // The gate commits no lifecycle transition: it has no store and no Run writer.
    expect(gate).not.toContain("commitVerifiedCompletion");
    expect(gate).not.toContain("AgentRunSchema.parse");

    const workflow = executable("packages/core/src/run-completion-verification.ts");
    for (const moved of [
      "ensureProjectChecks",
      "runChangeChecks",
      "finalizePassed",
      "repairOrReject",
      "settleInterruptedChecks",
      "recheckWorkspaceFreshness",
      "recheckGitFreshness",
    ]) {
      expect(workflow, `the workflow must own ${moved}`).toContain(moved);
    }
    // The verification body is one function the gate calls once.
    const gateCalls = gate.match(/runCompletionVerification\(/g) ?? [];
    expect(gateCalls).toHaveLength(1);

    // The candidate boundary planner is a strict subset of the gate's dependencies, so asking for a
    // plan can never require a verification store, a reviewer or a repair policy. The workspace it
    // receives is the Run's own reference, passed *into* the pure planner — never a port.
    expect(gate).toContain("CandidateBoundaryPlanningDependencies");
    const planningDependencies = gate.slice(
      at(gate, "export interface CandidateBoundaryPlanningDependencies"),
      at(gate, "export const CODING_COMPLETION_GATE_ID"),
    );
    for (const forbidden of ["persistence", "reviewer", "repository", "repairPolicy", "runner"]) {
      expect(
        planningDependencies,
        `the planning dependencies must not declare ${forbidden}`,
      ).not.toContain(forbidden);
    }
    const planning = gate.slice(
      at(gate, "function planCandidateBoundary("),
      at(gate, "async function evaluateCompletion("),
    );
    // It mints identity and asks the pure planner which checks the Run needs: nothing else.
    expect(planning).toContain("dependencies.planIdFactory?.()");
    expect(planning).toContain("checkIdFactory()");
    expect(planning).not.toContain("await ");
  });

  it("keeps the frozen completion contract free of host facts", () => {
    const port = read("packages/agent/src/run/ports/completion-gate.ts");

    // The request carries the identity, the source Step, the candidate, the mode and the signal — and
    // nothing a host owns.
    for (const forbidden of [
      "workspace",
      "runtime",
      "cwd",
      "store",
      "verificationPlan",
      "changedFiles",
      "repairPolicy",
      "budget",
      "reviewer",
      "git",
      "securityContext",
    ]) {
      expect(port, `CompletionGateInput must not carry ${forbidden}`).not.toContain(
        `readonly ${forbidden}`,
      );
    }

    // The decision union is exactly the four frozen arms, and no failure vocabulary was added.
    const decision = port.slice(
      at(port, "export type CompletionGateDecision"),
      at(port, "export type AgentCompletionResult") > at(port, "export type CompletionGateDecision")
        ? at(port, "export interface CompletionRepairRequest")
        : port.length,
    );
    for (const kind of ['"ACCEPT"', '"REPAIR"', '"REJECT"', '"ERROR"']) {
      expect(decision, `CompletionGateDecision must declare ${kind}`).toContain(kind);
    }
    for (const forbidden of [
      "DEFER",
      "SUSPEND",
      "WORKSPACE_NOT_FRESH",
      "VERIFICATION_FAILED",
      "retryAfterMs",
    ]) {
      expect(decision, `CompletionGateDecision must not declare ${forbidden}`).not.toContain(
        forbidden,
      );
    }
    // The retryable flag is the whole suspension vocabulary.
    expect(decision).toContain("readonly retryable: boolean;");

    // The Core-private observation is not part of the frozen package.
    const agentSources = sourceFiles(join(root, "packages/agent/src")).map((path) =>
      relative(root, path).replaceAll("\\", "/"),
    );
    for (const file of agentSources) {
      expect(read(file), `${file} must not know the Core-private observation`).not.toContain(
        "CompletionGateObservation",
      );
    }
    // It is declared where it belongs, and it is mutable on purpose: the gate fills it in as it goes.
    const observation = executable("packages/core/src/run-completion-observation.ts");
    expect(observation).toContain("export interface CompletionGateObservation");
    expect(observation).not.toContain("readonly plan?");
  });

  it("routes every completion effect to exactly one typed settlement authority", () => {
    const router = executable("packages/core/src/run-completion-effect-settlement.ts");

    // Classification reads the frozen decision, the Core-private observation and the Run's own
    // termination verdict — and nothing else.
    expect(router).toContain("readonly decision: CompletionGateDecision;");
    expect(router).toContain("readonly observation: CompletionGateObservation;");
    expect(router).toContain("readonly terminationDecided: boolean;");
    for (const route of [
      "CANONICAL_ACCEPT",
      "CANONICAL_REJECT",
      "REPAIR_COMPATIBILITY",
      "RETRYABLE_ERROR_SUSPEND",
      "TERMINATION_AUTHORITY",
    ]) {
      expect(router, route).toContain(route);
    }
    // Termination outranks every decision, and it is resolved before classification.
    expect(at(router, "if (input.terminationDecided) return")).toBeLessThan(
      at(router, "switch (decision.kind)"),
    );
    // No message parsing decides a route, and no branch is caught into a second authority.
    expect(router).not.toContain(".message");
    expect(router).not.toContain("catch");
    expect(router).toContain("assertNeverCompletionDecision");
    // The repair provenance is refused rather than defaulted, and so is the repair cycle.
    expect(router).toContain("requireObservationField");
    expect(router).toContain("requireRepairCycle");
  });

  it("keeps the verification plan out of every general Run contract", () => {
    // The general store port is the canonical agent port: no plan, no verified completion.
    const store = executable("packages/core/src/run-execution-store.ts");
    expect(store).not.toContain("loadVerificationPlan");
    expect(store).not.toContain("commitVerifiedCompletion");
    expect(store).not.toContain("commitCandidateBoundary");
    expect(store).not.toContain("verificationPlan");
    // The snapshot and commit views are the canonical shapes, not widened ones.
    expect(store).toContain("export type RunExecutionSnapshotView = RunExecutionSnapshot;");
    expect(store).toContain("export type RunExecutionCommitView = RunExecutionCommit;");

    // Completion persistence is its own Core-private port, and it is what names a plan.
    const completion = executable("packages/core/src/run-completion-store.ts");
    expect(completion).toContain("export interface RunCompletionPersistencePort");
    expect(completion).toContain("loadVerificationPlan(");
    expect(completion).toContain("commitCandidateBoundary(");
    expect(completion).toContain("commitVerifiedCompletion(");

    // The durable store implements both, and the plan is re-read inside the completion transaction.
    const sqlite = executable("packages/storage/src/run-execution-store.ts");
    expect(sqlite).toContain("implements RunExecutionStorePort, RunCompletionPersistencePort");
    expect(sqlite).toContain("loadVerificationPlanInTransaction(");
    // Storage must not reach for the verification package to compute a candidate hash.
    expect(sqlite).not.toContain("@caelush/verification");
  });

  it("keeps the verified completion the only thing that can complete a Run", () => {
    const controller = executable("packages/core/src/run-controller.ts");

    // `run.completed` is materialized from the Core-private completion evidence, and only when the
    // decision and the observation describe the same sealed result.
    const evidence = controller.slice(
      at(controller, "private completionEventEvidence("),
      at(controller, "private async settleVerificationRepair("),
    );
    expect(evidence).toContain("observation.verifiedFinalResult");
    expect(evidence).toContain("observation.seal?.sealHash");
    expect(evidence).toContain("semanticEqual(decision.finalResult, verifiedFinalResult)");
    expect(evidence).toContain("verifiedFinalResult.verification.sealHash !== sealHash");

    const materializer = executable("packages/core/src/run-commit-event-materializer.ts");
    expect(materializer).toContain("completionOutcome(effect.result)");
    // The success order is the frozen one: the verdict precedes the status it caused, which precedes
    // the terminal event.
    expect(at(materializer, "events.verificationFinalized(")).toBeLessThan(
      at(materializer, "events.statusChanged("),
    );
    expect(at(materializer, "events.statusChanged(")).toBeLessThan(
      at(materializer, "events.completed("),
    );
    // A completion is reported as verified only when the accepted result and the seal agree.
    expect(materializer).toContain(
      'after.status === "COMPLETED" && input.completion !== undefined',
    );

    // A completion commit goes through the completion persistence port, which re-validates the plan
    // and the Run inside the transaction.
    const commit = controller.slice(
      at(controller, "private async commitVerifiedCompletion("),
      at(controller, "private completionEventEvidence("),
    );
    expect(commit).toContain("persistence.commitVerifiedCompletion({");
    expect(commit).toContain("finalResult,");
    expect(commit).toContain("verificationPlan: plan,");
    // A verification conflict stays a conflict rather than becoming an infrastructure failure.
    expect(commit).toContain("error instanceof RunExecutionConflictError");
    // A retryable suspension commits nothing at all.
    const settle = controller.slice(
      at(controller, "private async settleCompletionEffect("),
      at(controller, "private async settleCanonicalCompletion("),
    );
    expect(settle).toContain('case "RETRYABLE_ERROR_SUSPEND":');
    expect(settle).toContain(
      'return { kind: "RESULT", result: this.resultFromSnapshot(current) };',
    );
  });

  it("keeps the plan bound to the candidate the boundary wrote", () => {
    const gate = executable("packages/core/src/run-completion-gate.ts");

    // The frozen request is validated against the durable Run before any verification runs.
    expect(gate).toContain("function assertInputMatchesRun(");
    expect(gate).toContain("input.identity.runId !== dependencies.run.id");
    expect(gate).toContain("input.sourceStepId !== dependencies.continuation.sourceStepId");
    expect(gate).toContain(
      "input.candidate.candidateText !== dependencies.continuation.finalDecision.candidateText",
    );
    expect(gate).toContain(
      "input.candidate.modelTurn.callId !== dependencies.continuation.finalDecision.modelTurn.callId",
    );
    // A refusal is loud rather than a fabricated verdict.
    expect(gate).toContain("CompletionGateIdentityError");
    expect(gate).toContain("CompletionGateInfrastructureError");
    // And an undecidable completion suspends instead of failing the Run.
    expect(gate).toContain("retryable: true");
    expect(gate).toContain("function suspended(");

    // The plan is loaded by the identity the continuation names, and refused when it is not this
    // Run's.
    expect(gate).toContain("dependencies.continuation.verificationPlanId");
    expect(gate).toContain("plan.sourceStepId !== dependencies.continuation.sourceStepId");
    // The candidate hash the plan binds is the candidate's own text hash.
    expect(gate).toContain("computeVerificationCandidateTextHash(input.candidate.candidateText)");
    expect(gate).toContain("plan.candidateHash !== candidateHash");
  });

  it("keeps the daemon the composition root for the completion gate", () => {
    const daemon = executable("apps/daemon/src/daemon-composition.ts");

    // The daemon supplies the run-scoped host facts the frozen request deliberately omits, and it does
    // so by composing the one assembly the Run Layer names. Phase 3F moved these keys under
    // `completion:`; every host fact the gate needs is still supplied here and nowhere else.
    for (const port of [
      "createCodingCompletionAssembly({",
      "workspace: verificationWorkspace",
      "git: verificationGit",
      "modelTurns: verificationModelTurns",
      "executionStore: options.storage.verificationExecution",
      "executionRecovery: options.storage.verificationExecution",
      "completionStore: options.storage.execution",
      "evidenceIdFactory: createVerificationEvidenceId",
      "runner: new VerificationRunner()",
      "resolverRegistry: new ProjectCheckResolverRegistry()",
    ]) {
      expect(daemon, `the daemon must compose ${port}`).toContain(port);
    }
    // It selects the canonical port, so no production host selects the flat compatibility group.
    expect(daemon).toContain("completion: createCodingCompletionAssembly({");
    for (const legacyField of [
      "verificationPlanner:",
      "verificationRunner:",
      "verificationWorkspace:",
      "verificationGit:",
      "verificationSecurity:",
      "verificationResolverRegistry:",
      "verificationEvidenceIdFactory:",
      "verificationExecutionStore:",
      "verificationExecutionRecovery:",
    ]) {
      expect(daemon, `the daemon must not select the legacy field ${legacyField}`).not.toContain(
        legacyField,
      );
    }
    // The reviewer is *built by the completion assembly* out of the model turn authority the daemon
    // supplies, so a host that composes one port gets the whole review without composing a second one.
    expect(daemon).not.toContain("new TaskAcceptanceReviewer(");
    expect(executable("packages/core/src/run-completion-assembly.ts")).toContain(
      "new TaskAcceptanceReviewer({",
    );
    expect(executable("packages/core/src/run-completion-assembly.ts")).toContain(
      "modelTurns: dependencies.modelTurns,",
    );
    // The Run Layer must not have grown that reviewer back, nor any of the flat host facts.
    for (const forbidden of [
      "new TaskAcceptanceReviewer(",
      "dependencies.verificationPlanner",
      "dependencies.verificationRunner",
      "dependencies.verificationWorkspace",
      "dependencies.verificationGit",
      "dependencies.verificationSecurity",
      "dependencies.verificationModelTurns",
      "dependencies.verificationResolverRegistry",
    ]) {
      expect(controllerSource(), `run-controller must not read ${forbidden}`).not.toContain(
        forbidden,
      );
    }
    // It composes the completion persistence port the Run Layer names, and the plan is written by the
    // boundary rather than by the daemon.
    expect(daemon).toContain("completionStore: options.storage.execution");
    expect(daemon).not.toContain("verificationStore:");
    // And no global verification turn identity exists to publish: the review names its Run per call.
    expect(daemon).not.toContain("verificationTurnIdentity");
    expect(daemon).not.toContain("activeTurn");
    expect(daemon).toContain("const resolveTurnIdentity = (");
    expect(daemon).toContain("readonly verificationModelTurns: VerificationModelClient;");
  });

  it("retires the legacy model turn facade from production composition", () => {
    // The throw-based facade survives only as the frozen `AgentLoopDependencies` port plus its own
    // tests: no host application and no production path may build one.
    const carriers = productionSources().filter(
      (file) => !file.startsWith("packages/core/src/legacy-model-turn-executor.ts"),
    );
    const creations = carriers.filter(
      (file) =>
        read(file).includes("createLegacyModelTurnExecutor(") &&
        !file.startsWith("packages/core/src/index.ts"),
    );
    expect(creations).toEqual([]);

    // Exactly three production files read an injected `modelTurns`, and they are three different ports
    // that happen to share a field name — which is the whole point of the split:
    //   the frozen Agent loop        the legacy per-turn port
    //   the reviewer                 the explicit-identity client
    //   the completion assembly      the composer that builds the reviewer from the client
    // Phase 3F moved the reviewer's *construction* to the assembly; it did not add a fourth reader and
    // it did not let the Run Layer build one.
    const readers = productionSources().filter(
      (file) =>
        /\bdependencies\.modelTurns\b/.test(executable(file)) &&
        !file.startsWith("packages/core/src/legacy-model-turn-executor.ts"),
    );
    expect(readers).toEqual([
      "packages/core/src/run-completion-assembly.ts",
      "packages/core/src/task-acceptance-reviewer.ts",
    ]);
    expect(controllerSource()).not.toMatch(/\bmodelTurns\b/);

    // The reviewer's port is the explicit-identity client, and it never touches the legacy facade.
    const reviewer = executable("packages/core/src/task-acceptance-reviewer.ts");
    expect(reviewer).toContain("readonly modelTurns: VerificationModelClient;");
    expect(reviewer).toContain("identity: AgentExecutionIdentity;");
    expect(reviewer).not.toContain("LegacyModelTurnExecutor");
    expect(reviewer).not.toContain("resolveTurnIdentity");
    expect(reviewer).not.toContain("createLegacyModelTurnExecutor");

    // The daemon's explicit-identity client is the AI subsystem, used per call.
    const daemon = executable("apps/daemon/src/daemon-composition.ts");
    expect(daemon).not.toContain("modelTurns: LegacyModelTurnExecutor");
    expect(daemon).toContain("verificationModelTurns: VerificationModelClient");
    expect(daemon).toContain("async execute({ identity, request, signal })");
  });

  it("introduces no second lifecycle authority for a verification verdict", () => {
    // Verification produces evidence; only the Run Layer commits a transition. No verification
    // package file may name a Run status or a lifecycle writer.
    for (const file of productionSources().filter((path) =>
      path.startsWith("packages/verification/src/"),
    )) {
      const source = executable(file);
      for (const forbidden of ["RunController", "commitVerifiedCompletion", "@caelush/storage"]) {
        expect(source, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }

    // And the reverse direction holds: the verification package depends on Protocol and nothing else
    // of the Run Layer's.
    for (const file of productionSources().filter((path) =>
      path.startsWith("packages/verification/src/"),
    )) {
      expect(read(file), `${file} must not depend on Core`).not.toContain("@caelush/core");
    }
  });
});
