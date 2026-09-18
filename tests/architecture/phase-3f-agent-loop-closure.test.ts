import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 3F Agent Loop closure guards.
 *
 * ```text
 * one production Reason entry        the frozen AgentLoop, composed by the Run Layer
 * one model execution authority      the frozen ModelTurnExecutor
 * one completion composition         the RunCompletionAssembly port
 * one lifecycle commit authority     the RunController
 * one legacy surface                 declared facades with no production execution consumer
 * ```
 *
 * Phase 3F converged the three execution paths and moved composing a completion out of the Run Layer.
 * These guards protect the properties that convergence created, because each of them could be undone
 * by a single plausible-looking edit:
 *
 * ```text
 * a Run Layer that reads a verification* field again     the subsystem's integrator is back
 * a Run Layer that builds a reviewer again               the assembly seam was bypassed
 * a coding host that names the accept-directly gate      "no verifier" silently became "accepted"
 * a production consumer of the legacy loop facade         a second Reason entry exists
 * ```
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

/** The files a host could reach production behaviour through. */
function hostSources(): string[] {
  return sourceFiles(join(root, "apps"))
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .filter((file) => !file.includes("/dist/") && !file.includes("/test/"));
}

const CONTROLLER = "packages/core/src/run-controller.ts";
const ASSEMBLY = "packages/core/src/run-completion-assembly.ts";
const COMPATIBILITY = "packages/core/src/run-completion-compatibility.ts";
const DIRECT_ACCEPT = "packages/agent/src/run/gates/direct-accept-completion-gate.ts";

