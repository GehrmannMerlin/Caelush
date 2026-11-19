import type { SkillCapabilityResponse } from "@caelush/protocol";

export interface ComposerDraftLoadingInput {
  readonly hasOwner: boolean;
  readonly attachmentDraftStoreAvailable: boolean;
  readonly attachmentBindingReady: boolean;
  readonly attachmentBindingLoading: boolean;
  readonly skillsAvailable: boolean;
  readonly skillBindingReady: boolean;
}

export type SkillCapabilityReadState =
  | { readonly status: "PENDING" }
  | { readonly status: "FAILED" }
  | { readonly status: "UNAVAILABLE"; readonly capabilities?: SkillCapabilityResponse | undefined }
  | { readonly status: "AVAILABLE"; readonly capabilities: SkillCapabilityResponse };

export function resolveSkillCapabilityReadState(
  capabilities: SkillCapabilityResponse | null,
): SkillCapabilityReadState {
  return capabilities?.enabled === true && capabilities.catalog && capabilities.invocation
    ? { status: "AVAILABLE", capabilities }
    : { status: "UNAVAILABLE", ...(capabilities === null ? {} : { capabilities }) };
}

export function canSubmitManualSkillSelections(
  state: SkillCapabilityReadState,
  selectionCount: number,
): boolean {
  return selectionCount === 0 || state.status === "AVAILABLE";
}

export function isComposerDraftLoading(input: ComposerDraftLoadingInput): boolean {
  if (!input.hasOwner) return false;
  return (
    (input.attachmentDraftStoreAvailable &&
      (!input.attachmentBindingReady || input.attachmentBindingLoading)) ||
    (input.skillsAvailable && !input.skillBindingReady)
  );
}

export function canOpenSkillManager(
  capabilities: SkillCapabilityResponse | undefined,
  managementMethodsAvailable: boolean,
): boolean {
  return (
    managementMethodsAvailable && capabilities?.enabled === true && capabilities.catalog === true
  );
}

export function claimSkillPreparationRefresh(
  requested: Set<string>,
  ownerKey: string,
  runId: string,
  submissionId: string,
  draftVersion: number,
): boolean {
  const key = JSON.stringify([ownerKey, runId, submissionId, draftVersion]);
  if (requested.has(key)) return false;
  requested.add(key);
  return true;
}
