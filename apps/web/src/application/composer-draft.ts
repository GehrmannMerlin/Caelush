export interface ComposerDraftBinding {
  readonly ownerKey: string;
  readonly revision: number;
  readonly text: string;
  readonly loading: boolean;
  readonly error?: string | undefined;
}

export function clearComposerDraftError(
  draft: ComposerDraftBinding | undefined,
  ownerKey: string,
): ComposerDraftBinding | undefined {
  if (draft?.ownerKey !== ownerKey || draft.error === undefined) return draft;
  return {
    ownerKey: draft.ownerKey,
    revision: draft.revision,
    text: draft.text,
    loading: draft.loading,
  };
}
