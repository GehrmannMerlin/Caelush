import { assertModelDescriptor } from "./model-descriptor.js";
import { deepFreezeJson } from "../internal/deep-freeze-json.js";
import { sameModelIdentity } from "./model-ref.js";
import type { ApiId } from "../ids/api-id.js";
import type { ModelCacheProfile } from "./model-cache-profile.js";
import type { ModelCapabilities } from "./model-capabilities.js";
import type { ModelDescriptor } from "./model-descriptor.js";
import type { ModelDescriptorSource } from "./model-descriptor-source.js";
import type { ModelLimits } from "./model-limits.js";
import type { ModelReasoningProfile } from "./model-reasoning-profile.js";
import type { ModelRef } from "./model-ref.js";

/**
 * Copy a descriptor into an owned, deeply frozen snapshot.
 *
 * The catalog must be immutable after build, and it must not hand out an object a
 * source (or a caller) can still mutate. Every nested structure is copied, so a
 * later mutation of the source's descriptor cannot change what the catalog
 * reports.
 */
export function snapshotDescriptor(descriptor: ModelDescriptor): ModelDescriptor {
  const snapshot: {
    ref: ModelRef;
    api: ApiId;
    displayName?: string;
    limits: ModelLimits;
    capabilities: ModelCapabilities;
    reasoning?: ModelReasoningProfile;
    cache?: ModelCacheProfile;
    source: ModelDescriptorSource;
    adapterMetadata?: ModelDescriptor["adapterMetadata"];
  } = {
    ref: Object.freeze({ ...descriptor.ref }),
    api: descriptor.api,
    limits: Object.freeze({ ...descriptor.limits }),
    capabilities: Object.freeze({ ...descriptor.capabilities }),
    source: descriptor.source,
  };

  if (descriptor.displayName !== undefined) snapshot.displayName = descriptor.displayName;

  if (descriptor.reasoning !== undefined) {
    snapshot.reasoning = Object.freeze({
      supportedLevels: Object.freeze([...descriptor.reasoning.supportedLevels]),
      supportsSummary: descriptor.reasoning.supportsSummary,
      ...(descriptor.reasoning.defaultLevel === undefined
        ? {}
        : { defaultLevel: descriptor.reasoning.defaultLevel }),
    });
  }

  if (descriptor.cache !== undefined) {
    snapshot.cache = Object.freeze({
      supportedRetentions: Object.freeze([...descriptor.cache.supportedRetentions]),
      ...(descriptor.cache.defaultRetention === undefined
        ? {}
        : { defaultRetention: descriptor.cache.defaultRetention }),
    });
  }

  if (descriptor.adapterMetadata !== undefined) {
    snapshot.adapterMetadata = deepFreezeJson(descriptor.adapterMetadata);
  }

  const frozen = Object.freeze(snapshot) as ModelDescriptor;
  assertModelDescriptor(frozen);
  return frozen;
}

/**
 * Validate a source-produced descriptor and snapshot it.
 *
 * Rejects a descriptor whose identity does not match the requested model: a
 * source that answers about a different model has a defect, and silently
 * accepting it would break routing.
 */
export function resolveSourceDescriptor(
  descriptor: ModelDescriptor,
  ref: ModelRef,
  sourceId: string,
): ModelDescriptor {
  assertModelDescriptor(descriptor);
  if (!sameModelIdentity(descriptor.ref, ref)) {
    throw new TypeError(
      `Model descriptor source "${sourceId}" resolved "${descriptor.ref.provider}/${descriptor.ref.model}" for requested model "${ref.provider}/${ref.model}".`,
    );
  }
  return snapshotDescriptor(descriptor);
}
