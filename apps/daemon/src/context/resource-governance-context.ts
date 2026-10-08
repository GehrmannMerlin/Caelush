import type { ResourceGovernanceState } from "@caelush/storage";

/** Project only the policy state the model needs; exact accounting stays with RunController. */
export function projectModelResourceGovernance(state: ResourceGovernanceState | null): string {
  return state === null ? "NO_RESOURCE_STATE" : `${state.mode}:${state.resourceGuardState}`;
}
