import path from "node:path";
import type { CandidateFile } from "./file-discovery.js";
import type { ProjectIntelligenceSnapshot } from "./snapshot.js";
import { isWithinWorkspace } from "./workspace.js";

export interface RelevantFileQuery {
  readonly text: string;
  readonly explicitPaths?: readonly string[];
}

export type RelevanceReason =
  | "EXPLICIT_PATH_EXACT"
  | "EXPLICIT_BASENAME"
  | "QUERY_BASENAME"
  | "QUERY_STEM"
  | "QUERY_PATH_SEGMENT"
  | "QUERY_SUBSTRING"
  | "CWD_SUBTREE"
  | "ACTIVE_PACKAGE"
  | "SAME_DIRECTORY_AS_CWD"
  | "TEST_SOURCE_PAIR"
  | "COMMON_ENTRYPOINT"
  | "PROJECT_DOCUMENT"
  | "DEPTH_PENALTY";

export interface RelevantFileCandidate extends CandidateFile {
  readonly score: number;
  readonly reasons: readonly RelevanceReason[];
}

export interface RelevantPathRankerOptions {
  readonly maxRankedCandidatesReturned?: number;
}

const commonEntrypoints = new Set(["index", "main", "app", "server", "cli"]);
const projectDocuments = new Set(["readme.md", "contributing.md", "architecture.md"]);

const reasonOrder: readonly RelevanceReason[] = [
  "EXPLICIT_PATH_EXACT",
  "EXPLICIT_BASENAME",
  "CWD_SUBTREE",
  "ACTIVE_PACKAGE",
  "SAME_DIRECTORY_AS_CWD",
  "TEST_SOURCE_PAIR",
  "COMMON_ENTRYPOINT",
  "PROJECT_DOCUMENT",
  "QUERY_BASENAME",
  "QUERY_STEM",
  "QUERY_PATH_SEGMENT",
  "QUERY_SUBSTRING",
  "DEPTH_PENALTY",
];

