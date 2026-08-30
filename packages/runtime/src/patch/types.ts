import type { RuntimeFileMetadata } from "../filesystem/types.js";
import type { ResolvedMutationPath } from "../workspace-path.js";

export const PATCH_LIMITS = Object.freeze({
  maxPatchBytes: 256 * 1024,
  maxFiles: 100,
  maxHunks: 1000,
  maxTargetFileBytes: 8 * 1024 * 1024,
  maxPreparedBytes: 32 * 1024 * 1024,
});

export type PatchLineKind = "CONTEXT" | "REMOVE" | "ADD";

export interface PatchLine {
  readonly kind: PatchLineKind;
  readonly text: string;
}

export interface PatchHunk {
  readonly lines: readonly PatchLine[];
  readonly endOfFile: boolean;
}

export type PatchOperation =
  | { readonly kind: "ADD"; readonly path: string; readonly lines: readonly string[] }
  | { readonly kind: "DELETE"; readonly path: string }
  | {
      readonly kind: "UPDATE";
      readonly path: string;
      readonly moveTo?: string;
      readonly hunks: readonly PatchHunk[];
    };

export interface PatchDocument {
  readonly operations: readonly PatchOperation[];
  readonly fileCount: number;
  readonly hunkCount: number;
}

export interface FileVersion {
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface PreparedChange {
  readonly operation: PatchOperation;
  readonly source?: ResolvedMutationPath;
  readonly destination?: ResolvedMutationPath;
  readonly beforeBytes?: Uint8Array;
  readonly afterBytes?: Uint8Array;
  readonly beforeVersion?: FileVersion;
  readonly afterVersion?: FileVersion;
  readonly additions: number;
  readonly deletions: number;
}

export interface PreparedPatch {
  readonly changes: readonly PreparedChange[];
  readonly preparedBytes: number;
}

export interface PatchChange {
  readonly kind: "ADD" | "UPDATE" | "DELETE" | "MOVE";
  readonly path: string;
  readonly fromPath?: string;
  readonly toPath?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly beforeHash?: string;
  readonly afterHash?: string;
}

export interface PatchCommitResult {
  readonly ok: true;
  readonly changeCount: number;
  readonly changes: readonly PatchChange[];
}

export interface RuntimePatchRequest {
  readonly signal?: AbortSignal;
  readonly patch: string;
}

export interface PatchMutationFileSystem {
  readFileBytes(absolutePath: string): Promise<Uint8Array>;
  getMetadata(absolutePath: string): Promise<RuntimeFileMetadata | null>;
  writePatchFile(absolutePath: string, bytes: Uint8Array): Promise<void>;
  removePatchFile(absolutePath: string): Promise<void>;
  movePatchFile(sourcePath: string, destinationPath: string): Promise<void>;
  makePatchDirectory(absolutePath: string): Promise<void>;
  removePatchDirectoryIfEmpty(absolutePath: string): Promise<void>;
}
