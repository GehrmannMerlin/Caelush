import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { RuntimePatchError, RuntimePatchUncertainError } from "./errors.js";
import type {
  FileVersion,
  PatchChange,
  PatchMutationFileSystem,
  PatchOperation,
  PreparedChange,
  PreparedPatch,
  PatchCommitResult,
} from "./types.js";

function fileVersion(bytes: Uint8Array): FileVersion {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

function sameVersion(left: FileVersion | undefined, right: FileVersion): boolean {
  return left?.sizeBytes === right.sizeBytes && left.sha256 === right.sha256;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

async function guardSource(
  change: PreparedChange,
  filesystem: PatchMutationFileSystem,
): Promise<void> {
  if (change.source === undefined || change.beforeVersion === undefined) {
    throw new RuntimePatchUncertainError();
  }
  const metadata = await filesystem.getMetadata(change.source.absolutePath);
  if (metadata?.kind !== "FILE") throw new RuntimePatchError("PATCH_STALE");
  if (metadata.sizeBytes !== change.beforeVersion.sizeBytes) {
    throw new RuntimePatchError("PATCH_STALE");
  }
  const current = fileVersion(await filesystem.readFileBytes(change.source.absolutePath));
  if (!sameVersion(current, change.beforeVersion)) {
    throw new RuntimePatchError("HASH_GUARD_MISMATCH");
  }
}

async function guardDestination(
  change: PreparedChange,
  filesystem: PatchMutationFileSystem,
): Promise<void> {
  if (change.destination === undefined) return;
  if ((await filesystem.getMetadata(change.destination.absolutePath)) !== null) {
    if (change.operation.kind === "UPDATE") {
      throw new RuntimePatchError("MOVE_DESTINATION_EXISTS");
    }
    throw new RuntimePatchError("TARGET_ALREADY_EXISTS");
  }
}

async function guardAll(
  prepared: PreparedPatch,
  filesystem: PatchMutationFileSystem,
): Promise<void> {
  for (const change of prepared.changes) {
    if (change.operation.kind !== "ADD") await guardSource(change, filesystem);
    await guardDestination(change, filesystem);
  }
}

async function createParentDirectories(
  absolutePath: string,
  filesystem: PatchMutationFileSystem,
  createdDirectories: string[],
): Promise<void> {
  const missing: string[] = [];
  let current = absolutePath;
  while ((await filesystem.getMetadata(current)) === null) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current || parent.length === 0) break;
    current = parent;
  }
  for (const directory of missing.reverse()) {
    await filesystem.makePatchDirectory(directory);
    createdDirectories.push(directory);
  }
}

function filesystemErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function localKind(stats: {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
}) {
  if (stats.isSymbolicLink()) return "SYMLINK" as const;
  if (stats.isFile()) return "FILE" as const;
  if (stats.isDirectory()) return "DIRECTORY" as const;
  return "OTHER" as const;
}

export function createLocalPatchMutationFileSystem(): PatchMutationFileSystem {
  return {
    async readFileBytes(absolutePath) {
      return new Uint8Array(await readFile(absolutePath));
    },
    async getMetadata(absolutePath) {
      try {
        const stats = await lstat(absolutePath);
        return {
          kind: localKind(stats),
          ...(stats.isFile() ? { sizeBytes: stats.size } : {}),
        };
      } catch (error) {
        if (filesystemErrorCode(error) === "ENOENT") return null;
        throw error;
      }
    },
    async writePatchFile(absolutePath, bytes) {
      const metadata = await this.getMetadata(absolutePath);
      if (metadata?.kind === "SYMLINK") throw new RuntimePatchError("SYMLINK_MUTATION_NOT_ALLOWED");
      await writeFile(absolutePath, bytes);
    },
    async removePatchFile(absolutePath) {
      const metadata = await this.getMetadata(absolutePath);
      if (metadata?.kind === "SYMLINK") throw new RuntimePatchError("SYMLINK_MUTATION_NOT_ALLOWED");
      await unlink(absolutePath);
    },
    async movePatchFile(sourcePath, destinationPath) {
      const source = await this.getMetadata(sourcePath);
      const destination = await this.getMetadata(destinationPath);
      if (source?.kind === "SYMLINK" || destination?.kind === "SYMLINK") {
        throw new RuntimePatchError("SYMLINK_MUTATION_NOT_ALLOWED");
      }
      await rename(sourcePath, destinationPath);
    },
    async makePatchDirectory(absolutePath) {
      try {
        await mkdir(absolutePath);
      } catch (error) {
        if (filesystemErrorCode(error) !== "EEXIST") throw error;
        const metadata = await this.getMetadata(absolutePath);
        if (metadata?.kind !== "DIRECTORY") throw error;
      }
    },
    async removePatchDirectoryIfEmpty(absolutePath) {
      try {
        await rmdir(absolutePath);
      } catch (error) {
        if (filesystemErrorCode(error) !== "ENOENT" && filesystemErrorCode(error) !== "ENOTEMPTY") {
          throw error;
        }
      }
    },
  };
}

