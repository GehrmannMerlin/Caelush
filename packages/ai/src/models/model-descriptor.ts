import { assertExactKeys, assertNonEmptyString, describeValue } from "../internal/assertions.js";
import { isJsonObject } from "../json/json-value.js";
import { isValidApiId } from "../ids/api-id.js";
import { isValidProviderId } from "../ids/provider-id.js";
import { assertModelCacheProfile } from "./model-cache-profile.js";
import { assertModelCapabilities } from "./model-capabilities.js";
import { assertModelLimits } from "./model-limits.js";
import { assertModelReasoningProfile } from "./model-reasoning-profile.js";
import { isModelDescriptorSource } from "./model-descriptor-source.js";
import type { ApiId } from "../ids/api-id.js";
import type { JsonObject } from "../json/json-value.js";
import type { ModelCacheProfile } from "./model-cache-profile.js";
import type { ModelCapabilities } from "./model-capabilities.js";
import type { ModelDescriptorSource } from "./model-descriptor-source.js";
import type { ModelLimits } from "./model-limits.js";
import type { ModelReasoningProfile } from "./model-reasoning-profile.js";
import type { ModelRef } from "./model-ref.js";

/**
 * The single AI-layer authority for one model.
 *
 * A descriptor owns the API dialect, the token limits, the capability matrix, the
 * reasoning levels and the cache support for exactly one {@link ModelRef}.
 *
 * It must never carry an endpoint, an API key, pricing, an Agent context reserve,
 * tool output limits or run policy. Those belong to the provider connection or to
 * the Agent layer, and the frozen architecture makes `@caelush/ai` the wrong home
 * for them.
 */
export interface ModelDescriptor {
  readonly ref: ModelRef;
  readonly api: ApiId;
  readonly displayName?: string;
  readonly limits: ModelLimits;
  readonly capabilities: ModelCapabilities;
  readonly reasoning?: ModelReasoningProfile;
  readonly cache?: ModelCacheProfile;
  readonly source: ModelDescriptorSource;
  readonly adapterMetadata?: JsonObject;
}

const DESCRIPTOR_KEYS = [
  "ref",
  "api",
  "displayName",
  "limits",
  "capabilities",
  "reasoning",
  "cache",
  "source",
  "adapterMetadata",
] as const;

/**
 * Normalized adapter-metadata keys that must never appear in a descriptor.
 *
 * Compared after lower-casing and removing `_` and `-`, so `apiKey`, `api_key`
 * and `API-KEY` are all rejected. These are exactly the connection and
 * credential fields the frozen descriptor contract forbids.
 */
const FORBIDDEN_METADATA_KEYS = [
  "endpoint",
  "apikey",
  "authorization",
  "bearertoken",
  "token",
  "secret",
  "password",
  "credential",
  "credentials",
  "headers",
  "queryparams",
] as const;

/**
 * Normalized key suffixes that are credential-bearing whatever their prefix.
 *
 * This is what catches a prefixed header name such as `x-api-key`. The check is
 * deliberately conservative and fails closed: a false positive is a loud,
 * trivially fixed configuration error, while a false negative would let
 * credential material into a descriptor that crosses the AI boundary.
 */
const FORBIDDEN_METADATA_KEY_SUFFIXES = ["apikey", "token", "secret", "password"] as const;

/** Assert a well-formed, secret-free model descriptor. */
export function assertModelDescriptor(value: unknown): asserts value is ModelDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Model descriptor must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, DESCRIPTOR_KEYS, "Model descriptor");

  assertModelRef(candidate.ref);
  if (typeof candidate.api !== "string" || !isValidApiId(candidate.api)) {
    throw new TypeError(
      `Model descriptor api must be a valid api id, received ${describeValue(candidate.api)}.`,
    );
  }
  if (candidate.displayName !== undefined) {
    assertNonEmptyString(candidate.displayName, "Model descriptor displayName");
  }
  assertModelLimits(candidate.limits);
  assertModelCapabilities(candidate.capabilities);

  if (candidate.reasoning !== undefined) assertModelReasoningProfile(candidate.reasoning);
  if (candidate.cache !== undefined) assertModelCacheProfile(candidate.cache);

  if (!isModelDescriptorSource(candidate.source)) {
    throw new TypeError(`Model descriptor source is unknown: ${describeValue(candidate.source)}.`);
  }

  if (candidate.adapterMetadata !== undefined) {
    if (!isJsonObject(candidate.adapterMetadata)) {
      throw new TypeError(
        `Model descriptor adapterMetadata must be a JSON object, received ${describeValue(candidate.adapterMetadata)}.`,
      );
    }
    assertSecretFreeMetadata(candidate.adapterMetadata, "Model descriptor adapterMetadata");
  }
}

/** Assert the frozen identity shape of a model reference. */
export function assertModelRef(value: unknown): asserts value is ModelRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Model ref must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, ["provider", "model", "baseUrl"], "Model ref");

  if (typeof candidate.provider !== "string" || !isValidProviderId(candidate.provider)) {
    throw new TypeError(
      `Model ref provider must be a valid provider id, received ${describeValue(candidate.provider)}.`,
    );
  }
  assertNonEmptyString(candidate.model, "Model ref model");
  if (candidate.baseUrl !== undefined) {
    assertNonEmptyString(candidate.baseUrl, "Model ref baseUrl");
  }
}

function assertSecretFreeMetadata(metadata: JsonObject, path: string): void {
  for (const [key, member] of Object.entries(metadata)) {
    if (isForbiddenMetadataKey(key)) {
      throw new TypeError(
        `Model descriptor adapterMetadata must not contain the connection or credential field "${key}" (at ${path}).`,
      );
    }
    if (Array.isArray(member)) {
      member.forEach((entry, index) => {
        if (isJsonObject(entry))
          assertSecretFreeMetadata(entry, `${path}.${key}[${String(index)}]`);
      });
      continue;
    }
    if (isJsonObject(member)) assertSecretFreeMetadata(member, `${path}.${key}`);
  }
}

function isForbiddenMetadataKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
  if ((FORBIDDEN_METADATA_KEYS as readonly string[]).includes(normalized)) return true;
  return FORBIDDEN_METADATA_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}
