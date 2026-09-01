import {
  AgentEventSchema,
  ApprovalListResponseSchema,
  ApprovalResolutionRequestSchema,
  ApiErrorResponseSchema,
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  CreateRunRequestSchema,
  CreateSessionRequestSchema,
  DaemonInfoSchema,
  HealthResponseSchema,
  RunActionResponseSchema,
  RunListQuerySchema,
  RunListResponseSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  type AgentEvent,
  type ApiErrorCode,
  type ApprovalListResponse,
  type ApprovalResolutionRequest,
  type ClientAgentRun,
  type ClientAgentSession,
  type CreateRunRequest,
  type CreateSessionRequest,
  type DaemonInfo,
  type HealthResponse,
  type RunActionResponse,
  type RunId,
  type RunListQuery,
  type SessionId,
  type SessionListQuery,
  type SessionListResponse,
} from "@caelush/protocol";
import { ApprovalRequestIdSchema } from "@caelush/protocol";

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
}

export interface CaelushClientRequestOptions {
  readonly signal?: AbortSignal;
}

export class CaelushClientHttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly requestId?: string;

  constructor(input: {
    readonly status: number;
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly requestId?: string;
  }) {
    super(input.message);
    this.name = "CaelushClientHttpError";
    this.status = input.status;
    this.statusCode = input.status;
    this.code = input.code;
    if (input.requestId !== undefined) this.requestId = input.requestId;
  }
}

export class CaelushClientProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaelushClientProtocolError";
  }
}

export class CaelushProtocolCompatibilityError extends CaelushClientProtocolError {
  constructor() {
    super("Daemon protocol version is unsupported.");
    this.name = "CaelushProtocolCompatibilityError";
  }
}

export class CaelushClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly headers: Headers;

  constructor(options: CaelushClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetcher = options.fetch ?? fetch;
    this.headers = new Headers(options.headers);
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
  ): AsyncIterable<AgentEvent> {
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
): AsyncIterable<AgentEvent> {
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

function decodeSseFrame(frame: SseFrame, expectedRunId: RunId): AgentEvent | undefined {
  if (frame.data.length === 0) return undefined;
  const parsedJson = parseJson(frame.data.join("\n"));
  const parsedEvent = AgentEventSchema.safeParse(parsedJson);
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
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CaelushClientProtocolError("Client base URL must use HTTP or HTTPS.");
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

function jsonRequest(method: "POST", body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}