describe("Phase 3F Agent Loop closure boundaries", () => {
  it("keeps the Run Layer from composing a completion", () => {
    const controller = executable(CONTROLLER);

    // The converged port is the only completion collaborator the Run Layer names.
    expect(controller).toContain(
      "private readonly completionAssembly: RunCompletionAssembly | undefined",
    );
    expect(controller).toContain("resolveRunCompletionAssembly(dependencies)");
    expect(controller).toContain("assembly.openEvaluation({");
    expect(controller).toContain("assembly.planCandidateBoundary({");
    expect(controller).toContain("assembly.compileRepairContext({");

    // It builds no gate, no boundary planner and no reviewer, and it reaches the verification package
    // by no name at all: every one of those was the composition this round moved out.
    for (const forbidden of [
      "new TaskAcceptanceReviewer(",
      "createRunCompletionGate(",
      "createRunCandidateBoundaryPlanner(",
      "compileVerificationRepairContext(",
      "@caelush/verification",
    ]) {
      expect(controller, `run-controller must not contain ${forbidden}`).not.toContain(forbidden);
    }

    // And it reads none of the flat verification group. The fields stay declared on the public
    // interface for compatibility; reading them here would make the Run Layer the integrator again.
    for (const field of [
      "verificationPlanner",
      "verificationPlanIdFactory",
      "verificationCheckIdFactory",
      "verificationRunner",
      "projectProfileProvider",
      "verificationExecution",
      "verificationExecutionStore",
      "verificationExecutionRecovery",
      "verificationWorkspace",
      "verificationGit",
      "verificationSecurity",
      "verificationEvidenceSanitizer",
      "verificationEvidenceIdFactory",
      "verificationResolverRegistry",
      "verificationReviewer",
      "verificationModelTurns",
      "verificationRepairPolicy",
      "verificationPlanCount",
    ]) {
      expect(controller, `run-controller must not read ${field}`).not.toContain(field);
    }

    // One port, three operations, and no lifecycle write behind it.
    const assembly = executable(ASSEMBLY);
    for (const forbidden of [
      "commitVerifiedCompletion",
      "commitCandidateBoundary",
      "AgentRunSchema.parse",
      "this.commit(",
    ]) {
      expect(assembly, `the assembly must not ${forbidden}`).not.toContain(forbidden);
    }
    // The persistence port and the notifier arrive per evaluation, so the assembly holds neither a
    // store nor a bus of its own.
    expect(assembly).toContain("readonly persistence: CompletionPersistencePort;");
    expect(assembly).toContain(
      "readonly notifyCommitted: (events: readonly DurableAgentEvent[]) => void;",
    );
    expect(assembly).not.toContain("notifyCommitted: dependencies.notifyCommitted");
  });

  it("keeps one coding completion assembly behind the compatibility projection", () => {
    // Exactly one module declares the coding assembly, so no second implementation can be selected.
    const declarers = productionSources().filter((file) =>
      read(file).includes("export function createCodingCompletionAssembly("),
    );
    expect(declarers).toEqual([ASSEMBLY]);

    // The compatibility projection regroups fields and executes nothing: no gate, no reviewer, no
    // store, no lifecycle. A second assembly hiding here would show up as one of these.
    const compatibility = executable(COMPATIBILITY);
    for (const forbidden of [
      "createRunCompletionGate(",
      "new TaskAcceptanceReviewer(",
      "commitVerifiedCompletion",
      "commitCandidateBoundary",
    ]) {
      expect(
        compatibility,
        `the compatibility projection must not contain ${forbidden}`,
      ).not.toContain(forbidden);
    }
    // The canonical port wins, always.
    expect(compatibility).toContain(
      "if (dependencies.completion !== undefined) return dependencies.completion;",
    );

    // `verificationModelTurns` is deliberately absent from the list: it is the *daemon's own*
    // composition property (the explicit-identity model turn client a review executes through), not a
    // Run Layer dependency. What must not appear is any of the flat fields the Run Layer used to read.
    const daemon = executable("apps/daemon/src/daemon-composition.ts");
    expect(daemon).toContain("completion: createCodingCompletionAssembly({");
    for (const field of [
      "verificationPlanner:",
      "verificationPlanIdFactory:",
      "verificationCheckIdFactory:",
      "verificationRunner:",
      "projectProfileProvider:",
      "verificationExecution:",
      "verificationExecutionStore:",
      "verificationExecutionRecovery:",
      "verificationWorkspace:",
      "verificationGit:",
      "verificationSecurity:",
      "verificationEvidenceSanitizer:",
      "verificationEvidenceIdFactory:",
      "verificationResolverRegistry:",
      "verificationReviewer:",
      "verificationRepairPolicy:",
      "verificationPlanCount:",
    ]) {
      expect(daemon, `the daemon must not select ${field}`).not.toContain(field);
    }
  });

  it("never lets the accept-directly gate become a coding fallback", () => {
    // The general gate is real, minimal and dependency-free: it carries the candidate text and answers
    // the frozen union. It may not reach a host fact even to look at it.
    const gate = executable(DIRECT_ACCEPT);
    expect(gate).toContain("export function createDirectAcceptCompletionGate(");
    expect(gate).toContain("export const DIRECT_ACCEPT_COMPLETION_GATE_ID");
    for (const forbidden of [
      "workspace",
      "runtime",
      "store",
      "VerificationPlan",
      "reviewer",
      "fetch(",
      "AgentRunSchema",
      "@caelush/core",
      "@caelush/storage",
      "@caelush/runtime",
      "@caelush/verification",
    ]) {
      expect(gate, `the general gate must not mention ${forbidden}`).not.toContain(forbidden);
    }
    // An aborted evaluation suspends; it never accepts and it has no `CANCELLED` arm to reach for.
    expect(gate).toContain('return { kind: "ERROR", error: suspendedError(), retryable: true };');
    expect(gate).not.toContain('"CANCELLED"');

    // No host application may compose it, and neither may the coding assembly. "The verifier was
    // missing" must never read as "the candidate passed".
    for (const file of [
      ...hostSources(),
      ...productionSources().filter((path) => path.startsWith("packages/core/src/")),
    ]) {
      const source = executable(file);
      expect(source, `${file} must not name the accept-directly gate`).not.toContain(
        "createDirectAcceptCompletionGate",
      );
      expect(source, `${file} must not name the accept-directly gate id`).not.toContain(
        "DIRECT_ACCEPT_COMPLETION_GATE_ID",
      );
    }

    // The general kernel package stays reachable for a general host: the gate is exported publicly and
    // depends on the frozen completion contract alone.
    const kernel = read("packages/agent/src/index.ts");
    expect(kernel).toContain("createDirectAcceptCompletionGate");
    expect(kernel).toContain("DIRECT_ACCEPT_COMPLETION_GATE_ID");
  });

  it("keeps the general kernel free of coding, runtime and storage implementations", () => {
    const manifest = JSON.parse(read("packages/agent/package.json")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@caelush/ai",
      "@caelush/protocol",
    ]);

    for (const file of productionSources().filter((path) =>
      path.startsWith("packages/agent/src/"),
    )) {
      // Executable code only: a doc comment that *names* a forbidden package to explain why the kernel
      // does not depend on it is documentation, not a dependency.
      const source = executable(file);
      for (const forbidden of [
        "@caelush/core",
        "@caelush/storage",
        "@caelush/runtime",
        "@caelush/tools",
        "@caelush/verification",
        "@caelush/coding-agent",
        "@caelush/security",
        "@caelush/context",
      ]) {
        expect(source, `${file} must not depend on ${forbidden}`).not.toContain(forbidden);
      }
      // The Core-private observation is not part of the frozen package and never becomes one.
      expect(source, `${file} must not know the Core-private observation`).not.toContain(
        "CompletionGateObservation",
      );
    }
  });

  it("keeps the legacy facades free of production execution consumers", () => {
    const production = productionSources();

    // The legacy Core `AgentLoop` is a declared public facade with its own tests. Nothing in a host and
    // nothing on the production Agent path may *build* one: a second Reason entry point is exactly what
    // this phase removed. Naming the type in the frozen kernel is a different thing and stays legal.
    const loopBuilders = production.filter(
      (file) =>
        !file.startsWith("packages/core/src/agent-loop.ts") &&
        !file.startsWith("packages/core/src/index.ts") &&
        /new AgentLoop\(/.test(executable(file)),
    );
    expect(loopBuilders).toEqual([]);
    // A host may not reach the facade at all, by class or by factory name.
    for (const file of hostSources()) {
      const source = read(file);
      expect(source, `${file} must not import the legacy Core AgentLoop`).not.toContain(
        "AgentLoop",
      );
    }
    // The one legal importer is Core's own public entry point, which re-exports the facade as the
    // declared compatibility surface. Any *other* module importing it would be a second consumer.
    const loopImports = production.filter(
      (file) =>
        !file.startsWith("packages/core/src/agent-loop.ts") &&
        !file.startsWith("packages/core/src/index.ts") &&
        /from "\.\/agent-loop\.js"/.test(read(file)),
    );
    expect(loopImports).toEqual([]);
    expect(read("packages/core/src/index.ts")).toContain(
      'export { AgentLoop } from "./agent-loop.js";',
    );

    // The throwing model-turn facade has no production construction site either.
    const builders = production.filter(
      (file) =>
        executable(file).includes("createLegacyModelTurnExecutor(") &&
        !file.startsWith("packages/core/src/legacy-model-turn-executor.ts") &&
        !file.startsWith("packages/core/src/index.ts"),
    );
    expect(builders).toEqual([]);

    // Exactly one production *construction* of the frozen executor remains: the daemon's composition
    // root. The kernel module that declares the factory is excluded — it exports the constructor, it
    // does not call it — and the Run Layer receives its executor from the host through
    // `RunAgentExecutionContext`, which is what keeps one model execution authority rather than two.
    const executors = production.filter(
      (file) =>
        !file.startsWith("packages/agent/src/loop/turn/model-turn-executor.ts") &&
        executable(file).includes("createModelTurnExecutor("),
    );
    expect(executors).toEqual(["apps/daemon/src/daemon-composition.ts"]);

    // The pure error mapping has its own module, so the facade's *implementation* file is no longer a
    // dependency of anything that only needs the mapping.
    expect(executable(CONTROLLER)).not.toContain("legacy-model-turn-executor");
    expect(executable("packages/core/src/agent-loop.ts")).not.toContain(
      "./legacy-model-turn-executor.js",
    );
    expect(read("packages/core/src/model-turn-error-mapping.ts")).toContain(
      "export function toModelTurnExecutionError(",
    );
  });

  it("keeps every Agent, Tool and completion effect on the frozen driver", () => {
    const controller = executable(CONTROLLER);

    // Three effects, three driver constructions: one per effect-specific composition, each binding the
    // real port for its own effect and misroute guards for the other two. A fourth would be a second
    // execution path; fewer would mean an effect bypassed the driver.
    const drivers = controller.match(/createRunExecutionDriver\(/g) ?? [];
    expect(drivers).toHaveLength(3);
    // The Agent effect drives the real loop, the Tool effect the run-scoped adapter, the completion
    // effect the resolved gate — and each names a misroute guard for what it must never drive.
    expect(controller).toContain("agentLoop: loop");
    expect(controller).toContain("toolTurns: turnDriver.coordinator");
    expect(controller).toContain("completionGate: resolved.gate");
    expect(controller).toContain("completionGate: MISROUTED_COMPLETION_GATE");
    expect(controller).toContain("toolTurns: MISROUTED_TOOL_TURN_COORDINATOR");
    expect(controller).toContain("agentLoop: MISROUTED_AGENT_LOOP");

    // The Run Layer remains the only lifecycle committer, and both of its completion writes still go
    // through the Core-private completion persistence port.
    expect(controller).toContain("private async commitCandidateBoundary(");
    expect(controller).toContain("persistence.commitCandidateBoundary(command)");
    expect(controller).toContain("private async commitVerifiedCompletion(");
    expect(controller).toContain("persistence.commitVerifiedCompletion({");
  });
});
