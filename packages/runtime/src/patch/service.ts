import { commitPatch } from "./committer.js";
import { parsePatch } from "./parser.js";
import { preparePatch } from "./planner.js";
import { applyPatchHunks, decodePatchText, encodeNewPatchFile, encodePatchedText } from "./text.js";
import type {
  PatchCommitResult,
  PatchMutationFileSystem,
  PatchOperation,
  RuntimePatchRequest,
} from "./types.js";
import type { WorkspacePathResolver } from "../workspace-path.js";

export interface RuntimePatchService {
  apply(request: RuntimePatchRequest): Promise<PatchCommitResult>;
  /** Inspect whether every requested target currently matches the patch's postcondition. Never writes. */
  reconcile(request: RuntimePatchRequest): Promise<{
    readonly kind: "MATCHED_EXPECTED_STATE" | "DOES_NOT_MATCH" | "INCONCLUSIVE";
  }>;
}

class LocalRuntimePatchService implements RuntimePatchService {
  constructor(
    private readonly pathResolver: Pick<WorkspacePathResolver, "resolveMutationTarget">,
    private readonly filesystem: PatchMutationFileSystem,
  ) {}

  async apply(request: RuntimePatchRequest): Promise<PatchCommitResult> {
    throwIfAborted(request.signal);
    const document = parsePatch(request.patch);
    const prepared = await preparePatch(document, {
      pathResolver: this.pathResolver,
      filesystem: this.filesystem,
    });
    throwIfAborted(request.signal);
    return commitPatch(prepared, this.filesystem);
  }

  async reconcile(request: RuntimePatchRequest) {
    throwIfAborted(request.signal);
    try {
      const document = parsePatch(request.patch);
      for (const operation of document.operations) {
        throwIfAborted(request.signal);
        const result = await reconcileOperation(operation, this.pathResolver, this.filesystem);
        if (result === "DOES_NOT_MATCH") return { kind: "DOES_NOT_MATCH" as const };
        if (result === "INCONCLUSIVE") return { kind: "INCONCLUSIVE" as const };
      }
      return { kind: "MATCHED_EXPECTED_STATE" as const };
    } catch {
      throwIfAborted(request.signal);
      // Parse, path, access and read failures do not establish a safe postcondition. They are
      // deliberately folded to an inconclusive result; exception details may contain host paths.
      return { kind: "INCONCLUSIVE" as const };
    }
  }
}

async function reconcileOperation(
  operation: PatchOperation,
  pathResolver: Pick<WorkspacePathResolver, "resolveMutationTarget">,
  filesystem: PatchMutationFileSystem,
): Promise<"MATCHED_EXPECTED_STATE" | "DOES_NOT_MATCH" | "INCONCLUSIVE"> {
  if (operation.kind === "ADD") {
    const target = await pathResolver.resolveMutationTarget(operation.path);
    if (target.metadata?.kind !== "FILE") return "DOES_NOT_MATCH";
    const current = await filesystem.readFileBytes(target.absolutePath);
    return equalBytes(current, encodeNewPatchFile(operation.lines))
      ? "MATCHED_EXPECTED_STATE"
      : "DOES_NOT_MATCH";
  }
  if (operation.kind === "DELETE") {
    const target = await pathResolver.resolveMutationTarget(operation.path);
    return target.metadata === null ? "MATCHED_EXPECTED_STATE" : "DOES_NOT_MATCH";
  }

  const sourcePath = operation.moveTo ?? operation.path;
  const target = await pathResolver.resolveMutationTarget(sourcePath);
  if (target.metadata?.kind !== "FILE") return "DOES_NOT_MATCH";
  if (operation.moveTo !== undefined) {
    const source = await pathResolver.resolveMutationTarget(operation.path);
    if (source.metadata !== null) return "DOES_NOT_MATCH";
  }
  if (operation.hunks.length === 0) return "INCONCLUSIVE";
  const current = await filesystem.readFileBytes(target.absolutePath);
  const decoded = decodePatchText(sourcePath, current);
  const reversed = operation.hunks.map((hunk) => ({
    endOfFile: hunk.endOfFile,
    lines: hunk.lines.map((line) => ({
      kind:
        line.kind === "ADD"
          ? ("REMOVE" as const)
          : line.kind === "REMOVE"
            ? ("ADD" as const)
            : ("CONTEXT" as const),
      text: line.text,
    })),
  }));
  try {
    const candidateBefore = applyPatchHunks(decoded.text, reversed);
    const candidateAfter = applyPatchHunks(candidateBefore, operation.hunks);
    const expected = encodePatchedText(decoded, candidateAfter);
    return equalBytes(current, expected) ? "MATCHED_EXPECTED_STATE" : "DOES_NOT_MATCH";
  } catch {
    // Current contents that do not safely satisfy the inverse hunk are evidence of neither success
    // nor non-execution: the process could have applied some hunks before interruption.
    return "INCONCLUSIVE";
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Runtime patch operation was cancelled.");
}

export function createRuntimePatchService(
  pathResolver: Pick<WorkspacePathResolver, "resolveMutationTarget">,
  filesystem: PatchMutationFileSystem,
): RuntimePatchService {
  return new LocalRuntimePatchService(pathResolver, filesystem);
}
