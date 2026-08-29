import { createHash } from "node:crypto";
import {
  PATCH_LIMITS,
  type FileVersion,
  type PatchDocument,
  type PatchMutationFileSystem,
  type PatchOperation,
  type PreparedChange,
  type PreparedPatch,
} from "./types.js";
import { RuntimePatchError } from "./errors.js";
import { applyPatchHunks, decodePatchText, encodeNewPatchFile, encodePatchedText } from "./text.js";
import type { ResolvedMutationPath, WorkspacePathResolver } from "../workspace-path.js";

export interface PatchPreparationContext {
  readonly pathResolver: Pick<WorkspacePathResolver, "resolveMutationTarget">;
  readonly filesystem: PatchMutationFileSystem;
}

function version(bytes: Uint8Array): FileVersion {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

async function sourceFile(
  pathResolver: PatchPreparationContext["pathResolver"],
  filesystem: PatchMutationFileSystem,
  relativePath: string,
): Promise<{ readonly resolved: ResolvedMutationPath; readonly bytes: Uint8Array }> {
  const resolved = await pathResolver.resolveMutationTarget(relativePath);
  if (resolved.metadata === null) throw new RuntimePatchError("PATH_NOT_FOUND");
  if (resolved.metadata.kind !== "FILE") throw new RuntimePatchError("NOT_A_REGULAR_FILE");
  if ((resolved.metadata.sizeBytes ?? 0) > PATCH_LIMITS.maxTargetFileBytes) {
    throw new RuntimePatchError("FILE_TOO_LARGE_FOR_PATCH");
  }
  const bytes = await filesystem.readFileBytes(resolved.absolutePath);
  if (bytes.byteLength > PATCH_LIMITS.maxTargetFileBytes) {
    throw new RuntimePatchError("FILE_TOO_LARGE_FOR_PATCH");
  }
  return { resolved, bytes };
}

function destinationFile(
  pathResolver: PatchPreparationContext["pathResolver"],
  relativePath: string,
): Promise<ResolvedMutationPath> {
  return pathResolver.resolveMutationTarget(relativePath).then((resolved) => {
    if (resolved.metadata !== null) throw new RuntimePatchError("TARGET_ALREADY_EXISTS");
    return resolved;
  });
}

function hunkCounts(operation: Extract<PatchOperation, { kind: "UPDATE" }>): {
  readonly additions: number;
  readonly deletions: number;
} {
  return operation.hunks.reduce(
    (counts, hunk) => {
      for (const line of hunk.lines) {
        if (line.kind === "ADD") counts.additions += 1;
        if (line.kind === "REMOVE") counts.deletions += 1;
      }
      return counts;
    },
    { additions: 0, deletions: 0 },
  );
}

function ensurePreparedBudget(preparedBytes: number): void {
  if (preparedBytes > PATCH_LIMITS.maxPreparedBytes) {
    throw new RuntimePatchError("PATCH_BUDGET_EXCEEDED");
  }
}

export async function preparePatch(
  document: PatchDocument,
  context: PatchPreparationContext,
): Promise<PreparedPatch> {
  const changes: PreparedChange[] = [];
  let preparedBytes = 0;
  for (const operation of document.operations) {
    if (operation.kind === "ADD") {
      const destination = await destinationFile(context.pathResolver, operation.path);
      const afterBytes = encodeNewPatchFile(operation.lines);
      if (afterBytes.byteLength > PATCH_LIMITS.maxTargetFileBytes) {
        throw new RuntimePatchError("FILE_TOO_LARGE_FOR_PATCH");
      }
      changes.push({
        operation,
        destination,
        afterBytes,
        afterVersion: version(afterBytes),
        additions: operation.lines.length,
        deletions: 0,
      });
      preparedBytes += afterBytes.byteLength;
      ensurePreparedBudget(preparedBytes);
      continue;
    }

    const source = await sourceFile(context.pathResolver, context.filesystem, operation.path);
    const beforeVersion = version(source.bytes);
    if (operation.kind === "DELETE") {
      changes.push({
        operation,
        source: source.resolved,
        beforeBytes: source.bytes,
        beforeVersion,
        additions: 0,
        deletions: source.bytes.byteLength === 0 ? 0 : 1,
      });
      preparedBytes += source.bytes.byteLength;
      ensurePreparedBudget(preparedBytes);
      continue;
    }

    const destination = operation.moveTo
      ? await destinationFile(context.pathResolver, operation.moveTo)
      : undefined;
    const decoded = decodePatchText(operation.path, source.bytes);
    const counts = hunkCounts(operation);
    const afterBytes =
      operation.hunks.length === 0
        ? source.bytes
        : encodePatchedText(decoded, applyPatchHunks(decoded.text, operation.hunks));
    if (afterBytes.byteLength > PATCH_LIMITS.maxTargetFileBytes) {
      throw new RuntimePatchError("FILE_TOO_LARGE_FOR_PATCH");
    }
    changes.push({
      operation,
      source: source.resolved,
      ...(destination === undefined ? {} : { destination }),
      beforeBytes: source.bytes,
      afterBytes,
      beforeVersion,
      afterVersion: version(afterBytes),
      additions: counts.additions,
      deletions: counts.deletions,
    });
    preparedBytes += source.bytes.byteLength + afterBytes.byteLength;
    ensurePreparedBudget(preparedBytes);
  }
  return { changes, preparedBytes };
}
