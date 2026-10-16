import type { CaelushClient } from "@caelush/client";
import {
  ArchiveSessionFilterSchema,
  ArchiveWorkspaceFilterSchema,
  type ArchiveSessionFilter,
  type ArchiveWorkspaceFilter,
  type ArchiveSessionListResponse,
  type ArchiveSessionItem,
  type ArchiveWorkspaceListResponse,
  type ArchiveDeletionSelection,
  type ArchiveDeletionPreviewResponse,
  type ArchiveState,
  type SessionId,
  type TranscriptEntry,
  type WorkspaceId,
} from "@caelush/protocol";
import { archiveErrorMessage } from "./archive-errors.js";

export type ArchivePageClient = Pick<
  CaelushClient,
  | "listArchivedSessions"
  | "listArchivedWorkspaces"
  | "getArchiveState"
  | "restoreSession"
  | "restoreWorkspace"
  | "previewArchiveDeletion"
  | "permanentlyDeleteArchives"
  | "getSessionTranscript"
>;
interface ArchiveError {
  readonly code: string;
  readonly message: string;
}
export interface ArchiveManagerSnapshot {
  readonly tab: "SESSIONS" | "WORKSPACES";
  readonly sessionFilter: ArchiveSessionFilter;
  readonly workspaceFilter: ArchiveWorkspaceFilter;
  readonly sessions?: ArchiveSessionListResponse | undefined;
  readonly workspaces?: ArchiveWorkspaceListResponse | undefined;
  readonly status: "IDLE" | "LOADING" | "READY" | "ERROR";
  readonly error?: ArchiveError | undefined;
  readonly deletion?:
    | {
        readonly selection: ArchiveDeletionSelection;
        readonly preview?: ArchiveDeletionPreviewResponse | undefined;
        readonly status: "LOADING" | "READY" | "SUBMITTING" | "ERROR";
        readonly error?: ArchiveError | undefined;
      }
    | undefined;
  readonly history?:
    | {
        readonly sessionId: SessionId;
        readonly title: string;
        readonly items: readonly TranscriptEntry[];
        readonly nextCursor?: string | undefined;
        readonly loading: boolean;
        readonly error?: ArchiveError | undefined;
      }
    | undefined;
}
function safeError(error: unknown): ArchiveError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "ARCHIVE_REQUEST_FAILED";
  return { code, message: archiveErrorMessage(error) };
}
function unique<T>(items: readonly T[], id: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [id(item), item])).values()];
}
export class WebArchiveManager {
  private snapshot: ArchiveManagerSnapshot = {
    tab: "SESSIONS",
    sessionFilter: {},
    workspaceFilter: {},
    status: "IDLE",
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private historyGeneration = 0;
  private deletionGeneration = 0;
  private request: AbortController | undefined;
  private historyRequest: AbortController | undefined;
  private deletionRequest: AbortController | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private disposed = false;
  private workspaceOptions: readonly ArchiveSessionItem["group"][] = [];
  private facetRevision: number | undefined;
  private facetPendingRevision: number | undefined;
  private facetRequest: AbortController | undefined;
  constructor(
    private readonly client: ArchivePageClient,
    private readonly options: {
      readonly isVisible?: () => boolean;
      readonly onMutation?: () => void;
      readonly onParentWorkspaceRequired?: (workspaceId: WorkspaceId) => void;
    } = {},
  ) {
    this.refreshTimer = setInterval(() => {
      if (
        !this.disposed &&
        (this.options.isVisible?.() ??
          (typeof document === "undefined" || document.visibilityState !== "hidden")) &&
        this.snapshot.status !== "LOADING" &&
        this.snapshot.deletion?.status !== "SUBMITTING"
      )
        void this.refresh();
    }, 5000);
  }
  getSnapshot(): ArchiveManagerSnapshot {
    return this.snapshot;
  }
  getWorkspaceOptions(): readonly ArchiveSessionItem["group"][] {
    return this.workspaceOptions;
  }
  private async refreshWorkspaceOptions(revision: number, count: number): Promise<void> {
    if (this.disposed || revision === this.facetRevision || revision === this.facetPendingRevision)
      return;
    this.facetRequest?.abort();
    const request = new AbortController();
    this.facetRequest = request;
    this.facetPendingRevision = revision;
    try {
      const groups = new Map<string, ArchiveSessionItem["group"]>();
      let cursor: string | undefined;
      const seen = new Set<string>();
      let processed = 0;
      while (processed < count) {
        if (
          this.disposed ||
          request.signal.aborted ||
          !(
            this.options.isVisible?.() ??
            (typeof document === "undefined" || document.visibilityState !== "hidden")
          )
        )
          return;
        const page = await this.client.listArchivedSessions(
          { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
          { signal: request.signal },
        );
        if (page.catalogRevision !== revision) return;
        for (const item of page.items) groups.set(item.group.key, item.group);
        processed += page.items.length;
        if (page.nextCursor === undefined) break;
        if (page.items.length === 0 || seen.has(page.nextCursor))
          throw new Error("Archive pagination did not advance.");
        cursor = page.nextCursor;
        seen.add(cursor);
      }
      if (!this.disposed && !request.signal.aborted) {
        this.workspaceOptions = [...groups.values()].sort(
          (a, b) =>
            Number(a.key === "UNASSOCIATED") - Number(b.key === "UNASSOCIATED") ||
            a.displayName.localeCompare(b.displayName) ||
            a.key.localeCompare(b.key),
        );
        this.facetRevision = revision;
        this.publish({});
      }
    } catch {
      /* The list remains usable; the next visible refresh retries Workspace facets. */
    } finally {
      if (this.facetRequest === request) {
        this.facetPendingRevision = undefined;
        this.facetRequest = undefined;
      }
    }
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setTab(tab: ArchiveManagerSnapshot["tab"]): void {
    if (
      this.disposed ||
      tab === this.snapshot.tab ||
      this.snapshot.deletion?.status === "SUBMITTING"
    )
      return;
    clearTimeout(this.searchTimer);
    this.cancelDeletion();
    this.closeHistory();
    this.request?.abort();
    ++this.generation;
    this.publish({ tab, sessions: undefined, workspaces: undefined, error: undefined });
    void this.refresh();
  }
  setFilter(filter: ArchiveSessionFilter | ArchiveWorkspaceFilter): void {
    if (this.disposed || this.snapshot.deletion?.status === "SUBMITTING") return;
    const parsed =
      this.snapshot.tab === "SESSIONS"
        ? ArchiveSessionFilterSchema.parse(filter)
        : ArchiveWorkspaceFilterSchema.parse(filter);
    this.request?.abort();
    ++this.generation;
    clearTimeout(this.searchTimer);
    this.cancelDeletion();
    this.publish({
      ...(this.snapshot.tab === "SESSIONS"
        ? { sessionFilter: parsed, sessions: undefined }
        : { workspaceFilter: parsed, workspaces: undefined }),
      status: "LOADING",
      error: undefined,
    });
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      void this.refresh();
    }, 250);
  }
  async refresh(): Promise<void> {
    await this.readPage(false);
  }
  async loadMore(): Promise<void> {
    if (this.snapshot.status !== "LOADING") await this.readPage(true);
  }
  private async readPage(more: boolean): Promise<void> {
    if (this.disposed) return;
    const tab = this.snapshot.tab;
    const prior = tab === "SESSIONS" ? this.snapshot.sessions : this.snapshot.workspaces;
    if (more && prior?.nextCursor === undefined) return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const generation = ++this.generation;
    this.publish({ status: "LOADING", error: undefined });
    try {
      if (tab === "SESSIONS") {
        const filter = this.snapshot.sessionFilter;
        const old = this.snapshot.sessions;
        let result = await this.client.listArchivedSessions(
          { ...filter, limit: 50, ...(more ? { cursor: old!.nextCursor! } : {}) },
          { signal: request.signal },
        );
        if (more && old !== undefined)
          result = {
            ...result,
            items: unique([...old.items, ...result.items], (item) => item.sessionId),
          };
        const keep = more ? 0 : (old?.items.length ?? 0);
        while (result.items.length < keep && result.nextCursor !== undefined) {
          if (!this.current(generation, request)) return;
          const cursor = result.nextCursor;
          const next = await this.client.listArchivedSessions(
            { ...filter, limit: 50, cursor: result.nextCursor },
            { signal: request.signal },
          );
          result = {
            ...next,
            items: unique([...result.items, ...next.items], (item) => item.sessionId),
          };
          if (result.nextCursor === cursor) throw new Error("Archive pagination did not advance.");
        }
        if (this.current(generation, request))
          this.publish({ sessions: result, status: "READY", error: undefined });
        if (this.current(generation, request))
          void this.refreshWorkspaceOptions(result.catalogRevision, result.totalCounts.sessions);
      } else {
        const filter = this.snapshot.workspaceFilter;
        const old = this.snapshot.workspaces;
        let result = await this.client.listArchivedWorkspaces(
          { ...filter, limit: 50, ...(more ? { cursor: old!.nextCursor! } : {}) },
          { signal: request.signal },
        );
        if (more && old !== undefined)
          result = {
            ...result,
            items: unique([...old.items, ...result.items], (item) => item.workspace.id),
          };
        const keep = more ? 0 : (old?.items.length ?? 0);
        while (result.items.length < keep && result.nextCursor !== undefined) {
          if (!this.current(generation, request)) return;
          const cursor = result.nextCursor;
          const next = await this.client.listArchivedWorkspaces(
            { ...filter, limit: 50, cursor: result.nextCursor },
            { signal: request.signal },
          );
          result = {
            ...next,
            items: unique([...result.items, ...next.items], (item) => item.workspace.id),
          };
          if (result.nextCursor === cursor) throw new Error("Archive pagination did not advance.");
        }
        if (this.current(generation, request))
          this.publish({ workspaces: result, status: "READY", error: undefined });
      }
      const history = this.snapshot.history;
      if (this.current(generation, request) && history !== undefined) {
        try {
          await this.client.getArchiveState(
            { type: "SESSION", sessionId: history.sessionId },
            { signal: request.signal },
          );
        } catch (error) {
          if (
            this.current(generation, request) &&
            this.snapshot.history?.sessionId === history.sessionId
          ) {
            ++this.historyGeneration;
            this.historyRequest?.abort();
            this.publish({
              history: {
                ...history,
                items: [],
                nextCursor: undefined,
                loading: false,
                error: safeError(error),
              },
            });
          }
        }
      }
    } catch (error) {
      if (!this.current(generation, request)) return;
      if (safeError(error).code === "ARCHIVE_LIST_CHANGED" && more) {
        await this.refresh();
        return;
      }
      this.publish({ status: "ERROR", error: safeError(error) });
    }
  }
  async previewDeletion(selection: ArchiveDeletionSelection): Promise<void> {
    if (this.disposed || this.snapshot.deletion?.status === "SUBMITTING") return;
    this.deletionRequest?.abort();
    const request = new AbortController();
    this.deletionRequest = request;
    const generation = ++this.deletionGeneration;
    this.publish({ deletion: { selection, status: "LOADING" } });
    try {
      const preview = await this.client.previewArchiveDeletion(selection, {
        signal: request.signal,
      });
      if (!this.disposed && !request.signal.aborted && generation === this.deletionGeneration)
        this.publish({ deletion: { selection, preview, status: "READY" } });
    } catch (error) {
      if (!this.disposed && !request.signal.aborted && generation === this.deletionGeneration)
        this.publish({ deletion: { selection, status: "ERROR", error: safeError(error) } });
    }
  }
  cancelDeletion(): void {
    if (this.snapshot.deletion?.status === "SUBMITTING") return;
    ++this.deletionGeneration;
    this.deletionRequest?.abort();
    this.publish({ deletion: undefined });
  }
  async confirmDeletion(): Promise<void> {
    const deletion = this.snapshot.deletion;
    if (this.disposed || deletion?.status !== "READY" || deletion.preview === undefined) return;
    if (Date.now() >= deletion.preview.expiresAt) {
      this.publish({
        deletion: {
          selection: deletion.selection,
          status: "ERROR",
          preview: undefined,
          error: safeError({ code: "ARCHIVE_CONFIRMATION_EXPIRED" }),
        },
      });
      return;
    }
    this.publish({ deletion: { ...deletion, status: "SUBMITTING" } });
    try {
      await this.client.permanentlyDeleteArchives(
        { confirmationToken: deletion.preview.confirmationToken },
        {},
      );
      if (this.disposed) return;
      this.publish({ deletion: undefined });
      this.closeHistory();
      this.mutated();
      await this.refresh();
    } catch (error) {
      if (this.disposed) return;
      this.publish({
        deletion: {
          selection: deletion.selection,
          status: "ERROR",
          preview: undefined,
          error: safeError(error),
        },
      });
      await this.refresh();
    }
  }
  async restore(state: ArchiveState): Promise<void> {
    if (this.disposed) return;
    if (state.restoreDisposition === "PARENT_ARCHIVED" && state.parentWorkspace !== undefined) {
      const parentId = state.parentWorkspace.workspaceId;
      const name = this.snapshot.sessions?.items.find(
        (item) => item.state.parentWorkspace?.workspaceId === parentId,
      )?.group.displayName;
      this.setTab("WORKSPACES");
      if (name !== undefined) this.setFilter({ query: name });
      this.options.onParentWorkspaceRequired?.(parentId);
      return;
    }
    if (state.restoreDisposition !== "AVAILABLE" || state.ownArchive === undefined) return;
    this.publish({ status: "LOADING", error: undefined });
    try {
      if (state.target.type === "SESSION")
        await this.client.restoreSession(state.target.sessionId, {
          archiveId: state.ownArchive.archiveId,
        });
      else
        await this.client.restoreWorkspace(state.target.workspaceId, {
          archiveId: state.ownArchive.archiveId,
        });
      if (this.disposed) return;
      this.mutated();
      await this.refresh();
    } catch (error) {
      this.publish({ status: "ERROR", error: safeError(error) });
    }
  }
  async openHistory(sessionId: SessionId): Promise<void> {
    if (this.disposed) return;
    this.closeHistory();
    this.publish({
      history: {
        sessionId,
        title:
          this.snapshot.sessions?.items.find((item) => item.sessionId === sessionId)?.title ??
          "归档会话",
        items: [],
        loading: true,
      },
    });
    await this.readHistory(false);
  }
  async loadMoreHistory(): Promise<void> {
    if (this.snapshot.history?.nextCursor !== undefined && !this.snapshot.history.loading)
      await this.readHistory(true);
  }
  closeHistory(): void {
    ++this.historyGeneration;
    this.historyRequest?.abort();
    this.publish({ history: undefined });
  }
  private async readHistory(more: boolean): Promise<void> {
    const history = this.snapshot.history;
    if (history === undefined || this.disposed) return;
    this.historyRequest?.abort();
    const request = new AbortController();
    this.historyRequest = request;
    const generation = ++this.historyGeneration;
    this.publish({ history: { ...history, loading: true, error: undefined } });
    try {
      await this.client.getArchiveState(
        { type: "SESSION", sessionId: history.sessionId },
        { signal: request.signal },
      );
      const response = await this.client.getSessionTranscript(
        history.sessionId,
        {
          limit: 100,
          ...(more && history.nextCursor !== undefined ? { cursor: history.nextCursor } : {}),
        },
        { signal: request.signal },
      );
      if (!this.disposed && !request.signal.aborted && generation === this.historyGeneration)
        this.publish({
          history: {
            ...history,
            items: unique([...(more ? history.items : []), ...response.items], (item) => item.id),
            nextCursor: response.nextCursor,
            loading: false,
            error: undefined,
          },
        });
    } catch (error) {
      if (!this.disposed && !request.signal.aborted && generation === this.historyGeneration)
        this.publish({
          history: {
            ...history,
            items: [],
            nextCursor: undefined,
            loading: false,
            error: safeError(error),
          },
        });
    }
  }
  dispose(): void {
    this.disposed = true;
    ++this.generation;
    ++this.historyGeneration;
    ++this.deletionGeneration;
    clearTimeout(this.searchTimer);
    clearInterval(this.refreshTimer);
    this.request?.abort();
    this.historyRequest?.abort();
    this.deletionRequest?.abort();
    this.listeners.clear();
    this.facetRequest?.abort();
    this.workspaceOptions = [];
  }
  private current(generation: number, request: AbortController): boolean {
    return !this.disposed && !request.signal.aborted && generation === this.generation;
  }
  private mutated(): void {
    try {
      this.options.onMutation?.();
    } catch {
      /* Presentation refresh cannot undo a committed mutation. */
    }
  }
  private publish(patch: Partial<ArchiveManagerSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
