import { z } from "zod";
import {
  AcceptedResponseSchema,
  AccountResponseSchema,
  ApiErrorResponseSchema,
  AuthResultSchema,
  ChangePasswordRequestSchema,
  DeviceListResponseSchema,
  DeviceRevocationResponseSchema,
  EmailAddressRequestSchema,
  LoginRequestSchema,
  OperationSucceededResponseSchema,
  RegisterRequestSchema,
  ResetPasswordRequestSchema,
  VerifyEmailRequestSchema,
  type AcceptedResponse,
  type AccountView,
  type AuthResult,
  type ChangePasswordRequest,
  type DeviceListResponse,
  type DeviceRevocationResponse,
  type EmailAddressRequest,
  type LoginRequest,
  type OperationSucceededResponse,
  type RegisterRequest,
  type ResetPasswordRequest,
  type VerifyEmailRequest,
  type CloudErrorCode,
} from "./schemas.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;

export type CloudFailureCode =
  | CloudErrorCode
  | "NETWORK_UNAVAILABLE"
  | "NETWORK_TIMEOUT"
  | "CANCELLED"
  | "CLOUD_RESPONSE_INVALID";

export class CloudClientError extends Error {
  constructor(
    readonly code: CloudFailureCode,
    message: string,
    readonly retryable = false,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "CloudClientError";
  }
}

