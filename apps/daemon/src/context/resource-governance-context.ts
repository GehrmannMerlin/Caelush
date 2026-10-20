import type { ResourceGovernanceState } from "@caelush/storage";

/**
 * Project only the policy state the model needs; exact accounting stays with RunController.
 *
 * ```text
 * NO_RESOURCE_STATE                        the Run has no resource ledger yet
 * <mode>:<guard state>                     the ordinary accounting summary
 * + PENDING_CORRECTION ...                 advice the Run prepared and has not delivered yet
 * ```
 *
 * The correction line is the delivery channel for repeated-mistake guidance. It is not a second system
 * prompt and it does not restate the Tool schema: it says which Tool was rejected, with which stable
 * code, how many times, and what to do differently — the facts a model needs to change its next call
 * and cannot get from a `NUDGE` label alone.
 *
 * It disappears as soon as a model request carrying it settles, so a Run is never nagged with advice it
 * has already been given, and a failed request re-offers the same advice instead of losing it.
 */
export function projectModelResourceGovernance(state: ResourceGovernanceState | null): string {
  if (state === null) return "NO_RESOURCE_STATE";
  const summary = `${state.mode}:${state.resourceGuardState}`;
  const correction = state.semanticProgress?.correction;
  if (correction === undefined) return summary;
  return [
    summary,
    `PENDING_CORRECTION stage=${correction.stage} tool=${correction.toolName} code=${correction.code} occurrences=${String(correction.occurrences)}`,
    correction.guidance,
  ].join("\n");
}
