import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProviderCredentialRepository, ProviderCredentialStatus } from "@caelush/storage";
import {
  createRuntimeProviderCredentialAuthority,
  type RuntimeProviderCredentialAuthority,
} from "./credential-authority.js";

const PROFILE_ID_PATTERN = /^u_[0-9a-f]{64}$/u;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_CREDENTIAL_LENGTH = 16_384;
const MAX_RPC_BYTES = 64 * 1024;
const MAX_PENDING_REQUESTS = 32;
const DEFAULT_TIMEOUT_MS = 10_000;

const CredentialRpcRequestBaseSchema = z.object({
  requestId: z.uuid(),
  generationId: z.uuid(),
  profileId: z.string().regex(PROFILE_ID_PATTERN),
  childPid: z.number().int().positive().safe(),
  providerId: z.string().regex(PROVIDER_ID_PATTERN),
});

const CredentialRpcRequestSchema = z.discriminatedUnion("type", [
  CredentialRpcRequestBaseSchema.extend({ type: z.literal("CREDENTIAL_DESCRIBE") }).strict(),
  CredentialRpcRequestBaseSchema.extend({ type: z.literal("CREDENTIAL_RESOLVE") }).strict(),
  CredentialRpcRequestBaseSchema.extend({
    type: z.literal("CREDENTIAL_SET"),
    secretValue: z.string().min(1).max(MAX_CREDENTIAL_LENGTH),
  }).strict(),
  CredentialRpcRequestBaseSchema.extend({ type: z.literal("CREDENTIAL_UNSET") }).strict(),
]);

const CredentialStatusSchema = z
  .object({
    providerId: z.string().regex(PROVIDER_ID_PATTERN),
    configured: z.boolean(),
    source: z.enum(["NONE", "LOCAL"]),
    writable: z.boolean(),
    updatedAt: z.number().int().nonnegative().safe().optional(),
  })
  .strict();

const CredentialRpcResponseSchema = z
  .object({
    type: z.literal("CREDENTIAL_RESPONSE"),
    requestId: z.uuid(),
    generationId: z.uuid(),
    profileId: z.string().regex(PROFILE_ID_PATTERN),
    result: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("STATUS"), status: CredentialStatusSchema }).strict(),
      z
        .object({
          kind: z.literal("RESOLVE"),
          secretValue: z.string().max(MAX_CREDENTIAL_LENGTH).nullable(),
        })
        .strict(),
      z.object({ kind: z.literal("UNSET") }).strict(),
      z
        .object({
          kind: z.literal("ERROR"),
          code: z.enum([
            "CREDENTIAL_DENIED",
            "CREDENTIAL_UNAVAILABLE",
            "CREDENTIAL_TIMEOUT",
            "TOO_MANY_REQUESTS",
            "REQUEST_TOO_LARGE",
          ]),
        })
        .strict(),
    ]),
  })
  .strict();

type CredentialRpcRequest = z.infer<typeof CredentialRpcRequestSchema>;
type CredentialRpcResponse = z.infer<typeof CredentialRpcResponseSchema>;
type CredentialRpcResult = CredentialRpcResponse["result"];
type CredentialRpcErrorCode = Extract<CredentialRpcResult, { kind: "ERROR" }>["code"];

/** The local IPC transport is the existing fork channel owned by the Desktop Supervisor. */
export interface DesktopCredentialIpcTransport {
  readonly pid: number;
  readonly connected: boolean;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  on(event: "message", listener: (message: unknown) => void): this;
  once(event: "exit" | "disconnect", listener: (...args: unknown[]) => void): this;
  removeListener(event: "message", listener: (message: unknown) => void): this;
  removeListener(event: "exit" | "disconnect", listener: (...args: unknown[]) => void): this;
}

export class DesktopCredentialRpcError extends Error {
  constructor(
    readonly code:
      | CredentialRpcErrorCode
      | "CREDENTIAL_RPC_TIMEOUT"
      | "CREDENTIAL_RPC_INVALID"
      | "CREDENTIAL_RPC_CLOSED"
      | "CREDENTIAL_RPC_ABORTED",
  ) {
    super(messageFor(code));
    this.name = "DesktopCredentialRpcError";
  }
}

/**
 * Creates the one runtime credential authority for a Desktop generation. Secrets cross this
 * private channel only between the verified Daemon child and Electron Main.
 */
