import { createAIError } from "../errors/ai-error.js";
import { PROVIDER_DESCRIPTOR_KEYS } from "./provider-descriptor.js";
import type { AIProviderBinding } from "./provider-binding.js";
import type { AIProviderDescriptor } from "./provider-descriptor.js";
import type { ProviderId } from "../ids/provider-id.js";

/**
 * The immutable runtime provider registry.
 *
 * A registry answers "is this provider configured" and "how do I reach it". It is
 * not global: a host composes exactly one registry and injects it, so two
 * subsystems can never share hidden provider state.
 */
export interface ProviderRegistry {
  /** The binding for a provider; throws `AI_PROVIDER_NOT_FOUND` when absent. */
  get(providerId: ProviderId): AIProviderBinding;
  has(providerId: ProviderId): boolean;
  /** Secret-safe descriptors, sorted by provider id. */
  list(): readonly AIProviderDescriptor[];
}

/** The runtime implementation. Constructed only through the builder. */
export class ImmutableProviderRegistry implements ProviderRegistry {
  readonly #bindings: ReadonlyMap<ProviderId, AIProviderBinding>;
  readonly #descriptors: readonly AIProviderDescriptor[];

  constructor(bindings: ReadonlyMap<ProviderId, AIProviderBinding>) {
    this.#bindings = bindings;
    this.#descriptors = Object.freeze(
      [...bindings.keys()].sort(compareStrings).map((id) => describeProvider(bindings.get(id)!)),
    );
    Object.freeze(this);
  }

  get(providerId: ProviderId): AIProviderBinding {
    const binding = this.#bindings.get(providerId);
    if (binding === undefined) {
      throw createAIError(
        "AI_PROVIDER_NOT_FOUND",
        `AI provider "${providerId}" is not configured.`,
        { providerId },
      );
    }
    return binding;
  }

  has(providerId: ProviderId): boolean {
    return this.#bindings.has(providerId);
  }

  list(): readonly AIProviderDescriptor[] {
    return this.#descriptors;
  }
}

/**
 * Project a binding into its secret-safe descriptor.
 *
 * Only the frozen descriptor fields are copied. The endpoint, the credential
 * resolver, the header and query maps, the compatibility object and the
 * transport override are all deliberately dropped here — this function is the
 * boundary that makes a provider safe to report.
 */
export function describeProvider(binding: AIProviderBinding): AIProviderDescriptor {
  const descriptor: {
    id: ProviderId;
    defaultApi: AIProviderBinding["defaultApi"];
    configured: boolean;
    allowedModels?: readonly string[];
    allowUnknownModels: boolean;
  } = {
    id: binding.id,
    defaultApi: binding.defaultApi,
    configured: true,
    allowUnknownModels: binding.allowUnknownModels,
  };

  if (binding.allowedModels !== undefined) {
    descriptor.allowedModels = Object.freeze([...binding.allowedModels]);
  }

  // Guard the boundary: a future descriptor field must be added deliberately.
  for (const key of Object.keys(descriptor)) {
    if (!(PROVIDER_DESCRIPTOR_KEYS as readonly string[]).includes(key)) {
      throw new TypeError(`AI provider descriptor contains an unexpected field "${key}".`);
    }
  }

  return Object.freeze(descriptor);
}

/** Deterministic code-unit string comparison, independent of locale. */
export function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
