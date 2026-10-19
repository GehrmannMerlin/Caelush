import {
  AttachmentDescriptorSchema,
  AttachmentDraftResponseSchema,
  AttachmentDraftWriteRequestSchema,
  AttachmentIdSchema,
  AttachmentMetadataResponseSchema,
  AttachmentMediaTypeSchema,
  AttachmentNameSchema,
  AttachmentOwnerSchema,
  PublicRunEventSchema,
  ApprovalListResponseSchema,
  ApprovalResolutionRequestSchema,
  AIModelDirectoryResponseSchema,
  AIProviderConnectionResponseSchema,
  AIProvidersResponseSchema,
  AIDefaultSelectionResponseSchema,
  ConnectProviderRequestSchema,
  ApiErrorResponseSchema,
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  ContextUsageResponseSchema,
  CreateRunRequestSchema,
  CreateSessionRequestSchema,
  CreateWorkspaceRequestSchema,
  DaemonInfoSchema,
  HealthResponseSchema,
  RunActionResponseSchema,
  RunInputListQuerySchema,
  RunInputListResponseSchema,
  RunInputReceiptSchema,
  SubmitRunInputRequestSchema,
  SecurityCapabilitiesResponseSchema,
  SecurityPreparationRequestSchema,
  SecurityPreparationResponseSchema,
  RunListQuerySchema,
  RunListResponseSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  SessionTranscriptQuerySchema,
  SessionTranscriptResponseSchema,
  UsageActivityQuerySchema,
  UsageActivityResponseSchema,
  UsageSummaryQuerySchema,
  UsageSummaryResponseSchema,
  SessionContinuityPreflightQuerySchema,
  SessionContinuityPreflightResponseSchema,
  SessionTurnPresentationQuerySchema,
  SessionTurnPresentationResponseSchema,
  UpdateAISelectionRequestSchema,
  UpdateSessionModelSelectionRequestSchema,
  WorkspaceListResponseSchema,
  WorkspaceDirectoryPickerResponseSchema,
  WorkspaceRecordSchema,
  WorkspaceSecurityCapabilitiesResponseSchema,
  WorkspaceSessionListResponseSchema,
  WorkspaceIdSchema,
  type PublicRunEvent,
  type AttachmentDescriptor,
  type AttachmentDraft,
  type AttachmentOwner,
  type AttachmentId,
  type AttachmentDraftItem,
  type SubmissionId,
  type ApiErrorCode,
  type ApprovalListResponse,
  type ApprovalResolutionRequest,
  type AIModelDirectoryResponse,
  type AIProviderConnectionResponse,
  type AIProvidersResponse,
  type AIDefaultSelectionResponse,
  type ConnectProviderRequest,
  type ClientAgentRun,
  type ClientAgentSession,
  type ContextUsageResponse,
  type CreateRunRequest,
  type CreateSessionRequest,
  type CreateWorkspaceRequest,
  type DaemonInfo,
  type HealthResponse,
  type RunActionResponse,
  type RunInputListQuery,
  type RunInputListResponse,
  type RunInputReceipt,
  type SubmitRunInputRequest,
  type RunId,
  type RunListQuery,
  type SessionId,
  type SessionListQuery,
  type SessionListResponse,
  type SessionTranscriptQuery,
  type SessionTranscriptResponse,
  type UsageActivityQuery,
  type UsageActivityResponse,
  type UsageSummaryQuery,
  type UsageSummaryResponse,
  type SessionContinuityPreflightQuery,
  type SessionContinuityPreflightResponse,
  type SessionTurnPresentationQuery,
  type SessionTurnPresentationResponse,
  type UpdateAISelectionRequest,
  type UpdateSessionModelSelectionRequest,
  type WorkspaceId,
  type WorkspaceListResponse,
  type WorkspaceDirectoryPickerResponse,
  type WorkspaceRecord,
  type WorkspaceSecurityCapabilitiesResponse,
  type WorkspaceSessionListResponse,
  type SecurityCapabilitiesResponse,
  type SecurityPreparationResponse,
  type PermissionPresetSelection,
} from "@caelush/protocol";

import { ApprovalRequestIdSchema } from "@caelush/protocol";
import {
  ArchiveSessionListQuerySchema,
  ArchiveSessionListResponseSchema,
  ArchiveWorkspaceListQuerySchema,
  ArchiveWorkspaceListResponseSchema,
  ArchiveTargetSchema,
  ArchiveStateSchema,
  ArchiveMutationResponseSchema,
  ArchiveDeletionSelectionSchema,
  ArchiveDeletionPreviewResponseSchema,
  RestoreArchiveRequestSchema,
  PermanentDeletionRequestSchema,
  PermanentDeletionResponseSchema,
  LegacyArchiveImportRequestSchema,
  LegacyArchiveImportResponseSchema,
  SessionIdSchema,
  type ArchiveSessionListQuery,
  type ArchiveSessionListResponse,
  type ArchiveWorkspaceListQuery,
  type ArchiveWorkspaceListResponse,
  type ArchiveTarget,
  type ArchiveState,
  type ArchiveMutationResponse,
  type ArchiveDeletionSelection,
  type ArchiveDeletionPreviewResponse,
  type RestoreArchiveRequest,
  type PermanentDeletionRequest,
  type PermanentDeletionResponse,
  type LegacyArchiveImportRequest,
  type LegacyArchiveImportResponse,
} from "@caelush/protocol";

