import { z } from "zod";
import type { ProviderCredentialVaultStatus } from "./provider-credential-vault.js";

const PROFILE_ID_PATTERN = /^u_[0-9a-f]{64}$/u;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_CREDENTIAL_LENGTH = 16_384;
const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;

const CredentialRequestBaseSchema = z.object({
  requestId: z.uuid(),
  generationId: z.uuid(),
  profileId: z.string().regex(PROFILE_ID_PATTERN),
  childPid: z.number().int().positive().safe(),
  providerId: z.string().regex(PROVIDER_ID_PATTERN),
});

const CredentialRpcRequestSchema = z.discriminatedUnion("type", [
  CredentialRequestBaseSchema.extend({ type: z.literal("CREDENTIAL_DESCRIBE") }).strict(),
  CredentialRequestBaseSchema.extend({ type: z.literal("CREDENTIAL_RESOLVE") }).strict(),
  CredentialRequestBaseSchema.extend({
    type: z.literal("CREDENTIAL_SET"),
    secretValue: z.string().min(1).max(MAX_CREDENTIAL_LENGTH),
  }).strict(),
  CredentialRequestBaseSchema.extend({ type: z.literal("CREDENTIAL_UNSET") }).strict(),
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

export interface MainCredentialVaultPort {
  describe(
    cloudUserId: string,
    profileId: string,
    providerId: string,
  ): Promise<ProviderCredentialVaultStatus>;
  resolve(cloudUserId: string, profileId: string, providerId: string): Promise<string | undefined>;
  set(
    cloudUserId: string,
    profileId: string,
    providerId: string,
    secretValue: string,
  ): Promise<ProviderCredentialVaultStatus>;
  unset(cloudUserId: string, profileId: string, providerId: string): Promise<void>;
}

export interface MainCredentialRpcServerOptions {
  readonly identity: {
    readonly generationId: string;
    readonly profileId: string;
    readonly childPid: number;
    readonly cloudUserId: string;
  };
  /** Bound to this Main-created Child object and its currently selected account generation. */
  readonly isCurrentGeneration: () => boolean;
  readonly credentials: MainCredentialVaultPort;
  readonly send: (response: CredentialRpcResponse) => Promise<void> | void;
  readonly maxConcurrentRequests?: number;
  readonly operationTimeoutMs?: number;
}

/** Main-side request gate. It trusts the Child handle, then independently checks PID, generation and Profile. */
export class MainCredentialRpcServer {
  private readonly maxConcurrentRequests: number;
  private readonly operationTimeoutMs: number;
  private readonly activeRequests = new Set<string>();
  private closed = false;

  constructor(private readonly options: MainCredentialRpcServerOptions) {
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.maxConcurrentRequests) || this.maxConcurrentRequests < 1) {
      throw new RangeError("maxConcurrentRequests must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.operationTimeoutMs) || this.operationTimeoutMs < 1) {
      throw new RangeError("operationTimeoutMs must be a positive safe integer.");
    }
  }

  async handle(raw: unknown): Promise<void> {
    if (this.closed || !this.options.isCurrentGeneration()) return;
    let encodedRequest: string;
    try {
      encodedRequest = JSON.stringify(raw);
    } catch {
      return;
    }
    if (Buffer.byteLength(encodedRequest, "utf8") > MAX_REQUEST_BYTES) return;
    const parsed = CredentialRpcRequestSchema.safeParse(raw);
    if (!parsed.success) return;
    const request = parsed.data;
    if (!this.matchesIdentity(request)) return;
    if (this.activeRequests.has(request.requestId)) return;
    if (this.activeRequests.size >= this.maxConcurrentRequests) {
      await this.respond(request, { kind: "ERROR", code: "TOO_MANY_REQUESTS" });
      return;
    }

    this.activeRequests.add(request.requestId);
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new CredentialOperationTimeout()), this.operationTimeoutMs);
      timeout.unref();
    });
    try {
      const result = await Promise.race([this.execute(request), timedOut]);
      if (this.canRespond()) await this.respond(request, result);
    } catch (error) {
      if (!this.canRespond()) return;
      await this.respond(request, {
        kind: "ERROR",
        code:
          error instanceof CredentialOperationTimeout
            ? "CREDENTIAL_TIMEOUT"
            : "CREDENTIAL_UNAVAILABLE",
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.activeRequests.delete(request.requestId);
    }
  }

  dispose(): void {
    this.closed = true;
    this.activeRequests.clear();
  }

  private async execute(request: CredentialRpcRequest): Promise<CredentialRpcResponse["result"]> {
    const { cloudUserId, profileId } = this.options.identity;
    switch (request.type) {
      case "CREDENTIAL_DESCRIBE":
        return {
          kind: "STATUS",
          status: await this.options.credentials.describe(
            cloudUserId,
            profileId,
            request.providerId,
          ),
        };
      case "CREDENTIAL_RESOLVE":
        return {
          kind: "RESOLVE",
          secretValue:
            (await this.options.credentials.resolve(cloudUserId, profileId, request.providerId)) ??
            null,
        };
      case "CREDENTIAL_SET":
        return {
          kind: "STATUS",
          status: await this.options.credentials.set(
            cloudUserId,
            profileId,
            request.providerId,
            request.secretValue,
          ),
        };
      case "CREDENTIAL_UNSET":
        await this.options.credentials.unset(cloudUserId, profileId, request.providerId);
        return { kind: "UNSET" };
    }
  }

  private matchesIdentity(request: CredentialRpcRequest): boolean {
    return (
      this.canRespond() &&
      request.generationId === this.options.identity.generationId &&
      request.profileId === this.options.identity.profileId &&
      request.childPid === this.options.identity.childPid
    );
  }

  private canRespond(): boolean {
    return !this.closed && this.options.isCurrentGeneration();
  }

  private async respond(
    request: CredentialRpcRequest,
    result: CredentialRpcResponse["result"],
  ): Promise<void> {
    if (!this.canRespond()) return;
    const response = CredentialRpcResponseSchema.safeParse({
      type: "CREDENTIAL_RESPONSE",
      requestId: request.requestId,
      generationId: this.options.identity.generationId,
      profileId: this.options.identity.profileId,
      result,
    });
    if (!response.success) return;
    try {
      await this.options.send(response.data);
    } catch {
      // The Child may exit while a bounded Vault operation is in progress.
    }
  }
}

class CredentialOperationTimeout extends Error {}
