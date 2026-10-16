import {
  createTimestampMs,
  type ArchiveDeletionSelection,
  type ArchiveSessionListQuery,
  type ArchiveTarget,
  type ArchiveWorkspaceListQuery,
  type LegacyArchiveImportRequest,
} from "@caelush/protocol";
import type { ArchiveDeletionCommit, ArchiveStore } from "@caelush/storage";
import { StorageArchiveConflictError } from "@caelush/storage";
import type { LegacyArchiveReconciler } from "../workspaces/legacy-archive-reconciler.js";
import { createArchiveConfirmationCodec } from "./archive-confirmation.js";

export interface ArchiveServiceOptions {
  readonly archives: ArchiveStore;
  readonly reconciler: LegacyArchiveReconciler;
  readonly scopeId: string;
  readonly onDeleted: (commit: ArchiveDeletionCommit) => void | Promise<void>;
  readonly onInvalidationError?: () => void;
  readonly now?: () => number;
  readonly signingKey?: Uint8Array;
}
export class ArchiveService {
  private readonly codec: ReturnType<typeof createArchiveConfirmationCodec>;
  private readonly now: () => number;
  constructor(private readonly options: ArchiveServiceOptions) {
    this.now = options.now ?? Date.now;
    this.codec = createArchiveConfirmationCodec({
      scopeId: options.scopeId,
      now: this.now,
      ...(options.signingKey === undefined ? {} : { key: options.signingKey }),
    });
  }
  async listSessions(query: ArchiveSessionListQuery) {
    await this.options.reconciler.reconcile();
    return this.options.archives.listSessions(query);
  }
  async listWorkspaces(query: ArchiveWorkspaceListQuery) {
    await this.options.reconciler.reconcile();
    return this.options.archives.listWorkspaces(query);
  }
  getState(target: ArchiveTarget) {
    return this.options.archives.getState(target);
  }
  archive(target: ArchiveTarget) {
    return this.options.archives.archive(target, createTimestampMs(this.now()));
  }
  restore(target: ArchiveTarget, archiveId: string) {
    return this.options.archives.restore(target, archiveId);
  }
  importLegacyMarkers(input: LegacyArchiveImportRequest) {
    return this.options.archives.importLegacyMarkers(input);
  }
  async previewDeletion(selection: ArchiveDeletionSelection) {
    const snapshot = await this.options.archives.snapshotDeletion(selection);
    if (snapshot.counts.sessions === 0 && snapshot.counts.workspaces === 0)
      throw new StorageArchiveConflictError(
        "INVALID_REQUEST",
        "No archived objects match this selection.",
      );
    const issued = this.codec.issue(snapshot);
    return {
      counts: snapshot.counts,
      samples: snapshot.samples,
      confirmationToken: issued.token,
      expiresAt: issued.expiresAt,
    };
  }
  async permanentlyDelete(token: string) {
    const confirmed = this.codec.verify(token);
    const commit = await this.options.archives.purge(confirmed.selection, confirmed.digest);
    try {
      await this.options.onDeleted(commit);
    } catch {
      try {
        this.options.onInvalidationError?.();
      } catch {
        /* Diagnostics cannot change an already committed deletion. */
      }
    }
    return commit.response;
  }
}
