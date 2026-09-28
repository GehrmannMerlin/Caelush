import { createHash } from "node:crypto";
import type {
  FileChangeSummary,
  JsonObject,
  VerificationEvidence,
  VerificationPlan,
} from "@caelush/protocol";
import type {
  WorkspaceInspectionFacts,
  WorkspacePathObservation,
  WorkspaceContentFingerprint,
  WorkspaceArtifactEvidence,
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
  readonly contentFingerprints: Readonly<Record<string, WorkspaceContentFingerprint>>;
  readonly artifactEvidence: readonly WorkspaceArtifactEvidence[];
  readonly workspaceFreshnessHash?: string;
}

export const MAX_WORKSPACE_REVIEW_PATHS = 4096;
export const MAX_WORKSPACE_FINGERPRINT_BYTES = 48 * 1024;
export const MAX_WORKSPACE_ARTIFACT_FILE_BYTES = 8 * 1024;
export const MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES = 32 * 1024;

export function computeWorkspaceFreshnessHash(
  entries: readonly { readonly path: string; readonly fingerprint: WorkspaceContentFingerprint }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([...entries].sort((left, right) => left.path.localeCompare(right.path))),
      "utf8",
    )
    .digest("hex");
}

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
  const contentFingerprints: Record<string, WorkspaceContentFingerprint> = {};
  const artifacts = new Map<string, WorkspaceArtifactEvidence>();
  let duplicateArtifacts = false;
  for (const artifact of input.facts.artifactEvidence ?? []) {
    if (artifacts.has(artifact.path)) duplicateArtifacts = true;
    else artifacts.set(artifact.path, artifact);
  }
  let failed = false;
  let error =
    !input.facts.inspectionComplete ||
    duplicate ||
    duplicateArtifacts ||
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
    if (observation.fingerprint !== undefined) {
      contentFingerprints[changedFile.path] = observation.fingerprint;
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
    inspectionComplete: input.facts.inspectionComplete && !duplicate && !duplicateArtifacts,
  };
  const inspectionHash = createHash("sha256")
    .update(JSON.stringify({ changedFiles, observations, result: resultWithoutHash }), "utf8")
    .digest("hex");
  const fingerprintBytes = Buffer.byteLength(JSON.stringify(contentFingerprints), "utf8");
  const freshnessComplete =
    input.facts.inspectionComplete &&
    !duplicate &&
    changedFiles.every((changedFile) => {
      const fingerprint = contentFingerprints[changedFile.path];
      if (fingerprint === undefined) return false;
      if (changedFile.changeType === "DELETED") return fingerprint.kind === "MISSING";
      return (
        fingerprint.kind === "FILE" &&
        fingerprint.sha256 !== undefined &&
        fingerprint.sizeBytes !== undefined
      );
    });
  const workspaceFreshnessHash =
    freshnessComplete && fingerprintBytes <= MAX_WORKSPACE_FINGERPRINT_BYTES
      ? computeWorkspaceFreshnessHash(
          changedFiles.map((file) => ({
            path: file.path,
            fingerprint: contentFingerprints[file.path]!,
          })),
        )
      : undefined;
  const artifactEvidence = projectArtifactEvidence(changedFiles, artifacts, contentFingerprints);
  return {
    ...resultWithoutHash,
    inspectionHash,
    contentFingerprints,
    artifactEvidence,
    ...(workspaceFreshnessHash === undefined ? {} : { workspaceFreshnessHash }),
  };
}

export function createWorkspaceEvidence(input: {
  readonly id: VerificationEvidence["id"];
  readonly planId: VerificationPlan["id"];
  readonly checkId: VerificationEvidence["checkId"];
  readonly capturedAt: VerificationEvidence["capturedAt"];
  readonly result: WorkspaceInspectionResult;
}): VerificationEvidence {
  const details: JsonObject = {
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
    artifactEvidence: input.result.artifactEvidence.map((artifact) => ({ ...artifact })),
    ...(input.result.workspaceFreshnessHash === undefined
      ? {}
      : {
          workspaceFreshnessHash: input.result.workspaceFreshnessHash,
          contentFingerprints: Object.fromEntries(
            Object.entries(input.result.contentFingerprints).map(([path, fingerprint]) => [
              path,
              { ...fingerprint },
            ]),
          ),
        }),
    status: input.result.status,
  };
  return {
    id: input.id,
    planId: input.planId,
    checkId: input.checkId,
    kind: "WORKSPACE",
    summary: `Workspace change sanity ${input.result.status.toLowerCase()}`,
    details,
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

function projectArtifactEvidence(
  changedFiles: readonly FileChangeSummary[],
  artifacts: ReadonlyMap<string, WorkspaceArtifactEvidence>,
  fingerprints: Readonly<Record<string, WorkspaceContentFingerprint>>,
): WorkspaceArtifactEvidence[] {
  const projected: WorkspaceArtifactEvidence[] = [];
  let remainingBytes = MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES;
  for (const changedFile of changedFiles) {
    const artifact = artifacts.get(changedFile.path);
    const fingerprint = fingerprints[changedFile.path];
    if (artifact === undefined || fingerprint?.kind !== "FILE") continue;
    const metadata = {
      path: changedFile.path,
      ...(fingerprint.sha256 === undefined ? {} : { sha256: fingerprint.sha256 }),
      ...(fingerprint.sizeBytes === undefined ? {} : { sizeBytes: fingerprint.sizeBytes }),
    };
    const fingerprintMatches =
      artifact.sha256 === fingerprint.sha256 && artifact.sizeBytes === fingerprint.sizeBytes;
    if (!fingerprintMatches) {
      projected.push({ ...metadata, kind: "UNAVAILABLE", truncated: false });
      continue;
    }
    if (artifact.kind === "SENSITIVE" || artifact.kind === "BINARY") {
      projected.push({ ...metadata, kind: artifact.kind, truncated: false });
      continue;
    }
    if (artifact.kind !== "TEXT" || artifact.content === undefined || remainingBytes === 0) {
      projected.push({
        ...metadata,
        kind: "UNAVAILABLE",
        truncated: artifact.truncated || remainingBytes === 0,
      });
      continue;
    }
    const bounded = boundUtf8(
      artifact.content,
      Math.min(MAX_WORKSPACE_ARTIFACT_FILE_BYTES, remainingBytes),
    );
    remainingBytes -= Buffer.byteLength(bounded.text, "utf8");
    projected.push({
      ...metadata,
      kind: "TEXT",
      content: bounded.text,
      truncated: artifact.truncated || bounded.truncated,
    });
  }
  return projected.sort((left, right) => left.path.localeCompare(right.path));
}

function boundUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  let text = "";
  for (const character of value) {
    if (Buffer.byteLength(text + character, "utf8") > maxBytes) break;
    text += character;
  }
  return { text, truncated: true };
}
