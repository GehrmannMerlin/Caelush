import { createHash } from "node:crypto";
import type {
  FileChangeSummary,
  JsonObject,
  VerificationEvidence,
  VerificationPlan,
} from "@caelush/protocol";
import type {
  VerificationGitDiff,
  VerificationGitStatus,
  VerificationGitStatusEntry,
  VerificationGitPort,
} from "./contracts.js";

export interface GitReviewInput {
  readonly changedFiles: readonly FileChangeSummary[];
  readonly requirement?: "REQUIRED" | "IF_AVAILABLE" | "ADVISORY";
  readonly status: VerificationGitStatus;
  readonly diffs: readonly VerificationGitDiff[];
}

export interface GitReviewResult {
  readonly status: "PASSED" | "FAILED" | "ERROR" | "SKIPPED";
  readonly branch?: string;
  readonly detached?: boolean;
  readonly ahead?: number;
  readonly behind?: number;
  readonly clean?: boolean;
  readonly statusEntryCount: number;
  readonly attributedPaths: readonly string[];
  readonly unattributedDirtyPaths: readonly string[];
  readonly unmergedPaths: readonly string[];
  readonly diffSummaries: readonly string[];
  readonly diffExcerpt: string;
  readonly diffHashes: Readonly<Record<string, string>>;
  readonly noNetDiffPaths: readonly string[];
  readonly truncated: boolean;
  readonly reviewComplete: boolean;
}

export const MAX_GIT_REVIEW_PATHS = 128;
export const MAX_GIT_REVIEW_EVIDENCE_BYTES = 64 * 1024;
export const MAX_GIT_DIFF_EXCERPT_BYTES = 48 * 1024;

export function reviewGitChangeset(input: GitReviewInput): GitReviewResult {
  if (!input.status.available) {
    return emptyResult(input.requirement === "REQUIRED" ? "ERROR" : "SKIPPED");
  }
  const entries = [...(input.status.entries ?? [])].sort(compareStatusEntries);
  const changed = [...input.changedFiles].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const attributed = new Set(changed.map((file) => file.path));
  const attributedPaths = changed.map((file) => file.path);
  const dirtyEntries = entries.filter(
    (entry) => entry.indexStatus !== " " || entry.worktreeStatus !== " ",
  );
  const unattributedDirtyPaths = dirtyEntries
    .map((entry) => entry.path)
    .filter((path) => !attributed.has(path))
    .sort((left, right) => left.localeCompare(right));
  const unmergedPaths = entries
    .filter((entry) => entry.kind === "UNMERGED")
    .map((entry) => entry.path);
  const diffs = [...input.diffs].sort((left, right) => left.path.localeCompare(right.path));
  const diffByPath = new Map(diffs.map((diff) => [diff.path, diff]));
  const diffSummaries: string[] = [];
  const diffHashes: Record<string, string> = {};
  const noNetDiffPaths: string[] = [];
  let diffExcerpt = "";
  let truncated = input.status.truncated === true;
  for (const path of attributedPaths) {
    const diff = diffByPath.get(path);
    const entry = entries.find((item) => item.path === path);
    if (entry?.kind === "UNTRACKED") {
      diffSummaries.push(`${path}:UNTRACKED`);
      continue;
    }
    if (diff === undefined) {
      truncated = true;
      continue;
    }
    diffHashes[path] = createHash("sha256").update(diff.diff, "utf8").digest("hex");
    if (diff.diff.length === 0) noNetDiffPaths.push(path);
    diffSummaries.push(`${path}:${diff.diff.length === 0 ? "NO_NET_DIFF" : "DIFF"}`);
    if (diff.diff.length > 0)
      diffExcerpt = appendBounded(diffExcerpt, `=== ${path} ===\n${diff.diff}`);
    truncated ||= diff.truncated;
  }
  const reviewComplete =
    changed.length <= MAX_GIT_REVIEW_PATHS &&
    entries.length <= MAX_GIT_REVIEW_PATHS &&
    !truncated &&
    encodedBytes({
      attributedPaths,
      unattributedDirtyPaths,
      unmergedPaths,
      diffSummaries,
      diffExcerpt,
    }) <= MAX_GIT_REVIEW_EVIDENCE_BYTES;
  const status = unmergedPaths.length > 0 ? "FAILED" : reviewComplete ? "PASSED" : "ERROR";
  return {
    status,
    ...(input.status.branch === undefined ? {} : { branch: input.status.branch }),
    ...(input.status.detached === undefined ? {} : { detached: input.status.detached }),
    ...(input.status.ahead === undefined ? {} : { ahead: input.status.ahead }),
    ...(input.status.behind === undefined ? {} : { behind: input.status.behind }),
    ...(input.status.clean === undefined ? {} : { clean: input.status.clean }),
    statusEntryCount: entries.length,
    attributedPaths,
    unattributedDirtyPaths,
    unmergedPaths: sorted(unmergedPaths),
    diffSummaries: sorted(diffSummaries),
    diffExcerpt,
    diffHashes,
    noNetDiffPaths: sorted(noNetDiffPaths),
    truncated,
    reviewComplete,
  };
}

export function createGitEvidence(input: {
  readonly id: VerificationEvidence["id"];
  readonly planId: VerificationPlan["id"];
  readonly checkId: VerificationEvidence["checkId"];
  readonly capturedAt: VerificationEvidence["capturedAt"];
  readonly result: GitReviewResult;
}): VerificationEvidence {
  const details: JsonObject = {
    ...(input.result.branch === undefined ? {} : { branch: input.result.branch }),
    ...(input.result.detached === undefined ? {} : { detached: input.result.detached }),
    ...(input.result.ahead === undefined ? {} : { ahead: input.result.ahead }),
    ...(input.result.behind === undefined ? {} : { behind: input.result.behind }),
    ...(input.result.clean === undefined ? {} : { clean: input.result.clean }),
    statusEntryCount: input.result.statusEntryCount,
    attributedPaths: [...input.result.attributedPaths],
    unattributedDirtyPaths: [...input.result.unattributedDirtyPaths],
    unmergedPaths: [...input.result.unmergedPaths],
    diffSummaries: [...input.result.diffSummaries],
    diffExcerpt: input.result.diffExcerpt,
    diffHashes: input.result.diffHashes,
    noNetDiffPaths: [...input.result.noNetDiffPaths],
    truncated: input.result.truncated,
    reviewComplete: input.result.reviewComplete,
  };
  return {
    id: input.id,
    planId: input.planId,
    checkId: input.checkId,
    kind: "GIT",
    summary: `Git changeset review ${input.result.status.toLowerCase()}`,
    details,
    capturedAt: input.capturedAt,
  };
}

export type { VerificationGitPort };

function emptyResult(status: GitReviewResult["status"]): GitReviewResult {
  return {
    status,
    statusEntryCount: 0,
    attributedPaths: [],
    unattributedDirtyPaths: [],
    unmergedPaths: [],
    diffSummaries: [],
    diffExcerpt: "",
    diffHashes: {},
    noNetDiffPaths: [],
    truncated: false,
    reviewComplete: status === "SKIPPED",
  };
}

function compareStatusEntries(
  left: VerificationGitStatusEntry,
  right: VerificationGitStatusEntry,
): number {
  return left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function appendBounded(current: string, addition: string): string {
  const next = current.length === 0 ? addition : `${current}\n${addition}`;
  const bytes = Buffer.from(next, "utf8");
  if (bytes.byteLength <= MAX_GIT_DIFF_EXCERPT_BYTES) return next;
  let end = MAX_GIT_DIFF_EXCERPT_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}\n[diff excerpt truncated]`;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