interface AttachmentUploadProgressEvent {
  readonly loaded: number;
}

interface AttachmentUploadRequest {
  readonly upload: {
    onprogress: ((event: AttachmentUploadProgressEvent) => void) | null;
  };
  status: number;
  responseText: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
}

type AttachmentUploadGlobal = typeof globalThis & {
  XMLHttpRequest?: new () => AttachmentUploadRequest;
};

const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const MAX_HTTP_ERROR_BYTES = 64 * 1024;

export interface CaelushClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface WatchRunEventsOptions {
  readonly afterSequence?: number;
  readonly signal?: AbortSignal;
  readonly onOpen?: () => void;
}

export interface CaelushClientRequestOptions {
  readonly signal?: AbortSignal;
}

export interface AttachmentUploadProgress {
  readonly loadedBytes: number;
  readonly totalBytes: number;
}

export interface AttachmentUploadOptions extends CaelushClientRequestOptions {
  readonly owner: AttachmentOwner;
  readonly name: string;
  readonly mediaType: string;
  readonly onProgress?: (progress: AttachmentUploadProgress) => void;
}

export interface AttachmentDraftWrite {
  readonly expectedRevision: number;
  readonly text: string;
  readonly artifactIds: readonly AttachmentId[];
  readonly submissionId?: SubmissionId;
}

export class CaelushClientHttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly requestId?: string;
  /** The structured, content-free detail the daemon attached, when it attached one. */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(input: {
    readonly status: number;
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly requestId?: string;
    readonly details?: Readonly<Record<string, unknown>> | undefined;
  }) {
    super(input.message);
    this.name = "CaelushClientHttpError";
    this.status = input.status;
    this.statusCode = input.status;
    this.code = input.code;
    if (input.requestId !== undefined) this.requestId = input.requestId;
    if (input.details !== undefined) this.details = input.details;
  }
}

export class CaelushClientProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaelushClientProtocolError";
  }
}

export class CaelushProtocolCompatibilityError extends CaelushClientProtocolError {
  constructor(message = "Daemon protocol version is unsupported.") {
    super(message);
    this.name = "CaelushProtocolCompatibilityError";
  }
}

export function requireArchiveManagement(info: DaemonInfo): void {
  if (info.capabilities.archiveManagementV1 !== true)
    throw new CaelushProtocolCompatibilityError(
      "Daemon archiveManagementV1 capability is required.",
    );
}

function archiveQuery(input: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) query.set(key, String(value));
  return query.toString();
}

function attachmentOwnerQuery(owner: AttachmentOwner): string {
  const parsed = AttachmentOwnerSchema.parse(owner);
  return parsed.kind === "SESSION"
    ? `ownerKind=SESSION&ownerId=${encodeURIComponent(parsed.sessionId)}`
    : `ownerKind=WORKSPACE&ownerId=${encodeURIComponent(parsed.workspaceId)}`;
}

function createAbortError(): Error {
  if (typeof DOMException !== "undefined")
    return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function xhrHttpError(status: number, responseText: string): CaelushClientHttpError {
  let body: unknown;
  try {
    body = JSON.parse(responseText.slice(0, MAX_HTTP_ERROR_BYTES));
  } catch {
    body = undefined;
  }
  const parsed = ApiErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    return new CaelushClientHttpError({
      status,
      code: parsed.data.error.code,
      message: parsed.data.error.message,
      requestId: parsed.data.error.requestId,
      ...(parsed.data.error.details === undefined ? {} : { details: parsed.data.error.details }),
    });
  }
  return new CaelushClientHttpError({
    status,
    code: "INTERNAL_ERROR",
    message: "Daemon returned an invalid error response.",
  });
}