export interface CloudClientOptions {
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

export class CloudAccountClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: CloudClientOptions = {}) {
    this.baseUrl = validateCloudOrigin(baseUrl);
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 500 || this.timeoutMs > 60_000) {
      throw new CloudClientError(
        "REQUEST_INVALID",
        "Cloud request timeout configuration is invalid.",
      );
    }
  }

  register(input: RegisterRequest, signal: AbortSignal): Promise<AcceptedResponse> {
    const body = validate(RegisterRequestSchema, input);
    return this.request("POST", "/auth/register", AcceptedResponseSchema, {
      body,
      signal,
      expectedStatus: 202,
    });
  }

  verifyEmail(input: VerifyEmailRequest, signal: AbortSignal): Promise<OperationSucceededResponse> {
    const body = validate(VerifyEmailRequestSchema, input);
    return this.request("POST", "/auth/verify-email", OperationSucceededResponseSchema, {
      body,
      signal,
      expectedStatus: 200,
    });
  }

  resendVerification(input: EmailAddressRequest, signal: AbortSignal): Promise<AcceptedResponse> {
    const body = validate(EmailAddressRequestSchema, input);
    return this.request("POST", "/auth/resend-verification", AcceptedResponseSchema, {
      body,
      signal,
      expectedStatus: 202,
    });
  }

  login(input: LoginRequest, signal: AbortSignal): Promise<AuthResult> {
    const body = validate(LoginRequestSchema, input);
    return this.request("POST", "/auth/login", AuthResultSchema, {
      body,
      signal,
      expectedStatus: 200,
    });
  }

  refresh(refreshToken: string, signal: AbortSignal): Promise<AuthResult> {
    if (refreshToken.length < 32 || refreshToken.length > 8192) {
      throw new CloudClientError("REQUEST_INVALID", "The saved session credential is invalid.");
    }
    return this.request("POST", "/auth/refresh", AuthResultSchema, {
      body: { refreshToken },
      signal,
      expectedStatus: 200,
    });
  }

  logout(accessToken: string, signal: AbortSignal): Promise<OperationSucceededResponse> {
    return this.request("POST", "/auth/logout", OperationSucceededResponseSchema, {
      bearer: accessToken,
      signal,
      expectedStatus: 200,
    });
  }

  forgotPassword(input: EmailAddressRequest, signal: AbortSignal): Promise<AcceptedResponse> {
    const body = validate(EmailAddressRequestSchema, input);
    return this.request("POST", "/auth/forgot-password", AcceptedResponseSchema, {
      body,
      signal,
      expectedStatus: 202,
    });
  }

  resetPassword(
    input: ResetPasswordRequest,
    signal: AbortSignal,
  ): Promise<OperationSucceededResponse> {
    const body = validate(ResetPasswordRequestSchema, input);
    return this.request("POST", "/auth/reset-password", OperationSucceededResponseSchema, {
      body,
      signal,
      expectedStatus: 200,
    });
  }

  changePassword(
    input: ChangePasswordRequest,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<OperationSucceededResponse> {
    const body = validate(ChangePasswordRequestSchema, input);
    return this.request("POST", "/auth/change-password", OperationSucceededResponseSchema, {
      body,
      bearer: accessToken,
      signal,
      expectedStatus: 200,
    });
  }

  async getCurrentAccount(accessToken: string, signal: AbortSignal): Promise<AccountView> {
    const value = await this.request("GET", "/account/me", AccountResponseSchema, {
      bearer: accessToken,
      signal,
      expectedStatus: 200,
    });
    return value.account;
  }

  listDevices(accessToken: string, signal: AbortSignal): Promise<DeviceListResponse> {
    return this.request("GET", "/account/devices?limit=100", DeviceListResponseSchema, {
      bearer: accessToken,
      signal,
      expectedStatus: 200,
    });
  }

  revokeDevice(
    deviceId: string,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<DeviceRevocationResponse> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
      throw new CloudClientError("REQUEST_INVALID", "The selected device identifier is invalid.");
    }
    return this.request(
      "DELETE",
      `/account/devices/${encodeURIComponent(deviceId)}`,
      DeviceRevocationResponseSchema,
      {
        bearer: accessToken,
        signal,
        expectedStatus: 200,
      },
    );
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    schema: z.ZodType<T>,
    options: {
      readonly body?: unknown;
      readonly bearer?: string;
      readonly signal: AbortSignal;
      readonly expectedStatus: number;
    },
  ): Promise<T> {
    const url = new URL(`/v1${path}`, this.baseUrl);
    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.bearer !== undefined) {
      if (options.bearer.length < 32 || options.bearer.length > 8192) {
        throw new CloudClientError(
          "AUTH_TOKEN_INVALID",
          "The online session is no longer available.",
        );
      }
      headers.set("Authorization", `Bearer ${options.bearer}`);
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abortFromCaller = () => controller.abort();
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", abortFromCaller, { once: true });

    let response: Response;
    let bodyText: string;
    try {
      response = await this.fetcher(url, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      bodyText = await readBoundedText(response);
    } catch (error) {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abortFromCaller);
      if (error instanceof CloudClientError) throw error;
      if (options.signal.aborted)
        throw new CloudClientError("CANCELLED", "The request was cancelled.");
      if (timedOut || isAbortError(error))
        throw new CloudClientError(
          "NETWORK_TIMEOUT",
          "Cloud did not respond before the request timed out.",
          true,
        );
      throw new CloudClientError("NETWORK_UNAVAILABLE", "Cloud is currently unreachable.", true);
    }
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abortFromCaller);

    let value: unknown;
    try {
      value = parseCloudJson(bodyText);
    } catch {
      throw new CloudClientError(
        "CLOUD_RESPONSE_INVALID",
        "Cloud returned an invalid response.",
        false,
        response.status,
      );
    }
    if (!response.ok) {
      const parsedError = ApiErrorResponseSchema.safeParse(value);
      if (!parsedError.success) {
        throw new CloudClientError(
          "CLOUD_RESPONSE_INVALID",
          "Cloud returned an invalid error response.",
          false,
          response.status,
        );
      }
      const { code, message, retryable } = parsedError.data.error;
      throw new CloudClientError(code, message, retryable, response.status);
    }
    if (response.status !== options.expectedStatus) {
      throw new CloudClientError(
        "CLOUD_RESPONSE_INVALID",
        "Cloud returned an unexpected response status.",
        false,
        response.status,
      );
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new CloudClientError(
        "CLOUD_RESPONSE_INVALID",
        "Cloud returned data that does not match the account contract.",
        false,
        response.status,
      );
    }
    return parsed.data;
  }
}