export function createDesktopCredentialAuthority(options: {
  readonly generationId: string;
  readonly profileId: string;
  readonly transport?: DesktopCredentialIpcTransport;
  readonly timeoutMs?: number;
}): { readonly authority: RuntimeProviderCredentialAuthority; dispose(): void } {
  const transport = options.transport ?? processCredentialIpcTransport();
  const client = new DesktopCredentialRpcClient({
    generationId: options.generationId,
    profileId: options.profileId,
    transport,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const repository: Pick<ProviderCredentialRepository, "describe" | "set" | "unset"> & {
    resolve(providerId: string, signal?: AbortSignal): Promise<string | undefined>;
  } = {
    describe: async (providerId) => {
      const result = await client.request("CREDENTIAL_DESCRIBE", providerId);
      return requireStatus(result, providerId);
    },
    resolve: async (providerId: string, signal?: AbortSignal) => {
      const result = await client.request("CREDENTIAL_RESOLVE", providerId, undefined, signal);
      if (result.kind !== "RESOLVE") throw new DesktopCredentialRpcError("CREDENTIAL_RPC_INVALID");
      return result.secretValue ?? undefined;
    },
    set: async (providerId, secretValue) => {
      const result = await client.request("CREDENTIAL_SET", providerId, secretValue);
      return requireStatus(result, providerId);
    },
    unset: async (providerId) => {
      const result = await client.request("CREDENTIAL_UNSET", providerId);
      if (result.kind !== "UNSET") throw new DesktopCredentialRpcError("CREDENTIAL_RPC_INVALID");
    },
  };
  return {
    authority: createRuntimeProviderCredentialAuthority({ repository, environment: {} }),
    dispose: () => client.dispose(),
  };
}

class DesktopCredentialRpcClient {
  private readonly pending = new Map<
    string,
    {
      readonly requestType: CredentialRpcRequest["type"];
      readonly resolve: (result: CredentialRpcResult) => void;
      readonly reject: (error: DesktopCredentialRpcError) => void;
      readonly timer: NodeJS.Timeout;
      readonly signal?: AbortSignal;
      readonly onAbort?: () => void;
    }
  >();
  private closed = false;
  private readonly onMessage = (message: unknown) => this.receive(message);
  private readonly onExit = () => this.close("CREDENTIAL_RPC_CLOSED");
  private readonly onDisconnect = () => this.close("CREDENTIAL_RPC_CLOSED");

  constructor(
    private readonly options: {
      readonly generationId: string;
      readonly profileId: string;
      readonly transport: DesktopCredentialIpcTransport;
      readonly timeoutMs: number;
    },
  ) {
    if (
      !z.uuid().safeParse(options.generationId).success ||
      !PROFILE_ID_PATTERN.test(options.profileId)
    ) {
      throw new RangeError("Credential RPC identity is invalid.");
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new RangeError("Credential RPC timeout must be a positive safe integer.");
    }
    options.transport.on("message", this.onMessage);
    options.transport.once("exit", this.onExit);
    options.transport.once("disconnect", this.onDisconnect);
  }

  request(
    type: CredentialRpcRequest["type"],
    providerId: string,
    secretValue?: string,
    signal?: AbortSignal,
  ): Promise<CredentialRpcResult> {
    if (this.closed || !this.options.transport.connected) {
      return Promise.reject(new DesktopCredentialRpcError("CREDENTIAL_RPC_CLOSED"));
    }
    if (signal?.aborted) {
      return Promise.reject(new DesktopCredentialRpcError("CREDENTIAL_RPC_ABORTED"));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new DesktopCredentialRpcError("TOO_MANY_REQUESTS"));
    }
    const base = {
      type,
      requestId: randomUUID(),
      generationId: this.options.generationId,
      profileId: this.options.profileId,
      childPid: this.options.transport.pid,
      providerId,
    };
    const candidate =
      type === "CREDENTIAL_SET" ? { ...base, secretValue: secretValue ?? "" } : base;
    const parsed = CredentialRpcRequestSchema.safeParse(candidate);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_RPC_BYTES) {
      return Promise.reject(new DesktopCredentialRpcError("CREDENTIAL_RPC_INVALID"));
    }
    return new Promise<CredentialRpcResult>((resolve, reject) => {
      const requestId = parsed.data.requestId;
      const finish = (action: () => void) => {
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener("abort", pending.onAbort as () => void);
        this.pending.delete(requestId);
        action();
      };
      const onAbort =
        signal === undefined
          ? undefined
          : () => {
              finish(() => reject(new DesktopCredentialRpcError("CREDENTIAL_RPC_ABORTED")));
            };
      const timer = setTimeout(() => {
        finish(() => reject(new DesktopCredentialRpcError("CREDENTIAL_RPC_TIMEOUT")));
      }, this.options.timeoutMs);
      timer.unref();
      this.pending.set(requestId, {
        requestType: type,
        resolve: (result) => finish(() => resolve(result)),
        reject: (error) => finish(() => reject(error)),
        timer,
        ...(signal === undefined ? {} : { signal }),
        ...(onAbort === undefined ? {} : { onAbort }),
      });
      if (onAbort !== undefined) signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.options.transport.send(parsed.data, (error) => {
          if (error !== null) {
            this.pending
              .get(requestId)
              ?.reject(new DesktopCredentialRpcError("CREDENTIAL_RPC_CLOSED"));
          }
        });
      } catch {
        this.pending.get(requestId)?.reject(new DesktopCredentialRpcError("CREDENTIAL_RPC_CLOSED"));
      }
    });
  }

  dispose(): void {
    this.close("CREDENTIAL_RPC_CLOSED");
  }

  private receive(raw: unknown): void {
    const requestId =
      isRecord(raw) && typeof raw.requestId === "string" ? raw.requestId : undefined;
    const parsed = CredentialRpcResponseSchema.safeParse(raw);
    if (!parsed.success) {
      if (requestId !== undefined) {
        this.pending
          .get(requestId)
          ?.reject(new DesktopCredentialRpcError("CREDENTIAL_RPC_INVALID"));
      }
      return;
    }
    const response = parsed.data;
    const pending = this.pending.get(response.requestId);
    if (pending === undefined) return;
    if (
      response.generationId !== this.options.generationId ||
      response.profileId !== this.options.profileId ||
      !matchesResponseKind(pending.requestType, response.result)
    ) {
      pending.reject(new DesktopCredentialRpcError("CREDENTIAL_RPC_INVALID"));
      return;
    }
    if (response.result.kind === "ERROR") {
      pending.reject(new DesktopCredentialRpcError(response.result.code));
      return;
    }
    pending.resolve(response.result);
  }

  private close(code: "CREDENTIAL_RPC_CLOSED"): void {
    if (this.closed) return;
    this.closed = true;
    this.options.transport.removeListener("message", this.onMessage);
    this.options.transport.removeListener("exit", this.onExit);
    this.options.transport.removeListener("disconnect", this.onDisconnect);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort as () => void);
      pending.reject(new DesktopCredentialRpcError(code));
    }
    this.pending.clear();
  }
}

