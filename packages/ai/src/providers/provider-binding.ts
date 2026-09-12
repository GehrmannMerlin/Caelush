import { assertExactKeys, assertNonEmptyString, describeValue } from "../internal/assertions.js";
import { isJsonObject } from "../json/json-value.js";
import { isValidApiId } from "../ids/api-id.js";
import { isValidProviderId } from "../ids/provider-id.js";
import type { ApiId } from "../ids/api-id.js";
import type { JsonObject } from "../json/json-value.js";
import type { ProviderId } from "../ids/provider-id.js";
import type { ProviderCredentialResolver } from "./credentials.js";

/**
 * A transport seam for tests and for a caller that must supply its own fetch.
 *
 * This is a host composition concern, not a model invocation concern: the AI
 * core never reads it, and it never reaches a provider descriptor.
 */
export interface AIProviderTransportOverride {
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * One configured provider connection.
 *
 * The binding answers "where and with which dialect" for a provider id. The
 * endpoint and credentials live here, never in a {@link ModelDescriptor}: a model
 * is a model, and the connection is how you reach it.
 */
export interface AIProviderBinding {
  readonly id: ProviderId;
  readonly endpoint: string;
  readonly defaultApi: ApiId;
  readonly allowedModels?: readonly string[];
  readonly allowUnknownModels: boolean;
  readonly credentials: ProviderCredentialResolver;
  readonly headers?: Readonly<Record<string, string>>;
  readonly queryParams?: Readonly<Record<string, string>>;
  readonly compatibility?: JsonObject;
  readonly transport?: AIProviderTransportOverride;
}

/** The exact binding key set. An unknown field is a defect, not an extension. */
export const PROVIDER_BINDING_KEYS = [
  "id",
  "endpoint",
  "defaultApi",
  "allowedModels",
  "allowUnknownModels",
  "credentials",
  "headers",
  "queryParams",
  "compatibility",
  "transport",
] as const satisfies readonly (keyof AIProviderBinding)[];

/** Validate an endpoint: an absolute `http:` or `https:` URL. */
export function assertProviderEndpoint(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL, received ${JSON.stringify(value)}.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(
      `${label} must use the http: or https: scheme, received ${JSON.stringify(url.protocol)}.`,
    );
  }
}

/** Assert a well-formed provider binding. */
export function assertAIProviderBinding(value: unknown): asserts value is AIProviderBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`AI provider binding must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, PROVIDER_BINDING_KEYS, "AI provider binding");

  if (typeof candidate.id !== "string" || !isValidProviderId(candidate.id)) {
    throw new TypeError(
      `AI provider binding id must be a valid provider id, received ${describeValue(candidate.id)}.`,
    );
  }
  const label = `AI provider binding "${candidate.id as string}" endpoint`;
  assertProviderEndpoint(candidate.endpoint, label);

  if (typeof candidate.defaultApi !== "string" || !isValidApiId(candidate.defaultApi)) {
    throw new TypeError(
      `AI provider binding "${candidate.id as string}" defaultApi must be a valid api id, received ${describeValue(candidate.defaultApi)}.`,
    );
  }
  if (typeof candidate.allowUnknownModels !== "boolean") {
    throw new TypeError(
      `AI provider binding "${candidate.id as string}" allowUnknownModels must be a boolean, received ${describeValue(candidate.allowUnknownModels)}.`,
    );
  }
  assertCredentialResolver(candidate.credentials, candidate.id as string);

  if (candidate.allowedModels !== undefined) {
    assertModelAllowlist(candidate.allowedModels, candidate.id as string);
  }
  if (candidate.headers !== undefined) {
    assertStringMap(candidate.headers, `AI provider binding "${candidate.id as string}" headers`);
  }
  if (candidate.queryParams !== undefined) {
    assertStringMap(
      candidate.queryParams,
      `AI provider binding "${candidate.id as string}" queryParams`,
    );
  }
  if (candidate.compatibility !== undefined && !isJsonObject(candidate.compatibility)) {
    throw new TypeError(
      `AI provider binding "${candidate.id as string}" compatibility must be a JSON object, received ${describeValue(candidate.compatibility)}.`,
    );
  }
  if (candidate.transport !== undefined) {
    assertTransportOverride(candidate.transport, candidate.id as string);
  }
}

function assertCredentialResolver(value: unknown, providerId: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      `AI provider binding "${providerId}" credentials must be a ProviderCredentialResolver, received ${describeValue(value)}.`,
    );
  }
  if (typeof (value as { resolve?: unknown }).resolve !== "function") {
    throw new TypeError(
      `AI provider binding "${providerId}" credentials must implement resolve().`,
    );
  }
}

function assertModelAllowlist(value: unknown, providerId: string): void {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `AI provider binding "${providerId}" allowedModels must be an array, received ${describeValue(value)}.`,
    );
  }
  const seen = new Set<string>();
  for (const model of value) {
    assertNonEmptyString(model, `AI provider binding "${providerId}" allowedModels entry`);
    if (seen.has(model)) {
      throw new TypeError(
        `AI provider binding "${providerId}" allowedModels lists "${model}" twice.`,
      );
    }
    seen.add(model);
  }
}

function assertStringMap(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object, received ${describeValue(value)}.`);
  }
  for (const [key, member] of Object.entries(value)) {
    if (typeof member !== "string") {
      throw new TypeError(
        `${label} entry "${key}" must be a string, received ${describeValue(member)}.`,
      );
    }
  }
}

function assertTransportOverride(value: unknown, providerId: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      `AI provider binding "${providerId}" transport must be an object, received ${describeValue(value)}.`,
    );
  }
  assertExactKeys(
    value as Record<string, unknown>,
    ["fetch"],
    `AI provider binding "${providerId}" transport`,
  );
  const fetchImpl = (value as { fetch?: unknown }).fetch;
  if (fetchImpl !== undefined && typeof fetchImpl !== "function") {
    throw new TypeError(
      `AI provider binding "${providerId}" transport fetch must be a function, received ${describeValue(fetchImpl)}.`,
    );
  }
}
