import { createHash } from "node:crypto";
import type { FileChangeSummary, VerificationEvidence, VerificationPlan } from "@caelush/protocol";
import type {
  WorkspaceInspectionFacts,
  WorkspacePathObservation,
  WorkspaceVerificationPort,
} from "./contracts.js";

export interface WorkspaceInspectionResult {
  readonly status: "PASSED" | "FAILED" | "ERROR";
  readonly checkedFileCount: number;
  readonly createdCount: number;
  readonly modifiedCount: number;
  readonly movedCount: number;
  readonly deletedCount: number;
  readonly missingPaths: readonly string[];
  readonly unexpectedKinds: readonly string[];
  readonly symlinkPaths: readonly string[];
  readonly inspectionComplete: boolean;
  readonly inspectionHash: string;
}

export const MAX_WORKSPACE_REVIEW_PATHS = 4096;

export function verifyWorkspaceInspection(input: {
  readonly changedFiles: readonly FileChangeSummary[];
  readonly facts: WorkspaceInspectionFacts;
}): WorkspaceInspectionResult {
  const changedFiles = [...input.changedFiles].sort(compareChangedFiles);
  const observations = [...input.facts.paths].sort(compareObservations);
  const paths = new Map<string, WorkspacePathObservation>();
  let duplicate = false;
  for (const observation of observations) {
    if (paths.has(observation.path)) duplicate = true;
    paths.set(observation.path, observation);
  }

  const missingPaths: string[] = [];
  const unexpectedKinds: string[] = [];
  const symlinkPaths: string[] = [];
  let failed = false;
  let error =
    !input.facts.inspectionComplete ||
    duplicate ||
    changedFiles.length > MAX_WORKSPACE_REVIEW_PATHS;
  for (const changedFile of changedFiles) {
    const observation = paths.get(changedFile.path);
    if (
      observation === undefined ||
      observation.kind === "OUTSIDE" ||
      observation.kind === "ERROR"
    ) {
      error = true;
      continue;
    }
    if (changedFile.changeType === "DELETED") {
      if (observation.kind !== "MISSING") {
        failed = true;
        if (observation.kind === "SYMLINK") symlinkPaths.push(changedFile.path);
        else unexpectedKinds.push(`${changedFile.path}:${observation.kind}`);
      }
      continue;
    }
    if (observation.kind === "MISSING") {
      failed = true;
      missingPaths.push(changedFile.path);
    } else if (observation.kind === "SYMLINK") {
      failed = true;
      symlinkPaths.push(changedFile.path);
    } else if (observation.kind !== "FILE") {
      failed = true;
      unexpectedKinds.push(`${changedFile.path}:${observation.kind}`);
    }
  }

  const resultWithoutHash = {
    status: error ? ("ERROR" as const) : failed ? ("FAILED" as const) : ("PASSED" as const),
    checkedFileCount: changedFiles.length,
    createdCount: changedFiles.filter((file) => file.changeType === "CREATED").length,
    modifiedCount: changedFiles.filter((file) => file.changeType === "MODIFIED").length,
    movedCount: changedFiles.filter((file) => file.changeType === "MOVED").length,
    deletedCount: changedFiles.filter((file) => file.changeType === "DELETED").length,
    missingPaths: sorted(missingPaths),
    unexpectedKinds: sorted(unexpectedKinds),
    symlinkPaths: sorted(symlinkPaths),
    inspectionComplete: input.facts.inspectionComplete && !duplicate,
  };
  const inspectionHash = createHash("sha256")
    .update(JSON.stringify({ changedFiles, observations, result: resultWithoutHash }), "utf8")
    .digest("hex");
  return { ...resultWithoutHash, inspectionHash };
}

export function createWorkspaceEvidence(input: {
  readonly id: VerificationEvidence["id"];
  readonly planId: VerificationPlan["id"];
  readonly checkId: VerificationEvidence["checkId"];
  readonly capturedAt: VerificationEvidence["capturedAt"];
  readonly result: WorkspaceInspectionResult;
}): VerificationEvidence {
  return {
    id: input.id,
    planId: input.planId,
    checkId: input.checkId,
    kind: "WORKSPACE",
    summary: `Workspace change sanity ${input.result.status.toLowerCase()}`,
    details: {
      checkedFileCount: input.result.checkedFileCount,
      createdCount: input.result.createdCount,
      modifiedCount: input.result.modifiedCount,
      movedCount: input.result.movedCount,
      deletedCount: input.result.deletedCount,
      missingPaths: [...input.result.missingPaths],
      unexpectedKinds: [...input.result.unexpectedKinds],
      symlinkPaths: [...input.result.symlinkPaths],
      inspectionComplete: input.result.inspectionComplete,
      inspectionHash: input.result.inspectionHash,
      status: input.result.status,
    },
    capturedAt: input.capturedAt,
  };
}

export type { WorkspaceVerificationPort };

function compareChangedFiles(left: FileChangeSummary, right: FileChangeSummary): number {
  return left.path.localeCompare(right.path) || left.changeType.localeCompare(right.changeType);
}

function compareObservations(
  left: WorkspacePathObservation,
  right: WorkspacePathObservation,
): number {
  return left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
