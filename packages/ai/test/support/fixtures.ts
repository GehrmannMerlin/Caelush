import type { JsonObject } from "../../src/json/json-value.js";
import type { ModelCacheProfile } from "../../src/models/model-cache-profile.js";
import type { ModelCapabilities } from "../../src/models/model-capabilities.js";
import type { ModelDescriptor } from "../../src/models/model-descriptor.js";
import type { ModelDescriptorSource } from "../../src/models/model-descriptor-source.js";
import type { ModelLimits } from "../../src/models/model-limits.js";
import type { ModelReasoningProfile } from "../../src/models/model-reasoning-profile.js";
import type { ModelRef } from "../../src/models/model-ref.js";

/** Every capability explicitly supported, so a test can opt out of one field at a time. */
export const SUPPORTED_CAPABILITIES: ModelCapabilities = {
  streaming: "SUPPORTED",
  toolCalling: "SUPPORTED",
  parallelToolCalls: "SUPPORTED",
  structuredOutput: "SUPPORTED",
  vision: "SUPPORTED",
  reasoning: "SUPPORTED",
  reasoningSummary: "SUPPORTED",
  promptCaching: "SUPPORTED",
  usageReporting: "SUPPORTED",
};

/** A permissive capability matrix where everything is UNKNOWN. */
export const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  streaming: "UNKNOWN",
  toolCalling: "UNKNOWN",
  parallelToolCalls: "UNKNOWN",
  structuredOutput: "UNKNOWN",
  vision: "UNKNOWN",
  reasoning: "UNKNOWN",
  reasoningSummary: "UNKNOWN",
  promptCaching: "UNKNOWN",
  usageReporting: "UNKNOWN",
};

export interface ModelDescriptorOverrides {
  readonly ref?: ModelRef;
  readonly api?: string;
  readonly limits?: ModelLimits;
  readonly capabilities?: ModelCapabilities;
  readonly reasoning?: ModelReasoningProfile;
  readonly cache?: ModelCacheProfile;
  readonly source?: ModelDescriptorSource;
  readonly adapterMetadata?: JsonObject;
}

/** Build a valid model descriptor for tests, defaulting to an all-supported model. */
export function modelDescriptor(overrides: ModelDescriptorOverrides = {}): ModelDescriptor {
  return {
    ref: overrides.ref ?? { provider: "test", model: "model-a" },
    api: overrides.api ?? "test-api",
    limits: overrides.limits ?? { contextWindowTokens: 100_000, maxOutputTokens: 8_000 },
    capabilities: overrides.capabilities ?? { ...SUPPORTED_CAPABILITIES },
    source: overrides.source ?? "CONFIGURATION",
    ...(overrides.reasoning === undefined ? {} : { reasoning: overrides.reasoning }),
    ...(overrides.cache === undefined ? {} : { cache: overrides.cache }),
    ...(overrides.adapterMetadata === undefined
      ? {}
      : { adapterMetadata: overrides.adapterMetadata }),
  };
}
