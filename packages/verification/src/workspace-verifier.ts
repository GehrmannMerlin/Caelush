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
import { MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES } from "@caelush/protocol";
import {
  parseVerificationEvidence,
  serializedJsonBytes,
  VerificationEvidenceEncodingError,
} from "./evidence.js";

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
  if (!input.result.inspectionComplete && input.result.status !== "ERROR") {
    throw new VerificationEvidenceEncodingError("VERIFICATION_EVIDENCE_ENCODING_ERROR");
  }
  const details = createWorkspaceEvidenceDetails(input.result);
  return parseVerificationEvidence({
    id: input.id,
    planId: input.planId,
    checkId: input.checkId,
    kind: "WORKSPACE",
    summary: `Workspace change sanity ${input.result.status.toLowerCase()}`,
    details,
    capturedAt: input.capturedAt,
  });
}

interface WorkspaceEvidenceTruncation {
  readonly artifactContentTruncatedCount: number;
  readonly artifactContentOmittedBytes: number;
  readonly artifactRecordsOmittedCount: number;
  readonly fingerprintsOmittedCount: number;
  readonly pathsTruncated: boolean;
}

function createWorkspaceEvidenceDetails(result: WorkspaceInspectionResult): JsonObject {
  const fingerprints = Object.fromEntries(
    Object.entries(result.contentFingerprints)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, fingerprint]) => [
        path,
        {
          kind: fingerprint.kind,
          ...(fingerprint.sizeBytes === undefined ? {} : { sizeBytes: fingerprint.sizeBytes }),
          ...(fingerprint.sha256 === undefined ? {} : { sha256: fingerprint.sha256 }),
        },
      ]),
  );
  const artifacts = [...result.artifactEvidence].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const core = workspaceEvidenceCore(result);
  const pathsTruncated = [result.missingPaths, result.unexpectedKinds, result.symlinkPaths].some(
    isPathSummaryTruncated,
  );
  const base: JsonObject = pathsTruncated
    ? {
        ...core,
        evidenceTruncated: true,
        evidenceTruncation: {
          artifactContentTruncatedCount: 0,
          artifactContentOmittedBytes: 0,
          artifactRecordsOmittedCount: 0,
          fingerprintsOmittedCount: 0,
          pathsTruncated: true,
        },
      }
    : core;
  const allFingerprintCount = Object.keys(fingerprints).length;
  const fingerprintsCannotProveFreshness =
    result.workspaceFreshnessHash === undefined && allFingerprintCount > 0;
  const full: JsonObject = {
    ...base,
    artifactEvidence: artifacts.map((artifact) => ({ ...artifact })),
    ...(result.workspaceFreshnessHash === undefined
      ? {}
      : {
          workspaceFreshnessHash: result.workspaceFreshnessHash,
          contentFingerprints: fingerprints,
        }),
  };
  if (serializedJsonBytes(full) <= MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES) {
    if (!fingerprintsCannotProveFreshness) return full;
    const summarized: JsonObject = {
      ...full,
      evidenceTruncated: true,
      evidenceTruncation: {
        artifactContentTruncatedCount: 0,
        artifactContentOmittedBytes: 0,
        artifactRecordsOmittedCount: 0,
        fingerprintsOmittedCount: allFingerprintCount,
        fingerprintsHash: sha256(JSON.stringify(fingerprints)),
        pathsTruncated,
      },
    };
    if (serializedJsonBytes(summarized) <= MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES) {
      return summarized;
    }
  }

  const metadataArtifacts = artifacts.map((artifact) =>
    artifact.kind === "TEXT" && artifact.content !== undefined
      ? { ...artifact, content: "", truncated: true }
      : { ...artifact },
  );
  const fingerprintsHash = sha256(JSON.stringify(fingerprints));
  const artifactsHash = sha256(JSON.stringify(artifacts));
  const fingerprintCount = allFingerprintCount;
  let includeFingerprints = result.workspaceFreshnessHash !== undefined;
  let includedArtifactCount = metadataArtifacts.length;
  let selectedArtifacts: readonly JsonObject[] = metadataArtifacts;

  const truncationFor = (
    selected: readonly JsonObject[],
    recordCount: number,
    omittedFingerprints: number,
  ): WorkspaceEvidenceTruncation => {
    let contentOmittedBytes = 0;
    let contentTruncatedCount = 0;
    for (let index = 0; index < artifacts.length; index += 1) {
      const original = artifacts[index]!;
      const current = selected[index];
      const originalContent = original.kind === "TEXT" ? (original.content ?? "") : "";
      const currentContent =
        current !== undefined && current.kind === "TEXT"
          ? typeof current.content === "string"
            ? current.content
            : ""
          : "";
      const omitted = Math.max(
        0,
        Buffer.byteLength(originalContent, "utf8") - Buffer.byteLength(currentContent, "utf8"),
      );
      contentOmittedBytes += omitted;
      if (omitted > 0 || original.truncated) contentTruncatedCount += 1;
    }
    return {
      artifactContentTruncatedCount: contentTruncatedCount,
      artifactContentOmittedBytes: contentOmittedBytes,
      artifactRecordsOmittedCount: artifacts.length - recordCount,
      fingerprintsOmittedCount: omittedFingerprints,
      pathsTruncated,
    };
  };

  const build = (
    selected: readonly JsonObject[],
    recordCount: number,
    omittedFingerprints: number,
  ): JsonObject => {
    const truncation = truncationFor(selected, recordCount, omittedFingerprints);
    const omittedRecords = artifacts.length - recordCount;
    return {
      ...base,
      artifactEvidence: [...selected],
      evidenceTruncated: true,
      evidenceTruncation: {
        artifactContentTruncatedCount: truncation.artifactContentTruncatedCount,
        artifactContentOmittedBytes: truncation.artifactContentOmittedBytes,
        artifactRecordsOmittedCount: truncation.artifactRecordsOmittedCount,
        ...(omittedRecords === 0 ? {} : { artifactRecordsHash: artifactsHash }),
        fingerprintsOmittedCount: truncation.fingerprintsOmittedCount,
        ...(omittedFingerprints === 0 ? {} : { fingerprintsHash }),
        pathsTruncated: truncation.pathsTruncated,
      },
      ...(result.workspaceFreshnessHash === undefined
        ? {}
        : {
            workspaceFreshnessHash: result.workspaceFreshnessHash,
            ...(includeFingerprints ? { contentFingerprints: fingerprints } : {}),
          }),
    };
  };

  let details = build(
    selectedArtifacts,
    includedArtifactCount,
    includeFingerprints ? 0 : fingerprintCount,
  );
  if (serializedJsonBytes(details) > MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES) {
    includeFingerprints = false;
    details = build(selectedArtifacts, includedArtifactCount, fingerprintCount);
  }
  while (
    serializedJsonBytes(details) > MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES &&
    includedArtifactCount > 0
  ) {
    includedArtifactCount -= 1;
    selectedArtifacts = metadataArtifacts.slice(0, includedArtifactCount);
    details = build(
      selectedArtifacts,
      includedArtifactCount,
      includeFingerprints ? 0 : fingerprintCount,
    );
  }
  if (serializedJsonBytes(details) > MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES) {
    throw new VerificationEvidenceEncodingError("VERIFICATION_EVIDENCE_SIZE_ERROR");
  }

  // Allocate any remaining bytes deterministically to the earliest path. The binary search works
  // on Unicode code points and measures the complete JSON object, including escaping and metadata.
  for (let index = 0; index < includedArtifactCount; index += 1) {
    const source = artifacts[index]!;
    if (source.kind !== "TEXT" || source.content === undefined) continue;
    const characters = [...source.content];
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidateArtifacts = selectedArtifacts.map((artifact, artifactIndex) =>
        artifactIndex === index
          ? { ...artifact, content: characters.slice(0, middle).join(""), truncated: true }
          : artifact,
      );
      const candidate = build(
        candidateArtifacts,
        includedArtifactCount,
        includeFingerprints ? 0 : fingerprintCount,
      );
      if (serializedJsonBytes(candidate) <= MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES) low = middle;
      else high = middle - 1;
    }
    selectedArtifacts = selectedArtifacts.map((artifact, artifactIndex) =>
      artifactIndex === index
        ? {
            ...artifact,
            content: characters.slice(0, low).join(""),
            truncated: source.truncated || low < characters.length,
          }
        : artifact,
    );
    details = build(
      selectedArtifacts,
      includedArtifactCount,
      includeFingerprints ? 0 : fingerprintCount,
    );
  }
  if (serializedJsonBytes(details) > MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES) {
    throw new VerificationEvidenceEncodingError("VERIFICATION_EVIDENCE_SIZE_ERROR");
  }
  return details;
}