function requireStatus(result: CredentialRpcResult, providerId: string): ProviderCredentialStatus {
  if (result.kind !== "STATUS" || result.status.providerId !== providerId) {
    throw new DesktopCredentialRpcError("CREDENTIAL_RPC_INVALID");
  }
  return {
    providerId: result.status.providerId,
    configured: result.status.configured,
    source: result.status.source,
    writable: result.status.writable,
    ...(result.status.updatedAt === undefined ? {} : { updatedAt: result.status.updatedAt }),
  };
}

function matchesResponseKind(
  requestType: CredentialRpcRequest["type"],
  result: CredentialRpcResult,
): boolean {
  if (result.kind === "ERROR") return true;
  switch (requestType) {
    case "CREDENTIAL_DESCRIBE":
    case "CREDENTIAL_SET":
      return result.kind === "STATUS";
    case "CREDENTIAL_RESOLVE":
      return result.kind === "RESOLVE";
    case "CREDENTIAL_UNSET":
      return result.kind === "UNSET";
  }
}

function messageFor(
  code:
    | CredentialRpcErrorCode
    | "CREDENTIAL_RPC_TIMEOUT"
    | "CREDENTIAL_RPC_INVALID"
    | "CREDENTIAL_RPC_CLOSED"
    | "CREDENTIAL_RPC_ABORTED",
): string {
  switch (code) {
    case "CREDENTIAL_RPC_ABORTED":
      return "Provider credential access was cancelled.";
    case "CREDENTIAL_RPC_TIMEOUT":
      return "Provider credential access timed out.";
    case "CREDENTIAL_RPC_CLOSED":
      return "Provider credential access is unavailable.";
    case "CREDENTIAL_RPC_INVALID":
      return "Provider credential access failed safely.";
    case "TOO_MANY_REQUESTS":
      return "Provider credential access is busy.";
    default:
      return "Provider credential access is unavailable.";
  }
}

function processCredentialIpcTransport(): DesktopCredentialIpcTransport {
  return {
    pid: process.pid,
    get connected() {
      return process.connected === true;
    },
    send(message, callback) {
      if (typeof process.send !== "function" || !process.connected) {
        callback?.(new Error("credential IPC is closed"));
        return false;
      }
      return process.send(message as never, (error) => callback?.(error));
    },
    on(event, listener) {
      process.on(event as never, listener as never);
      return this;
    },
    once(event, listener) {
      process.once(event as never, listener as never);
      return this;
    },
    removeListener(event, listener) {
      process.removeListener(event as never, listener as never);
      return this;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
