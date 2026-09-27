import {
  createDeterministicCompactionFacts,
  type DeterministicCompactionFacts,
  type DeterministicCompactionFactsProvider,
} from "@caelush/agent";
import { projectCodingCompactionFacts, type CodingCompactionFacts } from "@caelush/coding-agent";
import type { CaelushStorage } from "@caelush/storage";

type DurableFactsStorage = Pick<
  CaelushStorage,
  | "toolInvocations"
  | "observations"
  | "runStates"
  | "approvals"
  | "verification"
  | "resourceGovernance"
>;

export function createDeterministicCompactionFactsProvider(options: {
  readonly storage: DurableFactsStorage;
  readonly codingProjector?: (
    input: Parameters<typeof projectCodingCompactionFacts>[0],
  ) => CodingCompactionFacts;
}): DeterministicCompactionFactsProvider {
  const codingProjector = options.codingProjector ?? projectCodingCompactionFacts;
  return Object.freeze({
    async collect(
      input: Parameters<DeterministicCompactionFactsProvider["collect"]>[0],
    ): Promise<DeterministicCompactionFacts> {
      throwIfAborted(input.signal);
      const [invocations, observations, state, approvals, plan, resources] = await Promise.all([
        options.storage.toolInvocations.listByRun(input.identity.runId),
        options.storage.observations.listByRun(input.identity.runId),
        options.storage.runStates.get(input.identity.runId),
        options.storage.approvals.listPendingByRun(input.identity.runId),
        options.storage.verification.getLatestPlan(input.identity.runId),
        options.storage.resourceGovernance.get(input.identity.runId),
      ]);
      throwIfAborted(input.signal);
      const coding = codingProjector({ invocations, observations, state });
      return createDeterministicCompactionFacts({
        ...coding,
        pendingApprovals: approvals
          .slice(0, 64)
          .map((approval) => `${approval.id}:${approval.toolInvocationId}:${approval.riskLevel}`),
        verificationState:
          plan === null
            ? "NO_VERIFICATION_PLAN"
            : `plan=${plan.id} checks=${plan.checks.map((check) => `${check.spec.kind}:${check.status}`).join(",")}`,
        resourceGovernance:
          resources === null
            ? "NO_RESOURCE_STATE"
            : `${resources.mode}:${resources.resourceGuardState}:turns=${String(resources.agentTurnsConsumed)}:tools=${String(resources.toolOperationsConsumed)}`,
      });
    },
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Deterministic compaction facts were cancelled.");
  error.name = "AbortError";
  throw error;
}