function workspaceEvidenceCore(result: WorkspaceInspectionResult): JsonObject {
  const missing = summarizePaths(result.missingPaths);
  const unexpected = summarizePaths(result.unexpectedKinds);
  const symlinks = summarizePaths(result.symlinkPaths);
  return {
    checkedFileCount: result.checkedFileCount,
    createdCount: result.createdCount,
    modifiedCount: result.modifiedCount,
    movedCount: result.movedCount,
    deletedCount: result.deletedCount,
    missingPaths: [...missing.paths],
    ...(missing.truncated
      ? { missingPathCount: missing.count, missingPathsHash: missing.hash }
      : {}),
    unexpectedKinds: [...unexpected.paths],
    ...(unexpected.truncated
      ? { unexpectedKindCount: unexpected.count, unexpectedKindsHash: unexpected.hash }
      : {}),
    symlinkPaths: [...symlinks.paths],
    ...(symlinks.truncated
      ? { symlinkPathCount: symlinks.count, symlinkPathsHash: symlinks.hash }
      : {}),
    inspectionComplete: result.inspectionComplete,
    inspectionHash: result.inspectionHash,
    ...(result.workspaceFreshnessHash === undefined
      ? {}
      : { workspaceFreshnessHash: result.workspaceFreshnessHash }),
    status: result.status,
  };
}

function summarizePaths(values: readonly string[]): {
  readonly paths: readonly string[];
  readonly count: number;
  readonly truncated: boolean;
  readonly hash: string;
} {
  const sortedValues = [...values].sort((left, right) => left.localeCompare(right));
  if (!isPathSummaryTruncated(sortedValues)) {
    return {
      paths: sortedValues,
      count: sortedValues.length,
      truncated: false,
      hash: sha256("[]"),
    };
  }
  const paths = sortedValues.slice(0, 8).map((value) => {
    if (Buffer.byteLength(value, "utf8") <= 160) return value;
    return boundUtf8(value, 96).text + "...[sha256:" + sha256(value) + "]";
  });
  return {
    paths,
    count: sortedValues.length,
    truncated: true,
    hash: sha256(JSON.stringify(sortedValues)),
  };
}

function isPathSummaryTruncated(values: readonly string[]): boolean {
  return (
    values.length > 16 ||
    values.some((value) => Buffer.byteLength(value, "utf8") > 160) ||
    Buffer.byteLength(JSON.stringify(values), "utf8") > 4 * 1024
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
