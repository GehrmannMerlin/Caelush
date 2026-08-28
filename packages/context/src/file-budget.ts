import path from "node:path";
import { ContextError } from "./errors.js";
import type { ContextFileSystem } from "./filesystem.js";
import type { ContextDiagnostic } from "./project-profile.js";
import type { RelevantFileCandidate } from "./relevance.js";
import type {
  FileContextProvenance,
  RelevantFileBudget,
  RelevantFileBudgetReport,
  RelevantFileContextSection,
} from "./relevant-file-plan.js";
import type { TokenEstimator } from "./token-estimator.js";

const MAX_READ_BYTES = 262144;

export const defaultRelevantFileBudget: RelevantFileBudget = Object.freeze({
  maxSelectedFiles: 12,
  maxTotalTokens: 12000,
  maxPerFileTokens: 4000,
  minUsefulFileTokens: 128,
});

export interface FileBudgetSelectorDependencies {
  readonly filesystem: ContextFileSystem;
  readonly estimator: TokenEstimator;
}

export interface FileBudgetSelectionResult {
  readonly sections: readonly RelevantFileContextSection[];
  readonly budget: RelevantFileBudgetReport;
  readonly diagnostics: readonly ContextDiagnostic[];
  readonly nonTextSkipped: number;
  readonly readFailures: number;
}

function budgetError(message: string): ContextError {
  return new ContextError("INVALID_FILE_BUDGET", message);
}

export function validateRelevantFileBudget(
  input: RelevantFileBudget | undefined,
): RelevantFileBudget {
  const budget = input ?? defaultRelevantFileBudget;
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw budgetError(`${name} must be a positive safe integer`);
    }
  }
  if (budget.maxPerFileTokens > budget.maxTotalTokens) {
    throw budgetError("maxPerFileTokens must not exceed maxTotalTokens");
  }
  return budget;
}

function diagnostic(code: string, message: string, targetPath: string): ContextDiagnostic {
  return { code, severity: "WARNING", message, path: targetPath };
}

function maxReadBytes(tokenBudget: number): number {
  return tokenBudget >= Math.ceil(MAX_READ_BYTES / 3)
    ? MAX_READ_BYTES
    : Math.max(1, tokenBudget * 3);
}

function lineSafePrefix(text: string): string {
  const lastNewline = text.lastIndexOf("\n");
  return lastNewline < 0 ? text : text.slice(0, lastNewline + 1);
}

function fitTextToTokens(
  text: string,
  maxTokens: number,
  estimator: TokenEstimator,
): { readonly text: string; readonly truncated: boolean } {
  if (estimator.estimateText(text) <= maxTokens) return { text, truncated: false };
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const prefix = characters.slice(0, middle).join("");
    if (estimator.estimateText(prefix) <= maxTokens) {
      best = prefix;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const safe = lineSafePrefix(best);
  return {
    text: safe.length === 0 && best.length > 0 && !best.includes("\n") ? best : safe,
    truncated: true,
  };
}

function provenance(candidate: RelevantFileCandidate): FileContextProvenance {
  return {
    kind: "PROJECT_FILE",
    path: candidate.path,
    relativePath: candidate.relativePath,
    score: candidate.score,
    reasons: candidate.reasons,
  };
}

function report(
  budget: RelevantFileBudget,
  estimatedTokensUsed: number,
  selectedFileCount: number,
): RelevantFileBudgetReport {
  return {
    maxTotalTokens: budget.maxTotalTokens,
    maxPerFileTokens: budget.maxPerFileTokens,
    maxSelectedFiles: budget.maxSelectedFiles,
    estimatedTokensUsed,
    remainingTokens: budget.maxTotalTokens - estimatedTokensUsed,
    selectedFileCount,
  };
}

export class FileBudgetSelector {
  constructor(private readonly dependencies: FileBudgetSelectorDependencies) {}

  async select(
    rankedCandidates: readonly RelevantFileCandidate[],
    inputBudget?: RelevantFileBudget,
  ): Promise<FileBudgetSelectionResult> {
    const budget = validateRelevantFileBudget(inputBudget);
    const sections: RelevantFileContextSection[] = [];
    const diagnostics: ContextDiagnostic[] = [];
    let estimatedTokensUsed = 0;
    let nonTextSkipped = 0;
    let readFailures = 0;

    for (const candidate of rankedCandidates) {
      if (sections.length >= budget.maxSelectedFiles) break;
      const remainingTokens = budget.maxTotalTokens - estimatedTokensUsed;
      if (remainingTokens < budget.minUsefulFileTokens) break;
      const fileTokenBudget = Math.min(budget.maxPerFileTokens, remainingTokens);
      if (fileTokenBudget < budget.minUsefulFileTokens) break;
      let file;
      try {
        file = await this.dependencies.filesystem.readTextFile(candidate.path, {
          maxBytes: maxReadBytes(fileTokenBudget),
        });
      } catch (error) {
        const invalidUtf8 =
          error instanceof Error && /invalid UTF-?8|encoded data/i.test(error.message);
        if (invalidUtf8) nonTextSkipped += 1;
        else readFailures += 1;
        diagnostics.push(
          diagnostic(
            invalidUtf8 ? "NON_TEXT_FILE_SKIPPED" : "FILE_READ_FAILURE",
            error instanceof Error ? error.message : "file could not be read",
            candidate.path,
          ),
        );
        continue;
      }
      if (file.text.includes("\0")) {
        nonTextSkipped += 1;
        diagnostics.push(diagnostic("NON_TEXT_FILE_SKIPPED", "file contains NUL", candidate.path));
        continue;
      }
      if (file.text.trim() === "") {
        diagnostics.push(
          diagnostic("EMPTY_FILE_SKIPPED", "file is empty or whitespace-only", candidate.path),
        );
        continue;
      }
      const lineSafeText = file.truncated ? lineSafePrefix(file.text) : file.text;
      const fitted = fitTextToTokens(lineSafeText, fileTokenBudget, this.dependencies.estimator);
      if (fitted.text.trim() === "") {
        nonTextSkipped += 1;
        diagnostics.push(
          diagnostic(
            "NON_TEXT_FILE_SKIPPED",
            "file has no useful text within budget",
            candidate.path,
          ),
        );
        continue;
      }
      const estimatedTokens = this.dependencies.estimator.estimateText(fitted.text);
      if (estimatedTokens < budget.minUsefulFileTokens || estimatedTokens > fileTokenBudget) {
        if (estimatedTokens < budget.minUsefulFileTokens) {
          nonTextSkipped += 1;
          diagnostics.push(
            diagnostic(
              "NON_TEXT_FILE_SKIPPED",
              "file is below the minimum useful token threshold",
              candidate.path,
            ),
          );
        }
        continue;
      }
      sections.push({
        provenance: provenance(candidate),
        content: fitted.text,
        estimatedTokens,
        bytesIncluded: Buffer.byteLength(fitted.text, "utf8"),
        truncated: file.truncated || fitted.truncated,
      });
      estimatedTokensUsed += estimatedTokens;
    }

    return {
      sections,
      budget: report(budget, estimatedTokensUsed, sections.length),
      diagnostics,
      nonTextSkipped,
      readFailures,
    };
  }
}

export { MAX_READ_BYTES };
