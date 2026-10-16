import { setImmediate } from "node:timers/promises";
import { createTimestampMs, type WorkspaceRecord } from "@caelush/protocol";
import type {
  ArchiveStore,
  LegacyArchiveCandidate,
  LegacyArchiveEntry,
  LegacyArchiveReconcileResult,
} from "@caelush/storage";
import { displayNameForWorkspacePath, historicalWorkspaceRef } from "./workspace-identity.js";

function entry(candidate: LegacyArchiveCandidate): LegacyArchiveEntry {
  const refs = [
    ...(candidate.session.defaultWorkspace === undefined
      ? []
      : [candidate.session.defaultWorkspace]),
    ...candidate.runWorkspaces,
  ];
  const normalized = refs.map(historicalWorkspaceRef);
  const first = normalized[0];
  let workspace: WorkspaceRecord | undefined;
  if (
    !candidate.ambiguous &&
    first !== undefined &&
    first.id === candidate.session.workspaceId &&
    normalized.every((ref) => ref?.id === first.id && ref.path === first.path)
  ) {
    const stamp = createTimestampMs(candidate.session.createdAt);
    workspace = {
      id: first.id,
      canonicalPath: first.path,
      displayName: displayNameForWorkspacePath(first.path),
      createdAt: stamp,
      updatedAt: candidate.session.updatedAt,
      lastOpenedAt: candidate.session.updatedAt,
    };
  }
  return {
    sessionId: candidate.session.id,
    expectedEvidenceDigest: candidate.evidenceDigest,
    ...(workspace === undefined ? {} : { workspace }),
  };
}
export class LegacyArchiveReconciler {
  private pending: Promise<LegacyArchiveReconcileResult> | undefined;
  constructor(private readonly archives: ArchiveStore) {}
  reconcile(): Promise<LegacyArchiveReconcileResult> {
    if (this.pending !== undefined) return this.pending;
    const promise = this.run();
    this.pending = promise;
    void promise
      .finally(() => {
        if (this.pending === promise) this.pending = undefined;
      })
      .catch(() => undefined);
    return promise;
  }
  private async run(): Promise<LegacyArchiveReconcileResult> {
    const migratedSessionIds: LegacyArchiveReconcileResult["migratedSessionIds"][number][] = [],
      deferredSessionIds: LegacyArchiveReconcileResult["deferredSessionIds"][number][] = [];
    let cursor: string | undefined;
    let catalogRevision = 0;
    do {
      const page = await this.archives.listLegacyArchiveCandidates(cursor);
      const result = await this.archives.reconcileLegacyEntries(page.items.map(entry));
      migratedSessionIds.push(...result.migratedSessionIds);
      deferredSessionIds.push(...result.deferredSessionIds);
      catalogRevision = result.catalogRevision;
      cursor = page.nextCursor;
      if (cursor !== undefined) await setImmediate();
    } while (cursor !== undefined);
    return { migratedSessionIds, deferredSessionIds, catalogRevision };
  }
}