export class CaelushClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly headers: Headers;

  constructor(options: CaelushClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = new Headers(options.headers);
  }

  async listArchivedSessions(
    input: Partial<ArchiveSessionListQuery> = {},
    options: CaelushClientRequestOptions = {},
  ): Promise<ArchiveSessionListResponse> {
    const query = ArchiveSessionListQuerySchema.parse(input);
    return this.request(
      `/api/v1/archives/sessions?${archiveQuery(query)}`,
      { method: "GET" },
      ArchiveSessionListResponseSchema,
      [200],
      options,
    );
  }
  async listArchivedWorkspaces(
    input: Partial<ArchiveWorkspaceListQuery> = {},
    options: CaelushClientRequestOptions = {},
  ): Promise<ArchiveWorkspaceListResponse> {
    const query = ArchiveWorkspaceListQuerySchema.parse(input);
    return this.request(
      `/api/v1/archives/workspaces?${archiveQuery(query)}`,
      { method: "GET" },
      ArchiveWorkspaceListResponseSchema,
      [200],
      options,
    );
  }
  async getArchiveState(
    input: ArchiveTarget,
    options: CaelushClientRequestOptions = {},
  ): Promise<ArchiveState> {
    return this.request(
      `/api/v1/archives/state?${archiveQuery(ArchiveTargetSchema.parse(input))}`,
      { method: "GET" },
      ArchiveStateSchema,
      [200],
      options,
    );
  }
  async archiveSession(
    sessionId: SessionId,
    options: CaelushClientRequestOptions = {},
  ): Promise<ArchiveMutationResponse> {
    return this.archiveMutation(
      { type: "SESSION", sessionId: SessionIdSchema.parse(sessionId) },
      "archive",
      {},
      options,
    );
  }
  async archiveWorkspace(
    workspaceId: WorkspaceId,
    options: CaelushClientRequestOptions = {},
  ): Promise<ArchiveMutationResponse> {
    return this.archiveMutation(
      { type: "WORKSPACE", workspaceId: WorkspaceIdSchema.parse(workspaceId) },
      "archive",
      {},
      options,
    );
  }
  async restoreSession(
    sessionId: SessionId,
    input: RestoreArchiveRequest,
    options: CaelushClientRequestOptions = {},
  ): Promise<ArchiveMutationResponse> {
    return this.archiveMutation(
      { type: "SESSION", sessionId: SessionIdSchema.parse(sessionId) },
      "restore",
      RestoreArchiveRequestSchema.parse(input),
      options,
    );
  }
  async restoreWorkspace(
    workspaceId: WorkspaceId,
    input: RestoreArchiveRequest,
    options: CaelushClientRequestOptions = {},
  ): Promise<ArchiveMutationResponse> {
    return this.archiveMutation(
      { type: "WORKSPACE", workspaceId: WorkspaceIdSchema.parse(workspaceId) },
      "restore",
      RestoreArchiveRequestSchema.parse(input),
      options,
    );
  }
  async previewArchiveDeletion(
    input: ArchiveDeletionSelection,
    options: CaelushClientRequestOptions = {},
  ): Promise<ArchiveDeletionPreviewResponse> {
    return this.request(
      "/api/v1/archives/deletion-preview",
      { method: "POST", body: JSON.stringify(ArchiveDeletionSelectionSchema.parse(input)) },
      ArchiveDeletionPreviewResponseSchema,
      [200],
      options,
    );
  }
  async permanentlyDeleteArchives(
    input: PermanentDeletionRequest,
    options: CaelushClientRequestOptions = {},
  ): Promise<PermanentDeletionResponse> {
    return this.request(
      "/api/v1/archives/permanent-deletions",
      { method: "POST", body: JSON.stringify(PermanentDeletionRequestSchema.parse(input)) },
      PermanentDeletionResponseSchema,
      [200],
      options,
    );
  }
  async importLegacyArchives(
    input: LegacyArchiveImportRequest,
    options: CaelushClientRequestOptions = {},
  ): Promise<LegacyArchiveImportResponse> {
    return this.request(
      "/api/v1/archives/legacy-import",
      { method: "POST", body: JSON.stringify(LegacyArchiveImportRequestSchema.parse(input)) },
      LegacyArchiveImportResponseSchema,
      [200],
      options,
    );
  }
  private archiveMutation(
    target: ArchiveTarget,
    action: "archive" | "restore",
    body: Record<string, string>,
    options: CaelushClientRequestOptions,
  ): Promise<ArchiveMutationResponse> {
    const path =
      target.type === "SESSION"
        ? `sessions/${encodeURIComponent(target.sessionId)}`
        : `workspaces/${encodeURIComponent(target.workspaceId)}`;
    return this.request(
      `/api/v1/${path}/${action}`,
      { method: "POST", body: JSON.stringify(body) },
      ArchiveMutationResponseSchema,
      [200],
      options,
    );
  }

  async getHealth(options: CaelushClientRequestOptions = {}): Promise<HealthResponse> {
    return this.request("/api/v1/health", { method: "GET" }, HealthResponseSchema, [200], options);
  }

  async getInfo(options: CaelushClientRequestOptions = {}): Promise<DaemonInfo> {
    const body = await this.requestRaw("/api/v1/info", { method: "GET" }, [200], options);
    const parsed = DaemonInfoSchema.safeParse(body);
    if (parsed.success) return parsed.data;
    if (isRecord(body) && ("apiVersion" in body || "protocolVersion" in body)) {
      throw new CaelushProtocolCompatibilityError();
    }
    throw new CaelushClientProtocolError("Daemon returned an invalid info response.");
  }

  async listWorkspaces(options: CaelushClientRequestOptions = {}): Promise<WorkspaceListResponse> {
    return this.request(
      "/api/v1/workspaces",
      { method: "GET" },
      WorkspaceListResponseSchema,
      [200],
      options,
    );
  }

  async pickWorkspaceDirectory(
    options: CaelushClientRequestOptions = {},
  ): Promise<WorkspaceDirectoryPickerResponse> {
    return this.request(
      "/api/v1/workspaces/pick",
      { method: "POST" },
      WorkspaceDirectoryPickerResponseSchema,
      [200],
      options,
    );
  }

  async createWorkspace(
    input: CreateWorkspaceRequest,
    options: CaelushClientRequestOptions = {},
  ): Promise<WorkspaceRecord> {
    const body = CreateWorkspaceRequestSchema.parse(input);
    return this.request(
      "/api/v1/workspaces",
      jsonRequest("POST", body),
      WorkspaceRecordSchema,
      [200, 201],
      options,
    );
  }

  async getWorkspace(
    workspaceId: WorkspaceId,
    options: CaelushClientRequestOptions = {},
  ): Promise<WorkspaceRecord> {
    const parsedWorkspaceId = WorkspaceIdSchema.parse(workspaceId);
    return this.request(
      `/api/v1/workspaces/${encodeURIComponent(parsedWorkspaceId)}`,
      { method: "GET" },
      WorkspaceRecordSchema,
      [200],
      options,
    );
  }

  async getSecurityCapabilities(
    options: CaelushClientRequestOptions = {},
  ): Promise<SecurityCapabilitiesResponse> {
    return this.request(
      "/api/v1/security/capabilities",
      { method: "GET" },
      SecurityCapabilitiesResponseSchema,
      [200],
      options,
    );
  }

  async getWorkspaceSecurityCapabilities(
    workspaceId: WorkspaceId,
    options: CaelushClientRequestOptions = {},
  ): Promise<WorkspaceSecurityCapabilitiesResponse> {
    const parsedWorkspaceId = WorkspaceIdSchema.parse(workspaceId);
    return this.request(
      `/api/v1/workspaces/${encodeURIComponent(parsedWorkspaceId)}/security/capabilities`,
      { method: "GET" },
      WorkspaceSecurityCapabilitiesResponseSchema,
      [200],
      options,
    );
  }

  async prepareWorkspaceSecurity(
    workspaceId: WorkspaceId,
    preset: PermissionPresetSelection,
    options: CaelushClientRequestOptions = {},
  ): Promise<SecurityPreparationResponse> {
    const parsedWorkspaceId = WorkspaceIdSchema.parse(workspaceId);
    const body = SecurityPreparationRequestSchema.parse({ preset });
    return this.request(
      `/api/v1/workspaces/${encodeURIComponent(parsedWorkspaceId)}/security/prepare`,
      jsonRequest("POST", body),
      SecurityPreparationResponseSchema,
      [200],
      options,
    );
  }

  async deleteWorkspace(
    workspaceId: WorkspaceId,
    options: CaelushClientRequestOptions = {},
  ): Promise<void> {
    const parsedWorkspaceId = WorkspaceIdSchema.parse(workspaceId);
    await this.requestRaw(
      `/api/v1/workspaces/${encodeURIComponent(parsedWorkspaceId)}`,
      { method: "DELETE" },
      [204],
      options,
      false,
    );
  }

  async listWorkspaceSessions(
    workspaceId: WorkspaceId,
    options: CaelushClientRequestOptions = {},
  ): Promise<WorkspaceSessionListResponse> {
    const parsedWorkspaceId = WorkspaceIdSchema.parse(workspaceId);
    return this.request(
      `/api/v1/workspaces/${encodeURIComponent(parsedWorkspaceId)}/sessions`,
      { method: "GET" },
      WorkspaceSessionListResponseSchema,
      [200],
      options,
    );
  }

  async createSession(
    input: CreateSessionRequest,
    options: CaelushClientRequestOptions = {},
  ): Promise<ClientAgentSession> {
    const body = CreateSessionRequestSchema.parse(input);
    return this.request(
      "/api/v1/sessions",
      jsonRequest("POST", body),
      ClientAgentSessionSchema,
      [201],
      options,
    );
  }

  uploadAttachment(blob: Blob, input: AttachmentUploadOptions): Promise<AttachmentDescriptor> {
    const owner = AttachmentOwnerSchema.parse(input.owner);
    const artifactName = AttachmentNameSchema.parse(input.name);
    const mediaType = AttachmentMediaTypeSchema.parse(input.mediaType);
    if (input.signal?.aborted) return Promise.reject(createAbortError());
    const UploadRequest = (globalThis as AttachmentUploadGlobal).XMLHttpRequest;
    if (UploadRequest === undefined) {
      return Promise.reject(
        new CaelushClientProtocolError("Attachment upload requires a browser upload transport."),
      );
    }
    return new Promise((resolve, reject) => {
      const request = new UploadRequest();
      const abort = () => request.abort();
      const cleanup = () => input.signal?.removeEventListener("abort", abort);
      request.open("POST", this.url("/api/v1/attachments"));
      for (const [name, value] of this.requestHeaders().entries()) {
        request.setRequestHeader(name, value);
      }
      request.setRequestHeader("content-type", "application/octet-stream");
      request.setRequestHeader("x-caelush-owner-kind", owner.kind);
      request.setRequestHeader(
        "x-caelush-owner-id",
        owner.kind === "SESSION" ? owner.sessionId : owner.workspaceId,
      );
      request.setRequestHeader("x-caelush-filename", encodeURIComponent(artifactName));
      request.setRequestHeader("x-caelush-filename-encoding", "uri-component-v1");
      request.setRequestHeader("x-caelush-media-type", mediaType);
      request.setRequestHeader("x-caelush-byte-length", String(blob.size));
      request.upload.onprogress = (event) => {
        try {
          input.onProgress?.({
            loadedBytes: Math.min(event.loaded, blob.size),
            totalBytes: blob.size,
          });
        } catch {
          // UI progress listeners cannot change the upload lifecycle.
        }
      };
      request.onload = () => {
        cleanup();
        if (request.status !== 201) {
          reject(xhrHttpError(request.status, request.responseText));
          return;
        }
        let response: unknown;
        try {
          response = JSON.parse(request.responseText);
        } catch {
          reject(new CaelushClientProtocolError("Daemon returned invalid attachment metadata."));
          return;
        }
        const parsed = AttachmentDescriptorSchema.safeParse(response);
        if (!parsed.success) {
          reject(new CaelushClientProtocolError("Daemon returned invalid attachment metadata."));
          return;
        }
        resolve(parsed.data);
      };
      request.onerror = () => {
        cleanup();
        reject(new CaelushClientProtocolError("Attachment upload failed."));
      };
      request.onabort = () => {
        cleanup();
        reject(createAbortError());
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted === true) {
        abort();
        return;
      }
      request.send(blob);
    });
  }

  async getAttachmentDraft(
    owner: AttachmentOwner,
    options: CaelushClientRequestOptions = {},
  ): Promise<AttachmentDraft | null> {
    const parsedOwner = AttachmentOwnerSchema.parse(owner);
    const query = attachmentOwnerQuery(parsedOwner);
    const response = await this.request(
      `/api/v1/attachment-drafts?${query}`,
      { method: "GET" },
      AttachmentDraftResponseSchema,
      [200],
      options,
    );
    return response.draft;
  }

  async saveAttachmentDraft(
    owner: AttachmentOwner,
    input: AttachmentDraftWrite,
    options: CaelushClientRequestOptions = {},
  ): Promise<AttachmentDraft> {
    const body = AttachmentDraftWriteRequestSchema.parse({ owner, ...input });
    const response = await this.request(
      "/api/v1/attachment-drafts",
      jsonRequest("PUT", body),
      AttachmentDraftResponseSchema,
      [200],
      options,
    );
    if (response.draft === null) {
      throw new CaelushClientProtocolError("Daemon returned an empty saved attachment draft.");
    }
    return response.draft;
  }

  async downloadAttachment(
    artifactId: AttachmentId,
    owner: AttachmentOwner,
    options: CaelushClientRequestOptions & { readonly inlinePreview?: boolean } = {},
  ): Promise<Blob> {
    const id = AttachmentIdSchema.parse(artifactId);
    const disposition = options.inlinePreview === true ? "inline" : "attachment";
    let response: Response;
    try {
      response = await this.fetcher(
        this.url(
          `/api/v1/attachments/${encodeURIComponent(id)}?${attachmentOwnerQuery(owner)}&disposition=${disposition}`,
        ),
        {
          method: "GET",
          headers: this.requestHeaders("*/*"),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new CaelushClientProtocolError("Attachment download failed.");
    }
    if (!response.ok) throw await this.httpError(response);
    return response.blob();
  }

  async getAttachmentMetadata(
    artifactId: AttachmentId,
    owner: AttachmentOwner,
    options: CaelushClientRequestOptions = {},
  ): Promise<AttachmentDraftItem> {
    const id = AttachmentIdSchema.parse(artifactId);
    const response = await this.request(
      `/api/v1/attachments/${encodeURIComponent(id)}/metadata?${attachmentOwnerQuery(owner)}`,
      { method: "GET" },
      AttachmentMetadataResponseSchema,
      [200],
      options,
    );
    if (response.attachment === null) {
      throw new CaelushClientProtocolError("Daemon returned empty attachment metadata.");
    }
    return response.attachment;
  }

  async listSessions(
    query: Partial<SessionListQuery> = {},
    options: CaelushClientRequestOptions = {},
  ): Promise<SessionListResponse> {
    const parsed = SessionListQuerySchema.parse(query);
    return this.request(
      `/api/v1/sessions?limit=${encodeURIComponent(String(parsed.limit))}`,
      { method: "GET" },
      SessionListResponseSchema,
      [200],
      options,
    );
  }

  async getUsageSummary(
    query: UsageSummaryQuery,
    options: CaelushClientRequestOptions = {},
  ): Promise<UsageSummaryResponse> {
    const parsed = UsageSummaryQuerySchema.parse(query);
    const search = new URLSearchParams({ sinceMs: String(parsed.sinceMs) });
    return this.request(
      `/api/v1/usage/summary?${search.toString()}`,
      { method: "GET" },
      UsageSummaryResponseSchema,
      [200],
      options,
    );
  }

  async getUsageActivity(
    query: UsageActivityQuery,
    options: CaelushClientRequestOptions = {},
  ): Promise<UsageActivityResponse> {
    const parsed = UsageActivityQuerySchema.parse(query);
    const search = new URLSearchParams({
      sinceMs: String(parsed.sinceMs),
      timezoneOffsetMinutes: String(parsed.timezoneOffsetMinutes),
    });
    return this.request(
      `/api/v1/usage/activity?${search.toString()}`,
      { method: "GET" },
      UsageActivityResponseSchema,
      [200],
      options,
    );
  }

  async getSession(
    sessionId: SessionId,
    options: CaelushClientRequestOptions = {},
  ): Promise<ClientAgentSession> {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "GET" },
      ClientAgentSessionSchema,
      [200],
      options,
    );
  }

  async listAIProviders(options: CaelushClientRequestOptions = {}): Promise<AIProvidersResponse> {
    return this.request(
      "/api/v1/ai/providers",
      { method: "GET" },
      AIProvidersResponseSchema,
      [200],
      options,
    );
  }

  async getAIModelDirectory(
    providerId?: string,
    options: CaelushClientRequestOptions = {},
  ): Promise<AIModelDirectoryResponse> {
    const suffix = providerId === undefined ? "" : `?provider=${encodeURIComponent(providerId)}`;
    return this.request(
      `/api/v1/ai/models${suffix}`,
      { method: "GET" },
      AIModelDirectoryResponseSchema,
      [200],
      options,
    );
  }

  async connectAIProvider(
    providerId: string,
    input: ConnectProviderRequest,
    options: CaelushClientRequestOptions = {},
  ): Promise<AIProviderConnectionResponse> {
    const body = ConnectProviderRequestSchema.parse(input);
    return this.request(
      `/api/v1/ai/providers/${encodeURIComponent(providerId)}/connect`,
      jsonRequest("POST", body),
      AIProviderConnectionResponseSchema,
      [200],
      options,
    );
  }

  async disconnectAIProvider(
    providerId: string,
    options: CaelushClientRequestOptions = {},
  ): Promise<void> {
    await this.requestRaw(
      `/api/v1/ai/providers/${encodeURIComponent(providerId)}/credential`,
      { method: "DELETE" },
      [204],
      options,
      false,
    );
  }

  async getDefaultAISelection(
    options: CaelushClientRequestOptions = {},
  ): Promise<AIDefaultSelectionResponse> {
    return this.request(
      "/api/v1/ai/default-selection",
      { method: "GET" },
      AIDefaultSelectionResponseSchema,
      [200],
      options,
    );
  }

  async setDefaultAISelection(
    input: UpdateAISelectionRequest,
    options: CaelushClientRequestOptions = {},
  ): Promise<AIDefaultSelectionResponse> {
    const body = UpdateAISelectionRequestSchema.parse(input);
    return this.request(
      "/api/v1/ai/default-selection",
      jsonRequest("PUT", body),
      AIDefaultSelectionResponseSchema,
      [200],
      options,
    );
  }

  async updateSessionModelSelection(
    sessionId: SessionId,
    input: UpdateSessionModelSelectionRequest,
    options: CaelushClientRequestOptions = {},
  ): Promise<ClientAgentSession> {
    const body = UpdateSessionModelSelectionRequestSchema.parse(input);
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/model-selection`,
      jsonRequest("PUT", body),
      ClientAgentSessionSchema,
      [200],
      options,
    );
  }

  async getSessionTranscript(
    sessionId: SessionId,
    query: Partial<SessionTranscriptQuery> = {},
    options: CaelushClientRequestOptions = {},
  ): Promise<SessionTranscriptResponse> {
    const parsed = SessionTranscriptQuerySchema.parse(query);
    const cursor =
      parsed.cursor === undefined ? "" : `&cursor=${encodeURIComponent(parsed.cursor)}`;
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript?limit=${encodeURIComponent(String(parsed.limit))}${cursor}`,
      { method: "GET" },
      SessionTranscriptResponseSchema,
      [200],
      options,
    );
  }

  async getSessionContinuityPreflight(
    sessionId: SessionId,
    query: SessionContinuityPreflightQuery,
    options: CaelushClientRequestOptions = {},
  ): Promise<SessionContinuityPreflightResponse> {
    const parsed = SessionContinuityPreflightQuerySchema.parse(query);
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/continuity-preflight?provider=${encodeURIComponent(parsed.provider)}&model=${encodeURIComponent(parsed.model)}`,
      { method: "GET" },
      SessionContinuityPreflightResponseSchema,
      [200],
      options,
    );
  }

  async getSessionTurnPresentation(
    sessionId: SessionId,
    query: Partial<SessionTurnPresentationQuery> = {},
    options: CaelushClientRequestOptions = {},
  ): Promise<SessionTurnPresentationResponse> {
    const parsed = SessionTurnPresentationQuerySchema.parse(query);
    const runId = parsed.runId === undefined ? "" : `&runId=${encodeURIComponent(parsed.runId)}`;
    const cursor =
      parsed.cursor === undefined ? "" : `&cursor=${encodeURIComponent(parsed.cursor)}`;
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/presentation?limit=${encodeURIComponent(String(parsed.limit))}${runId}${cursor}`,
      { method: "GET" },
      SessionTurnPresentationResponseSchema,
      [200],
      options,
    );
  }

  async createRun(
    sessionId: SessionId,
    input: CreateRunRequest,
    options: CaelushClientRequestOptions = {},
  ): Promise<ClientAgentRun> {
    const body = CreateRunRequestSchema.parse(input);
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/runs`,
      jsonRequest("POST", body),
      ClientAgentRunSchema,
      [201],
      options,
    );
  }

  async listRuns(
    sessionId: SessionId,
    query: Partial<RunListQuery> = {},
    options: CaelushClientRequestOptions = {},
  ): Promise<import("@caelush/protocol").RunListResponse> {
    const parsed = RunListQuerySchema.parse(query);
    const status =
      parsed.status === undefined ? "" : `&status=${encodeURIComponent(parsed.status)}`;
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/runs?limit=${encodeURIComponent(String(parsed.limit))}${status}`,
      { method: "GET" },
      RunListResponseSchema,
      [200],
      options,
    );
  }

  async getRun(runId: RunId, options: CaelushClientRequestOptions = {}): Promise<ClientAgentRun> {
    return this.request(
      `/api/v1/runs/${encodeURIComponent(runId)}`,
      { method: "GET" },
      ClientAgentRunSchema,
      [200],
      options,
    );
  }

  async getRunContextUsage(
    runId: RunId,
    options: CaelushClientRequestOptions = {},
  ): Promise<ContextUsageResponse> {
    return this.request(
      `/api/v1/runs/${encodeURIComponent(runId)}/context-usage`,
      { method: "GET" },
      ContextUsageResponseSchema,
      [200],
      options,
    );
  }

  async startRun(
    runId: RunId,
    options: CaelushClientRequestOptions = {},
  ): Promise<RunActionResponse> {
    return this.runAction(`/api/v1/runs/${encodeURIComponent(runId)}/start`, "POST", options);
  }

  async recoverRun(
    runId: RunId,
    options: CaelushClientRequestOptions = {},
  ): Promise<RunActionResponse> {
    return this.runAction(`/api/v1/runs/${encodeURIComponent(runId)}/recover`, "POST", options);
  }

  async cancelRun(
    runId: RunId,
    options: CaelushClientRequestOptions = {},
  ): Promise<RunActionResponse> {
    return this.runAction(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, "POST", options);
  }

  async continueResourceGuard(
    runId: RunId,
    options: CaelushClientRequestOptions = {},
  ): Promise<RunActionResponse> {
    return this.runAction(
      `/api/v1/runs/${encodeURIComponent(runId)}/continue-resource`,
      "POST",
      options,
    );
  }

  /**
   * Accept one mid-Run text correction.
   *
   * The identity is the caller's, not the daemon's: a retry after a lost response re-sends the same
   * `inputId` and receives the same acceptance instead of creating a second input.
   */
  async submitRunInput(
    runId: RunId,
    input: SubmitRunInputRequest,
    options: CaelushClientRequestOptions = {},
  ): Promise<RunInputReceipt> {
    const body = SubmitRunInputRequestSchema.parse(input);
    return this.request(
      `/api/v1/runs/${encodeURIComponent(runId)}/inputs`,
      jsonRequest("POST", body),
      RunInputReceiptSchema,
      [200, 202],
      options,
    );
  }

  async listRunInputs(
    runId: RunId,
    query: Partial<RunInputListQuery> = {},
    options: CaelushClientRequestOptions = {},
  ): Promise<RunInputListResponse> {
    const parsed = RunInputListQuerySchema.parse(query);
    const after =
      parsed.after === undefined ? "" : `&after=${encodeURIComponent(String(parsed.after))}`;
    return this.request(
      `/api/v1/runs/${encodeURIComponent(runId)}/inputs?limit=${encodeURIComponent(String(parsed.limit))}${after}`,
      { method: "GET" },
      RunInputListResponseSchema,
      [200],
      options,
    );
  }

  async listPendingApprovals(
    runId: RunId,
    options: CaelushClientRequestOptions = {},
  ): Promise<ApprovalListResponse> {
    return this.request(
      `/api/v1/runs/${encodeURIComponent(runId)}/approvals?status=PENDING`,
      { method: "GET" },
      ApprovalListResponseSchema,
      [200],
      options,
    );
  }

  async resolveApproval(
    runId: RunId,
    approvalId: import("@caelush/protocol").ApprovalRequestId,
    resolution: ApprovalResolutionRequest,
    options: CaelushClientRequestOptions = {},
  ): Promise<RunActionResponse> {
    const parsedApprovalId = ApprovalRequestIdSchema.parse(approvalId);
    const body = ApprovalResolutionRequestSchema.parse(resolution);
    return this.request(
      `/api/v1/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(parsedApprovalId)}/resolve`,
      jsonRequest("POST", body),
      RunActionResponseSchema,
      [200, 202],
      options,
    );
  }

  async *watchRunEvents(
    runId: RunId,
    options: WatchRunEventsOptions = {},
  ): AsyncIterable<PublicRunEvent> {
    const afterSequence = validateCursor(options.afterSequence);
    const suffix = afterSequence === undefined ? "" : `?afterSequence=${afterSequence}`;
    let response: Response;
    try {
      response = await this.fetcher(
        this.url(`/api/v1/runs/${encodeURIComponent(runId)}/events${suffix}`),
        {
          method: "GET",
          headers: this.requestHeaders("text/event-stream"),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    } catch (error) {
      if (options.signal?.aborted) return;
      throw error;
    }
    if (!response.ok) throw await this.httpError(response);
    if (response.body === null) {
      throw new CaelushClientProtocolError("Daemon returned an SSE response without a body.");
    }
    const reader = response.body.getReader();
    try {
      if (options.signal?.aborted) return;
      options.onOpen?.();
      yield* parseSseReader(reader, runId, options.signal);
    } catch (error) {
      if (options.signal?.aborted) return;
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async runAction(
    path: string,
    method: "POST",
    options: CaelushClientRequestOptions,
  ): Promise<RunActionResponse> {
    return this.request(path, { method }, RunActionResponseSchema, [200, 202], options);
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    schema: ClientSchema<T>,
    statuses: readonly number[],
    options: CaelushClientRequestOptions,
  ): Promise<T> {
    const body = await this.requestRaw(path, init, statuses, options);
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new CaelushClientProtocolError("Daemon returned an invalid response.");
    return parsed.data;
  }

  private async requestRaw(
    path: string,
    init: RequestInit,
    statuses: readonly number[],
    options: CaelushClientRequestOptions,
    expectJson = true,
  ): Promise<unknown> {
    let response: Response;
    try {
      const headers = this.requestHeaders();
      if (init.body !== undefined) headers.set("content-type", "application/json");
      response = await this.fetcher(this.url(path), {
        ...init,
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new CaelushClientProtocolError(
        error instanceof Error
          ? `Daemon request failed: ${error.message}`
          : "Daemon request failed.",
      );
    }
    if (!statuses.includes(response.status)) throw await this.httpError(response);
    if (!expectJson) return undefined;
    try {
      return await response.json();
    } catch {
      throw new CaelushClientProtocolError("Daemon returned invalid JSON.");
    }
  }

  private async httpError(response: Response): Promise<CaelushClientHttpError> {
    let body: unknown;
    try {
      const text = (await response.text()).slice(0, MAX_HTTP_ERROR_BYTES);
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const parsed = ApiErrorResponseSchema.safeParse(body);
    if (parsed.success) {
      return new CaelushClientHttpError({
        status: response.status,
        code: parsed.data.error.code,
        message: parsed.data.error.message,
        requestId: parsed.data.error.requestId,
        ...(parsed.data.error.details === undefined ? {} : { details: parsed.data.error.details }),
      });
    }
    return new CaelushClientHttpError({
      status: response.status,
      code: "INTERNAL_ERROR",
      message: "Daemon returned an invalid error response.",
    });
  }

  private url(path: string): string {
    return new URL(path.replace(/^\/+/, ""), this.baseUrl).toString();
  }

  private requestHeaders(accept?: string): Headers {
    const headers = new Headers(this.headers);
    headers.set("accept", accept ?? "application/json");
    return headers;
  }
}

interface ClientSchema<T> {
  safeParse(
    input: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

export async function* parseSseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expectedRunId: RunId,
  signal?: AbortSignal,
): AsyncIterable<PublicRunEvent> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let frame = newSseFrame();
  let frameBytes = 0;
  let aborted = signal?.aborted === true;
  const onAbort = () => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (aborted) return;
      const result = await reader.read();
      if (result.done) {
        buffer += decoder.decode();
        return;
      }
      buffer += decoder.decode(result.value, { stream: true });
      while (true) {
        const line = takeLine(buffer);
        if (line === undefined) break;
        buffer = line.rest;
        frameBytes += encoder.encode(line.text).byteLength + line.delimiterBytes;
        if (frameBytes > MAX_SSE_FRAME_BYTES) {
          throw new CaelushClientProtocolError("SSE frame exceeds the client limit.");
        }
        if (line.text.length === 0) {
          const event = decodeSseFrame(frame, expectedRunId);
          frame = newSseFrame();
          frameBytes = 0;
          if (event !== undefined) yield event;
        } else if (line.text.startsWith(":")) {
          continue;
        } else {
          const field = parseSseField(line.text);
          if (field.name === "event") frame.event = field.value;
          else if (field.name === "id") frame.id = field.value;
          else if (field.name === "data") frame.data.push(field.value);
        }
      }
      if (frameBytes + encoder.encode(buffer).byteLength > MAX_SSE_FRAME_BYTES) {
        throw new CaelushClientProtocolError("SSE frame exceeds the client limit.");
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

interface SseFrame {
  event?: string;
  id?: string;
  data: string[];
}

function newSseFrame(): SseFrame {
  return { data: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSseField(line: string): { readonly name: string; readonly value: string } {
  const separator = line.indexOf(":");
  if (separator < 0) return { name: line, value: "" };
  const value = line.slice(separator + 1);
  return { name: line.slice(0, separator), value: value.startsWith(" ") ? value.slice(1) : value };
}

function decodeSseFrame(frame: SseFrame, expectedRunId: RunId): PublicRunEvent | undefined {
  if (frame.data.length === 0) return undefined;
  const parsedJson = parseJson(frame.data.join("\n"));
  const parsedEvent = PublicRunEventSchema.safeParse(parsedJson);
  if (!parsedEvent.success) throw new CaelushClientProtocolError("SSE event payload is invalid.");
  const event = parsedEvent.data;
  if (event.runId !== expectedRunId)
    throw new CaelushClientProtocolError("SSE event Run identity mismatch.");
  if (frame.event !== undefined && frame.event !== event.type) {
    throw new CaelushClientProtocolError("SSE event type does not match its payload.");
  }
  if (event.durability.kind === "DURABLE") {
    if (frame.id === undefined || !/^\d+$/.test(frame.id)) {
      throw new CaelushClientProtocolError("Durable SSE event is missing a valid sequence id.");
    }
    const sequence = Number(frame.id);
    if (!Number.isSafeInteger(sequence) || sequence !== event.durability.sequence) {
      throw new CaelushClientProtocolError("Durable SSE id does not match its event sequence.");
    }
  } else if (frame.id !== undefined) {
    throw new CaelushClientProtocolError("Ephemeral SSE events must not carry a sequence id.");
  }
  return event;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new CaelushClientProtocolError("SSE event data is not valid JSON.");
  }
}

function takeLine(
  value: string,
): { readonly text: string; readonly rest: string; readonly delimiterBytes: number } | undefined {
  const newline = value.indexOf("\n");
  const carriage = value.indexOf("\r");
  const index = newline < 0 ? carriage : carriage < 0 ? newline : Math.min(newline, carriage);
  if (index < 0) return undefined;
  if (value[index] === "\r" && index + 1 === value.length) return undefined;
  const delimiterLength = value[index] === "\r" && value[index + 1] === "\n" ? 2 : 1;
  return {
    text: value.slice(0, index),
    rest: value.slice(index + delimiterLength),
    delimiterBytes: delimiterLength,
  };
}

function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CaelushClientProtocolError("Client base URL is invalid.");
  }
  const trustedDesktopOrigin =
    url.protocol === "caelush-app:" &&
    url.hostname === "app" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    (url.pathname === "" || url.pathname === "/") &&
    url.search === "" &&
    url.hash === "";
  if (url.protocol !== "http:" && url.protocol !== "https:" && !trustedDesktopOrigin) {
    throw new CaelushClientProtocolError(
      "Client base URL must use HTTP, HTTPS, or the trusted Desktop app origin.",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function validateCursor(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CaelushClientProtocolError("Event cursor is invalid.");
  }
  return value;
}

function jsonRequest(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}