function normalizePath(targetPath: string): string {
  return targetPath.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function tokenizeRelevantQuery(text: string): readonly string[] {
  const camelSeparated = text.replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2");
  return unique(
    [...camelSeparated.matchAll(/[\p{L}\p{N}]+/gu)]
      .map((match) => match[0]?.toLowerCase() ?? "")
      .filter((term) => term.length >= 2),
  );
}

function candidateSegments(candidate: CandidateFile): readonly string[] {
  return tokenizeRelevantQuery(candidate.relativePath.replaceAll("\\", "/"));
}

function fileStem(fileName: string): string {
  const extension = path.extname(fileName);
  const withoutExtension = extension === "" ? fileName : fileName.slice(0, -extension.length);
  return withoutExtension.replace(/\.(?:test|spec)$/i, "").toLowerCase();
}

function explicitRelativePaths(
  explicitPaths: readonly string[] | undefined,
  projectRoot: string,
): readonly string[] {
  return (explicitPaths ?? []).map((targetPath) =>
    normalizePath(
      path.isAbsolute(targetPath) ? path.relative(projectRoot, targetPath) : targetPath,
    ),
  );
}

function isTestFile(fileName: string): boolean {
  return /(?:\.test|\.spec)\.[^.]+$/i.test(fileName);
}

function pairStem(fileName: string): string {
  return fileStem(fileName);
}

function hasTestSourcePair(candidate: CandidateFile, explicitPaths: readonly string[]): boolean {
  const candidateStem = pairStem(candidate.fileName);
  for (const explicitPath of explicitPaths) {
    const explicitName = path.basename(explicitPath);
    const explicitStem = pairStem(explicitName);
    if (
      candidateStem === explicitStem &&
      isTestFile(candidate.fileName) !== isTestFile(explicitName)
    ) {
      return true;
    }
  }
  return false;
}

function addReason(reasons: Set<RelevanceReason>, reason: RelevanceReason): void {
  reasons.add(reason);
}

function activePackageDirectory(snapshot: ProjectIntelligenceSnapshot): string | undefined {
  const packagePath = snapshot.profile.activePackage?.path;
  return packagePath === undefined ? undefined : path.dirname(packagePath);
}

function scoreQueryTerms(
  candidate: CandidateFile,
  terms: readonly string[],
  reasons: Set<RelevanceReason>,
): number {
  const normalizedFileName = candidate.fileName.toLowerCase();
  const normalizedBaseName = path
    .basename(candidate.fileName, path.extname(candidate.fileName))
    .toLowerCase();
  const normalizedStem = fileStem(candidate.fileName);
  const normalizedPath = candidate.relativePath.toLowerCase();
  const segments = candidateSegments(candidate);
  let score = 0;
  for (const term of terms) {
    let matchScore = 0;
    let matchReason: RelevanceReason | undefined;
    if (term === normalizedFileName || term === normalizedBaseName) {
      matchScore = 220;
      matchReason = "QUERY_BASENAME";
    } else if (term === normalizedStem) {
      matchScore = 180;
      matchReason = "QUERY_STEM";
    } else if (segments.includes(term)) {
      matchScore = 100;
      matchReason = "QUERY_PATH_SEGMENT";
    } else if (normalizedPath.includes(term)) {
      matchScore = 30;
      matchReason = "QUERY_SUBSTRING";
    }
    if (matchReason !== undefined) {
      score += matchScore;
      addReason(reasons, matchReason);
    }
    if (score >= 500) return 500;
  }
  return score;
}

function rankScore(
  candidate: CandidateFile,
  query: RelevantFileQuery,
  snapshot: ProjectIntelligenceSnapshot,
): { score: number; reasons: readonly RelevanceReason[] } {
  const reasons = new Set<RelevanceReason>();
  const projectRoot = snapshot.projectRoot.projectRoot;
  const explicitPaths = explicitRelativePaths(query.explicitPaths, projectRoot);
  const candidatePath = normalizePath(candidate.relativePath);
  const explicitExact = explicitPaths.includes(candidatePath);
  const explicitBasename = explicitPaths.some(
    (explicitPath) =>
      path.basename(explicitPath).toLowerCase() === candidate.fileName.toLowerCase(),
  );
  let score = 0;
  if (explicitExact) {
    score += 1000;
    addReason(reasons, "EXPLICIT_PATH_EXACT");
  } else if (explicitBasename) {
    score += 300;
    addReason(reasons, "EXPLICIT_BASENAME");
  }

  const cwd = snapshot.workspace.realCwd;
  if (isWithinWorkspace(cwd, candidate.path)) {
    score += 140;
    addReason(reasons, "CWD_SUBTREE");
  }
  const activePackage = activePackageDirectory(snapshot);
  if (activePackage !== undefined && isWithinWorkspace(activePackage, candidate.path)) {
    score += 120;
    addReason(reasons, "ACTIVE_PACKAGE");
  }
  if (path.dirname(candidate.path) === cwd) {
    score += 80;
    addReason(reasons, "SAME_DIRECTORY_AS_CWD");
  }
  if (hasTestSourcePair(candidate, explicitPaths)) {
    score += 120;
    addReason(reasons, "TEST_SOURCE_PAIR");
  }
  const stem = fileStem(candidate.fileName);
  if (commonEntrypoints.has(stem)) {
    score += 25;
    addReason(reasons, "COMMON_ENTRYPOINT");
  }
  if (projectDocuments.has(candidate.fileName.toLowerCase())) {
    score += 20;
    addReason(reasons, "PROJECT_DOCUMENT");
  }
  score += scoreQueryTerms(candidate, tokenizeRelevantQuery(query.text), reasons);
  const depthPenalty = Math.min(40, candidate.depth * 2);
  if (depthPenalty > 0) {
    score -= depthPenalty;
    addReason(reasons, "DEPTH_PENALTY");
  }
  return {
    score: Math.max(0, score),
    reasons: reasonOrder.filter((reason) => reasons.has(reason)),
  };
}

export class RelevantPathRanker {
  private readonly maxRankedCandidatesReturned: number;

  constructor(options: RelevantPathRankerOptions = {}) {
    const value = options.maxRankedCandidatesReturned ?? 100;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("maxRankedCandidatesReturned must be a positive safe integer");
    }
    this.maxRankedCandidatesReturned = value;
  }

  rank(
    candidates: readonly CandidateFile[],
    query: RelevantFileQuery,
    snapshot: ProjectIntelligenceSnapshot,
  ): readonly RelevantFileCandidate[] {
    return candidates
      .map((candidate) => ({ candidate, ...rankScore(candidate, query, snapshot) }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          Number(
            !(
              activePackageDirectory(snapshot) !== undefined &&
              isWithinWorkspace(activePackageDirectory(snapshot) as string, left.candidate.path)
            ),
          ) -
            Number(
              !(
                activePackageDirectory(snapshot) !== undefined &&
                isWithinWorkspace(activePackageDirectory(snapshot) as string, right.candidate.path)
              ),
            ) ||
          left.candidate.depth - right.candidate.depth ||
          normalizePath(left.candidate.relativePath).localeCompare(
            normalizePath(right.candidate.relativePath),
          ),
      )
      .slice(0, this.maxRankedCandidatesReturned)
      .map(({ candidate, score, reasons }) => ({ ...candidate, score, reasons }));
  }
}
