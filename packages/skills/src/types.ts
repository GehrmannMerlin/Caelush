export interface SkillManifest {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly userInvocable: boolean;
  readonly modelInvocable: boolean;
}

export interface SkillDiagnostic {
  readonly code: string;
  readonly severity: "ERROR" | "WARNING";
  readonly safeMessage: string;
}

export type SkillManifestParseResult =
  | { readonly ok: true; readonly manifest: SkillManifest }
  | { readonly ok: false; readonly diagnostics: readonly SkillDiagnostic[] };

export type SkillScopeRank = 0 | 1 | 2;

export interface SkillCandidate {
  readonly skillId: string;
  readonly manifest: SkillManifest;
  readonly scopeRank: SkillScopeRank;
  readonly providerId: string;
  readonly privateLocator: string;
  readonly bundleRevision?: string;
}

export interface EffectiveSkillCatalog {
  readonly revision: string;
  readonly entries: readonly SkillCandidate[];
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly complete: boolean;
}

/** Safe, body-free metadata copied from one fixed catalog snapshot. */
export interface SkillCatalogSearchEntry {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly displayName?: string;
  readonly searchTerms: readonly string[];
  readonly enabled: boolean;
  readonly userInvocable: boolean;
  readonly modelInvocable: boolean;
}

/** Safe catalog view used by search and the bounded model presentation. */
export interface SkillSearchCatalog {
  readonly revision: string;
  readonly entries: readonly SkillCatalogSearchEntry[];
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly complete: boolean;
}

export type SkillCatalogSearchSource = EffectiveSkillCatalog | SkillSearchCatalog;

export interface SkillDiscoveryResult {
  readonly candidates: readonly SkillCandidate[];
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly complete: boolean;
}