async function applyChange(
  change: PreparedChange,
  filesystem: PatchMutationFileSystem,
  createdDirectories: string[],
): Promise<void> {
  const operation = change.operation;
  if (operation.kind === "ADD") {
    const destination = change.destination;
    if (destination === undefined || change.afterBytes === undefined)
      throw new RuntimePatchUncertainError();
    await createParentDirectories(
      path.dirname(destination.absolutePath),
      filesystem,
      createdDirectories,
    );
    await filesystem.writePatchFile(destination.absolutePath, change.afterBytes);
    return;
  }
  if (change.source === undefined || change.beforeBytes === undefined)
    throw new RuntimePatchUncertainError();
  if (operation.kind === "DELETE") {
    await filesystem.removePatchFile(change.source.absolutePath);
    return;
  }
  if (change.destination !== undefined) {
    await createParentDirectories(
      path.dirname(change.destination.absolutePath),
      filesystem,
      createdDirectories,
    );
    await filesystem.movePatchFile(change.source.absolutePath, change.destination.absolutePath);
    if (change.afterBytes === undefined) throw new RuntimePatchUncertainError();
    if (!sameBytes(change.afterBytes, change.beforeBytes)) {
      await filesystem.writePatchFile(change.destination.absolutePath, change.afterBytes);
    }
    return;
  }
  if (change.afterBytes === undefined) throw new RuntimePatchUncertainError();
  await filesystem.writePatchFile(change.source.absolutePath, change.afterBytes);
}

async function verifyChange(
  change: PreparedChange,
  filesystem: PatchMutationFileSystem,
): Promise<void> {
  const operation = change.operation;
  if (operation.kind === "DELETE") {
    if ((await filesystem.getMetadata(change.source!.absolutePath)) !== null) {
      throw new Error("delete verification failed");
    }
    return;
  }
  const target = change.destination ?? change.source;
  if (target === undefined || change.afterBytes === undefined) throw new Error("target missing");
  const metadata = await filesystem.getMetadata(target.absolutePath);
  if (metadata?.kind !== "FILE") throw new Error("target verification failed");
  if (!sameBytes(await filesystem.readFileBytes(target.absolutePath), change.afterBytes)) {
    throw new Error("content verification failed");
  }
  if (
    operation.kind === "UPDATE" &&
    change.destination !== undefined &&
    change.source !== undefined &&
    (await filesystem.getMetadata(change.source.absolutePath)) !== null
  ) {
    throw new Error("move source verification failed");
  }
}

async function rollbackChange(
  change: PreparedChange,
  filesystem: PatchMutationFileSystem,
): Promise<void> {
  const operation = change.operation;
  if (operation.kind === "ADD") {
    if (
      change.destination &&
      (await filesystem.getMetadata(change.destination.absolutePath)) !== null
    ) {
      await filesystem.removePatchFile(change.destination.absolutePath);
    }
    return;
  }
  if (change.source === undefined || change.beforeBytes === undefined)
    throw new Error("rollback source missing");
  if (operation.kind === "DELETE") {
    await filesystem.writePatchFile(change.source.absolutePath, change.beforeBytes);
    return;
  }
  if (change.destination !== undefined) {
    if ((await filesystem.getMetadata(change.destination.absolutePath)) !== null) {
      await filesystem.removePatchFile(change.destination.absolutePath);
    }
    await filesystem.writePatchFile(change.source.absolutePath, change.beforeBytes);
    return;
  }
  await filesystem.writePatchFile(change.source.absolutePath, change.beforeBytes);
}

async function rollback(
  applied: readonly PreparedChange[],
  createdDirectories: readonly string[],
  filesystem: PatchMutationFileSystem,
): Promise<void> {
  for (const change of [...applied].reverse()) await rollbackChange(change, filesystem);
  for (const directory of [...createdDirectories].reverse()) {
    await filesystem.removePatchDirectoryIfEmpty(directory);
  }
  for (const change of applied) {
    const operation = change.operation;
    if (operation.kind === "ADD") {
      if (
        change.destination &&
        (await filesystem.getMetadata(change.destination.absolutePath)) !== null
      ) {
        throw new Error("add rollback verification failed");
      }
      continue;
    }
    const source = change.source;
    if (source === undefined || change.beforeBytes === undefined)
      throw new Error("rollback verification source missing");
    const restored = await filesystem.getMetadata(source.absolutePath);
    if (
      restored?.kind !== "FILE" ||
      !sameBytes(await filesystem.readFileBytes(source.absolutePath), change.beforeBytes)
    ) {
      throw new Error("rollback content verification failed");
    }
    if (
      change.destination &&
      (await filesystem.getMetadata(change.destination.absolutePath)) !== null
    ) {
      throw new Error("rollback destination verification failed");
    }
  }
}

function changeDetails(change: PreparedChange): PatchChange {
  const operation = change.operation;
  const base = {
    path: operation.kind === "UPDATE" && operation.moveTo ? operation.moveTo : operation.path,
    additions: change.additions,
    deletions: change.deletions,
    ...(change.beforeVersion === undefined ? {} : { beforeHash: change.beforeVersion.sha256 }),
    ...(change.afterVersion === undefined ? {} : { afterHash: change.afterVersion.sha256 }),
  };
  if (operation.kind === "UPDATE" && operation.moveTo) {
    return { kind: "MOVE", ...base, fromPath: operation.path, toPath: operation.moveTo };
  }
  return { kind: operation.kind, ...base };
}

export async function commitPatch(
  prepared: PreparedPatch,
  filesystem: PatchMutationFileSystem,
): Promise<PatchCommitResult> {
  await guardAll(prepared, filesystem);
  const applied: PreparedChange[] = [];
  const createdDirectories: string[] = [];
  try {
    for (const change of prepared.changes) {
      applied.push(change);
      await applyChange(change, filesystem, createdDirectories);
    }
    for (const change of prepared.changes) await verifyChange(change, filesystem);
  } catch {
    try {
      await rollback(applied, createdDirectories, filesystem);
    } catch {
      throw new RuntimePatchUncertainError();
    }
    throw new RuntimePatchError("PATCH_COMMIT_FAILED_ROLLED_BACK");
  }
  return {
    ok: true,
    changeCount: prepared.changes.length,
    changes: prepared.changes.slice(0, 100).map(changeDetails),
  };
}
