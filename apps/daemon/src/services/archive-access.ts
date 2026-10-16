import type { ArchiveTarget } from "@caelush/protocol";
import { StorageArchiveConflictError, type ArchiveStore } from "@caelush/storage";

/** Early feedback; the Storage write boundary checks again atomically. */
export async function requireUnarchivedTarget(
  archives: Pick<ArchiveStore, "getState"> | undefined,
  target: ArchiveTarget,
): Promise<void> {
  if (archives !== undefined && (await archives.getState(target)).archived) {
    throw new StorageArchiveConflictError(
      target.type === "WORKSPACE" ? "WORKSPACE_ARCHIVED" : "OBJECT_ARCHIVED",
      "Restore the archived item before changing it.",
    );
  }
}
