import type { ContextDiagnostic } from "./project-profile.js";
import type { RelevantFileDiscoveryStats } from "./file-discovery.js";
import type { RelevantFileCandidate, RelevantFileQuery, RelevanceReason } from "./relevance.js";

export interface FileContextProvenance {
  readonly kind: "PROJECT_FILE";
  readonly path: string;
  readonly relativePath: string;
  readonly score: number;
  readonly reasons: readonly RelevanceReason[];
}

export interface RelevantFileContextSection {
  readonly provenance: FileContextProvenance;
  readonly content: string;
  readonly estimatedTokens: number;
  readonly bytesIncluded: number;
  readonly truncated: boolean;
}

export interface RelevantFileBudget {
  readonly maxSelectedFiles: number;
  readonly maxTotalTokens: number;
  readonly maxPerFileTokens: number;
  readonly minUsefulFileTokens: number;
}

export interface RelevantFileBudgetReport {
  readonly maxTotalTokens: number;
  readonly maxPerFileTokens: number;
  readonly maxSelectedFiles: number;
  readonly estimatedTokensUsed: number;
  readonly remainingTokens: number;
  readonly selectedFileCount: number;
}

export interface RelevantFileContextPlan {
  readonly query: RelevantFileQuery;
  readonly rankedCandidates: readonly RelevantFileCandidate[];
  readonly sections: readonly RelevantFileContextSection[];
  readonly budget: RelevantFileBudgetReport;
  readonly discovery: RelevantFileDiscoveryStats;
  readonly diagnostics: readonly ContextDiagnostic[];
}
