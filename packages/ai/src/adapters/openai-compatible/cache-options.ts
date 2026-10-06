import { createAIError } from "../../errors/ai-error.js";
import type { ModelDescriptor } from "../../models/model-descriptor.js";
import type { ResolvedAIModelRequest } from "../../request/resolved-model-request.js";
import { OPENAI_COMPATIBLE_METADATA_NAMESPACE } from "./request-options.js";

/** The OpenAI-compatible cache behavior understood by this adapter revision. */
export type OpenAICompatibleCacheMode = "NONE" | "AUTOMATIC";

/** A semantic cache mode, with no provider key or wire-specific fields. */
export interface OpenAICompatibleCacheOptions {
  readonly mode: OpenAICompatibleCacheMode;
}

/**
 * Resolve whether the adapter can honor the settled semantic cache retention.
 *
 * `AUTOMATIC` describes server-side exact-prefix caching. It does not add a cache
 * field, a header, a user id, or a generated key to the provider request.
 */
export function resolveOpenAICompatibleCacheOptions(
  model: ModelDescriptor,
  request: ResolvedAIModelRequest,
): OpenAICompatibleCacheOptions {
  const dialect = cacheDialect(model);
  const retention = request.settings.cache.effective;
  if (retention === "NONE") return { mode: "NONE" };

  const descriptorSupportsRetention =
    model.capabilities.promptCaching === "SUPPORTED" &&
    model.cache?.supportedRetentions.includes(retention) === true;
  if (!descriptorSupportsRetention || dialect !== "AUTOMATIC") {
    throw createAIError(
      "AI_CAPABILITY_UNSUPPORTED",
      `The OpenAI-compatible chat dialect cannot express the effective cache retention "${retention}" for this model.`,
      { providerId: model.ref.provider, model: model.ref },
    );
  }

  return { mode: "AUTOMATIC" };
}

function cacheDialect(model: ModelDescriptor): OpenAICompatibleCacheMode {
  const namespace: unknown = model.adapterMetadata?.[OPENAI_COMPATIBLE_METADATA_NAMESPACE];
  if (namespace === undefined) return "NONE";
  if (!isPlainRecord(namespace)) {
    throw new TypeError(
      `Model descriptor adapterMetadata.${OPENAI_COMPATIBLE_METADATA_NAMESPACE} must be an object.`,
    );
  }

  const dialect: unknown = namespace["cacheDialect"];
  if (dialect === undefined || dialect === "NONE" || dialect === "AUTOMATIC") {
    return dialect ?? "NONE";
  }
  throw new TypeError(
    `Model descriptor adapterMetadata.${OPENAI_COMPATIBLE_METADATA_NAMESPACE}.cacheDialect has an unsupported value.`,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
