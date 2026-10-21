/** Stable Context source identity for the daemon's pending correction contribution. */
export const RESOURCE_GOVERNANCE_CORRECTION_PROVIDER_ID =
  "daemon.resource-governance-correction" as const;
export const RESOURCE_GOVERNANCE_CORRECTION_PROVIDER_VERSION =
  "resource-correction-receipt-v1" as const;

/** Bind a selected Context item to one specific pending intervention. */
export function resourceGovernanceCorrectionContextItemId(interventionId: string): string {
  return `daemon.resource-governance:correction:${interventionId}`;
}
