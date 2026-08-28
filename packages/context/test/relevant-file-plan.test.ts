import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RelevantFileCandidate, RelevantFileQuery } from "../src/relevance.js";
import type {
  FileContextProvenance,
  RelevantFileBudget,
  RelevantFileContextPlan,
  RelevantFileContextSection,
} from "../src/relevant-file-plan.js";

describe("RelevantFileContextPlan", () => {
  it("keeps selected content structured with complete provenance", () => {
    const query: RelevantFileQuery = { text: "fix parser", explicitPaths: ["src/parser.ts"] };
    const candidate: RelevantFileCandidate = {
      path: path.resolve("/repo/src/parser.ts"),
      relativePath: "src/parser.ts",
      fileName: "parser.ts",
      extension: ".ts",
      depth: 1,
      score: 1000,
      reasons: ["EXPLICIT_PATH_EXACT"],
    };
    const provenance: FileContextProvenance = {
      kind: "PROJECT_FILE",
      path: candidate.path,
      relativePath: candidate.relativePath,
      score: candidate.score,
      reasons: candidate.reasons,
    };
    const section: RelevantFileContextSection = {
      provenance,
      content: "export function parse() {}",
      estimatedTokens: 9,
      bytesIncluded: 27,
      truncated: false,
    };
    const budget: RelevantFileBudget = {
      maxSelectedFiles: 1,
      maxTotalTokens: 12,
      maxPerFileTokens: 12,
      minUsefulFileTokens: 1,
    };
    const plan: RelevantFileContextPlan = {
      query,
      rankedCandidates: [candidate],
      sections: [section],
      budget: {
        ...budget,
        estimatedTokensUsed: 9,
        remainingTokens: 3,
        selectedFileCount: 1,
      },
      discovery: {
        visitedEntries: 1,
        candidateFiles: 1,
        ignoredEntries: 0,
        hardExcludedEntries: 0,
        sensitiveSkipped: 0,
        binarySkipped: 0,
        symlinkSkipped: 0,
        nonTextSkipped: 0,
        readFailures: 0,
        truncatedByLimit: false,
      },
      diagnostics: [],
    };

    expect(plan.sections[0]).toEqual(section);
    expect(plan.sections[0]?.provenance.relativePath).toBe("src/parser.ts");
    expect(plan).not.toHaveProperty("llmRequest");
  });
});