function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch {
    throw new CloudClientError(
      "REQUEST_INVALID",
      "The account request does not match the Cloud contract.",
    );
  }
}

function validateCloudOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CloudClientError("REQUEST_INVALID", "The configured Cloud address is invalid.");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && parsed.hostname === "127.0.0.1"))
  ) {
    throw new CloudClientError(
      "REQUEST_INVALID",
      "Cloud must use a trusted HTTPS origin or the explicit local development service.",
    );
  }
  return parsed;
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudClientError(
      "CLOUD_RESPONSE_INVALID",
      "Cloud returned a response that exceeds its size limit.",
      false,
      response.status,
    );
  }
  if (response.body === null) {
    throw new CloudClientError(
      "CLOUD_RESPONSE_INVALID",
      "Cloud returned an empty response.",
      false,
      response.status,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CloudClientError(
          "CLOUD_RESPONSE_INVALID",
          "Cloud returned a response that exceeds its size limit.",
          false,
          response.status,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CloudClientError) throw error;
    throw new CloudClientError(
      "CLOUD_RESPONSE_INVALID",
      "Cloud response could not be read safely.",
      false,
      response.status,
    );
  }
  try {
    const bytes = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      size,
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CloudClientError(
      "CLOUD_RESPONSE_INVALID",
      "Cloud response was not valid UTF-8.",
      false,
      response.status,
    );
  }
}

function parseCloudJson(text: string): unknown {
  // Cloud DTOs use only safe integers; the strict parser also preserves duplicate-key evidence.
  return parseStrictJson(text);
}

function parseStrictJson(source: string): unknown {
  const length = source.length;
  let position = 0;
  const whitespace = () => {
    while (position < length && /[\u0009\u000a\u000d\u0020]/.test(source[position] ?? ""))
      position += 1;
  };
  const string = (): string => {
    if (source[position] !== '"') throw new Error("invalid");
    const start = position++;
    while (position < length) {
      const character = source[position];
      if (character === '"') {
        position += 1;
        const result: unknown = JSON.parse(source.slice(start, position));
        if (
          typeof result !== "string" ||
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result)
        )
          throw new Error("invalid");
        return result;
      }
      if (character === "\\") position += 1;
      else if ((character?.charCodeAt(0) ?? 0) <= 0x1f) throw new Error("invalid");
      position += 1;
    }
    throw new Error("invalid");
  };
  const parse = (depth: number): unknown => {
    if (depth > 64) throw new Error("invalid");
    whitespace();
    if (source[position] === '"') return string();
    if (source[position] === "{") {
      position += 1;
      whitespace();
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      if (source[position] === "}") {
        position += 1;
        return object;
      }
      while (position < length) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("duplicate");
        keys.add(key);
        whitespace();
        if (source[position++] !== ":") throw new Error("invalid");
        object[key] = parse(depth + 1);
        whitespace();
        if (source[position] === "}") {
          position += 1;
          return object;
        }
        if (source[position++] !== ",") throw new Error("invalid");
      }
      throw new Error("invalid");
    }
    if (source[position] === "[") {
      position += 1;
      whitespace();
      const array: unknown[] = [];
      if (source[position] === "]") {
        position += 1;
        return array;
      }
      while (position < length) {
        array.push(parse(depth + 1));
        whitespace();
        if (source[position] === "]") {
          position += 1;
          return array;
        }
        if (source[position++] !== ",") throw new Error("invalid");
      }
      throw new Error("invalid");
    }
    for (const [token, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(token, position)) {
        position += token.length;
        return value;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(position));
    if (number !== null) {
      position += number[0].length;
      if (/[.eE]/.test(number[0])) throw new Error("invalid");
      const value: unknown = JSON.parse(number[0]);
      if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0))
        throw new Error("invalid");
      return value;
    }
    throw new Error("invalid");
  };
  const result = parse(0);
  whitespace();
  if (position !== length) throw new Error("invalid");
  return result;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
