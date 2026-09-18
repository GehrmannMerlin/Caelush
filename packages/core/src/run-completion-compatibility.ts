import type {
  CodingCompletionAssemblyDependencies,
  RunCompletionAssembly,
} from "./run-completion-assembly.js";
import { createCodingCompletionAssembly } from "./run-completion-assembly.js";
import type { RunControllerDependencies } from "./run-controller-ports.js";

/**
 * The declared compatibility projection onto the converged completion assembly.
 *
 * ```text
 * BEFORE  RunControllerDependencies.verificationPlanner · verificationRunner · verificationWorkspace
 *         · verificationGit · verificationSecurity · verificationModelTurns · … (18 fields)
 *                 ↓  read, one by one, by the Run Layer
 *         the coding completion gate
 *
 * AFTER   RunControllerDependencies.completion   one port
 *                 ↓
 *         the coding completion assembly, which owns that same group
 * ```
 *
 * Phase 3F converged the Run Layer's dependency surface, and `MIGRATION_EXECUTION_CONTRACT.md` Rule 5
 * says an existing public contract stays available until the deletion stage for its subsystem declares
 * otherwise. So the eighteen flat fields are **not** deleted: they remain a declared, stable part of
 * `RunControllerDependencies`, and this module is the one place that reads them.
 *
 * Two things make this a compatibility adapter rather than a second assembly:
 *
 * ```text
 * it composes nothing          it regroups fields and calls createCodingCompletionAssembly
 * it executes nothing          the gate, the reviewer and the workflow are the canonical ones
 * ```
 *
 * There is exactly one coding completion assembly implementation. A host that supplies `completion`
 * never reaches this module; a host that still supplies the flat group gets the same implementation
 * through it. The exit condition is the deletion stage of the flat group, which is a separately
 * reviewed act — not a side effect of this round.
 */

/**
 * Whether a host composed any part of the flat verification group.
 *
 * A single check, so "did this host configure completion at all" has one answer rather than eighteen
 * optional reads spread through the Run Layer.
 */
export function hasLegacyCompletionGroup(dependencies: RunControllerDependencies): boolean {
  return (
    dependencies.verificationPlanner !== undefined ||
    dependencies.verificationPlanIdFactory !== undefined ||
    dependencies.verificationCheckIdFactory !== undefined ||
    dependencies.verificationRunner !== undefined ||
    dependencies.projectProfileProvider !== undefined ||
    dependencies.verificationExecution !== undefined ||
    dependencies.verificationExecutionStore !== undefined ||
    dependencies.verificationExecutionRecovery !== undefined ||
    dependencies.verificationWorkspace !== undefined ||
    dependencies.verificationGit !== undefined ||
    dependencies.verificationSecurity !== undefined ||
    dependencies.verificationEvidenceSanitizer !== undefined ||
    dependencies.verificationEvidenceIdFactory !== undefined ||
    dependencies.verificationResolverRegistry !== undefined ||
    dependencies.verificationReviewer !== undefined ||
    dependencies.verificationModelTurns !== undefined ||
    dependencies.verificationRepairPolicy !== undefined ||
    dependencies.verificationPlanCount !== undefined
  );
}

/**
 * Regroup the flat verification fields onto the canonical host-fact group.
 *
 * Pure: it reads the fields, names them once and hands them to the one assembly factory. It keeps no
 * state, and it can therefore never become an execution authority of its own.
 */
export function legacyCompletionDependencies(
  dependencies: RunControllerDependencies,
): CodingCompletionAssemblyDependencies {
  return {
    clock: dependencies.clock,
    configResolver: dependencies.configResolver,
    ...(dependencies.verificationPlanner === undefined
      ? {}
      : { planner: dependencies.verificationPlanner }),
    ...(dependencies.verificationPlanIdFactory === undefined
      ? {}
      : { planIdFactory: () => dependencies.verificationPlanIdFactory!.create() }),
    ...(dependencies.verificationCheckIdFactory === undefined
      ? {}
      : { checkIdFactory: () => dependencies.verificationCheckIdFactory!.create() }),
    ...(dependencies.verificationEvidenceIdFactory === undefined
      ? {}
      : { evidenceIdFactory: dependencies.verificationEvidenceIdFactory }),
    ...(dependencies.verificationRunner === undefined
      ? {}
      : { runner: dependencies.verificationRunner }),
    ...(dependencies.projectProfileProvider === undefined
      ? {}
      : { profileProvider: dependencies.projectProfileProvider }),
    ...(dependencies.verificationExecution === undefined
      ? {}
      : { execution: dependencies.verificationExecution }),
    ...(dependencies.verificationExecutionStore === undefined
      ? {}
      : { executionStore: dependencies.verificationExecutionStore }),
    ...(dependencies.verificationExecutionRecovery === undefined
      ? {}
      : { executionRecovery: dependencies.verificationExecutionRecovery }),
    ...(dependencies.verificationWorkspace === undefined
      ? {}
      : { workspace: dependencies.verificationWorkspace }),
    ...(dependencies.verificationGit === undefined ? {} : { git: dependencies.verificationGit }),
    ...(dependencies.verificationSecurity === undefined
      ? {}
      : { security: dependencies.verificationSecurity }),
    ...(dependencies.verificationEvidenceSanitizer === undefined
      ? {}
      : { evidenceSanitizer: dependencies.verificationEvidenceSanitizer }),
    ...(dependencies.verificationResolverRegistry === undefined
      ? {}
      : { resolverRegistry: dependencies.verificationResolverRegistry }),
    ...(dependencies.verificationReviewer === undefined
      ? {}
      : { reviewer: dependencies.verificationReviewer }),
    ...(dependencies.verificationModelTurns === undefined
      ? {}
      : { modelTurns: dependencies.verificationModelTurns }),
    ...(dependencies.verificationRepairPolicy === undefined
      ? {}
      : { repairPolicy: dependencies.verificationRepairPolicy }),
    ...(dependencies.verificationPlanCount === undefined
      ? {}
      : { planCount: dependencies.verificationPlanCount }),
    ...(dependencies.budget === undefined ? {} : { budget: dependencies.budget }),
    ...(dependencies.tokenEstimator === undefined
      ? {}
      : { tokenEstimator: dependencies.tokenEstimator }),
  };
}

/**
 * Resolve the one completion assembly a Run Layer will use.
 *
 * ```text
 * dependencies.completion        the converged port — used verbatim
 * dependencies.completion absent + flat group present   regrouped here
 * neither                        undefined: no completion path was composed
 * ```
 *
 * The canonical port wins. A host that names both is composed against `completion`, so there is never
 * a question about which assembly a decision came from.
 */
export function resolveRunCompletionAssembly(
  dependencies: RunControllerDependencies,
): RunCompletionAssembly | undefined {
  if (dependencies.completion !== undefined) return dependencies.completion;
  if (!hasLegacyCompletionGroup(dependencies)) return undefined;
  return createCodingCompletionAssembly(legacyCompletionDependencies(dependencies));
}
