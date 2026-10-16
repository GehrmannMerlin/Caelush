import {
  CaelushClient,
  CaelushClientHttpError,
  CaelushClientProtocolError,
  CaelushProtocolCompatibilityError,
  requireArchiveManagement,
} from "@caelush/client";
import {
  ArchiveSessionListQuerySchema,
  ArchiveWorkspaceListQuerySchema,
  ArchiveTargetSchema,
  ArchiveDeletionSelectionSchema,
  PermanentDeletionRequestSchema,
  RestoreArchiveRequestSchema,
  SessionIdSchema,
  SessionTranscriptQuerySchema,
  type ArchiveSessionListQuery,
  type ArchiveWorkspaceListQuery,
  type ArchiveTarget,
  type ArchiveDeletionSelection,
  type PermanentDeletionRequest,
  type SessionId,
  type SessionTranscriptQuery,
} from "@caelush/protocol";
import type { DesktopDaemonSupervisor } from "../daemon/supervisor.js";
import type { DesktopDaemonProxyLease } from "../protocol/local-proxy.js";
import { ownedDaemonHeaders } from "../protocol/daemon-authorization.js";

export class DesktopArchiveError extends Error {
  constructor(
    readonly code:
      | "ARCHIVE_SCOPE_CHANGED"
      | "ARCHIVE_MANAGEMENT_UNAVAILABLE"
      | "LOCAL_AGENT_UNAVAILABLE"
      | "DESKTOP_ACCOUNT_UNAUTHORIZED"
      | "IPC_RESPONSE_INVALID",
  ) {
    const messages = {
      ARCHIVE_SCOPE_CHANGED: "当前账号或本地服务已切换，请刷新归档页。",
      ARCHIVE_MANAGEMENT_UNAVAILABLE: "当前本地服务不支持归档管理，请重建或更新客户端。",
      LOCAL_AGENT_UNAVAILABLE: "本地 Agent 暂不可用，请稍后重试。",
      DESKTOP_ACCOUNT_UNAUTHORIZED: "请先登录并授权当前账号。",
      IPC_RESPONSE_INVALID: "本地服务返回了无法识别的归档数据。",
    };
    super(messages[code]);
    this.name = "DesktopArchiveError";
  }
}
export interface DesktopArchiveControllerOptions {
  readonly supervisor: Pick<
    DesktopDaemonSupervisor,
    "acquireProxyLease" | "getActiveProfileIdentity"
  >;
  readonly getAuthorizedUserId?: () => string | null;
  readonly fetcher?: typeof fetch;
}
export class DesktopArchiveController {
  private compatibleIdentity: string | undefined;
  constructor(private readonly options: DesktopArchiveControllerOptions) {}
  listSessions(input: Partial<ArchiveSessionListQuery>, signal: AbortSignal) {
    const query = ArchiveSessionListQuerySchema.parse(input);
    return this.withClient(signal, (client, signal) =>
      client.listArchivedSessions(query, { signal }),
    );
  }
  listWorkspaces(input: Partial<ArchiveWorkspaceListQuery>, signal: AbortSignal) {
    const query = ArchiveWorkspaceListQuerySchema.parse(input);
    return this.withClient(signal, (client, signal) =>
      client.listArchivedWorkspaces(query, { signal }),
    );
  }
  getState(input: ArchiveTarget, signal: AbortSignal) {
    const target = ArchiveTargetSchema.parse(input);
    return this.withClient(signal, (client, signal) => client.getArchiveState(target, { signal }));
  }
  archive(input: ArchiveTarget, signal: AbortSignal) {
    const target = ArchiveTargetSchema.parse(input);
    return this.withClient(signal, (client, signal) =>
      target.type === "SESSION"
        ? client.archiveSession(target.sessionId, { signal })
        : client.archiveWorkspace(target.workspaceId, { signal }),
    );
  }
  restore(input: { target: ArchiveTarget; archiveId: string }, signal: AbortSignal) {
    const target = ArchiveTargetSchema.parse(input.target);
    const request = RestoreArchiveRequestSchema.parse({ archiveId: input.archiveId });
    return this.withClient(signal, (client, signal) =>
      target.type === "SESSION"
        ? client.restoreSession(target.sessionId, request, { signal })
        : client.restoreWorkspace(target.workspaceId, request, { signal }),
    );
  }
  previewDeletion(input: ArchiveDeletionSelection, signal: AbortSignal) {
    const selection = ArchiveDeletionSelectionSchema.parse(input);
    return this.withClient(signal, (client, signal) =>
      client.previewArchiveDeletion(selection, { signal }),
    );
  }
  permanentlyDelete(input: PermanentDeletionRequest, signal: AbortSignal) {
    const request = PermanentDeletionRequestSchema.parse(input);
    return this.withClient(signal, (client, signal) =>
      client.permanentlyDeleteArchives(request, { signal }),
    );
  }
  readTranscript(
    input: { sessionId: SessionId; query?: Partial<SessionTranscriptQuery> | undefined },
    signal: AbortSignal,
  ) {
    const id = SessionIdSchema.parse(input.sessionId);
    const query = SessionTranscriptQuerySchema.parse(input.query ?? {});
    return this.withClient(signal, (client, signal) =>
      client.getSessionTranscript(id, query, { signal }),
    );
  }
  private assertCurrent(
    lease: Pick<DesktopDaemonProxyLease, "userId" | "profileId" | "generationId">,
  ): void {
    if (
      this.options.getAuthorizedUserId !== undefined &&
      this.options.getAuthorizedUserId() !== lease.userId
    )
      throw new DesktopArchiveError("ARCHIVE_SCOPE_CHANGED");
    const current = this.options.supervisor.getActiveProfileIdentity();
    if (
      current === null ||
      current.userId !== lease.userId ||
      current.profileId !== lease.profileId ||
      current.generationId !== lease.generationId
    )
      throw new DesktopArchiveError("ARCHIVE_SCOPE_CHANGED");
  }
  private async withClient<T>(
    signal: AbortSignal,
    action: (client: CaelushClient, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (
      this.options.getAuthorizedUserId !== undefined &&
      this.options.getAuthorizedUserId() === null
    )
      throw new DesktopArchiveError("DESKTOP_ACCOUNT_UNAUTHORIZED");
    const identity = this.options.supervisor.getActiveProfileIdentity();
    if (identity === null) throw new DesktopArchiveError("LOCAL_AGENT_UNAVAILABLE");
    this.assertCurrent(identity);
    const lease = this.options.supervisor.acquireProxyLease(signal);
    if (lease === null) throw new DesktopArchiveError("LOCAL_AGENT_UNAVAILABLE");
    try {
      this.assertCurrent(lease);
      const headers = ownedDaemonHeaders(lease);
      if (headers === null) throw new DesktopArchiveError("LOCAL_AGENT_UNAVAILABLE");
      const fetcher = this.options.fetcher ?? globalThis.fetch.bind(globalThis);
      const client = new CaelushClient({
        baseUrl: lease.baseUrl,
        headers,
        fetch: (input, init) => fetcher(input, { ...init, redirect: "error" }),
      });
      const key = JSON.stringify([lease.userId, lease.profileId, lease.generationId]);
      if (key !== this.compatibleIdentity) {
        const info = await client.getInfo({ signal: lease.signal });
        this.assertCurrent(lease);
        requireArchiveManagement(info);
        this.compatibleIdentity = key;
      }
      this.assertCurrent(lease);
      lease.signal.throwIfAborted();
      const response = await action(client, lease.signal);
      this.assertCurrent(lease);
      lease.signal.throwIfAborted();
      return response;
    } catch (error) {
      this.assertCurrent(lease);
      if (error instanceof DesktopArchiveError || error instanceof CaelushClientHttpError)
        throw error;
      if (error instanceof CaelushProtocolCompatibilityError)
        throw new DesktopArchiveError("ARCHIVE_MANAGEMENT_UNAVAILABLE");
      if (error instanceof CaelushClientProtocolError)
        throw new DesktopArchiveError("IPC_RESPONSE_INVALID");
      throw new DesktopArchiveError("LOCAL_AGENT_UNAVAILABLE");
    } finally {
      lease.release();
    }
  }
}
