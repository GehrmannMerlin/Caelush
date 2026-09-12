import { deepFreezeJson } from "../internal/deep-freeze-json.js";
import { assertAIProviderBinding } from "./provider-binding.js";
import { ImmutableProviderRegistry } from "./provider-registry.js";
import type { AIProviderBinding } from "./provider-binding.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { ProviderId } from "../ids/provider-id.js";

/**
 * Builds a runtime {@link ProviderRegistry}.
 *
 * Registration is where a host's provider configuration is checked: duplicate
 * ids, invalid endpoints, non-http(s) schemes and invalid api ids are rejected
 * here rather than at first model invocation.
 */
export interface ProviderRegistryBuilder {
  register(binding: AIProviderBinding): this;
  build(): ProviderRegistry;
}

/** Create an empty provider registry builder. */
export function createProviderRegistryBuilder(): ProviderRegistryBuilder {
  const bindings = new Map<ProviderId, AIProviderBinding>();
  let built = false;

  const assertNotBuilt = (operation: string): void => {
    if (built) throw new TypeError(`Provider registry builder cannot ${operation} after build().`);
  };

  return {
    register(binding: AIProviderBinding): ProviderRegistryBuilder {
      assertNotBuilt("register a provider");
      assertAIProviderBinding(binding);

      if (bindings.has(binding.id)) {
        throw new TypeError(`AI provider "${binding.id}" is already registered.`);
      }
      bindings.set(binding.id, freezeBinding(binding));
      return this;
    },

    build(): ProviderRegistry {
      assertNotBuilt("build twice");
      built = true;
      return new ImmutableProviderRegistry(new Map(bindings));
    },
  };
}

/**
 * Snapshot a validated binding into an immutable copy.
 *
 * Data fields are copied so a caller cannot mutate the registry through the
 * object it registered. The credential resolver is kept by reference: it is a
 * service port with behaviour, not data to copy.
 */
function freezeBinding(binding: AIProviderBinding): AIProviderBinding {
  const frozen: {
    id: ProviderId;
    endpoint: string;
    defaultApi: AIProviderBinding["defaultApi"];
    allowedModels?: readonly string[];
    allowUnknownModels: boolean;
    credentials: AIProviderBinding["credentials"];
    headers?: Readonly<Record<string, string>>;
    queryParams?: Readonly<Record<string, string>>;
    compatibility?: NonNullable<AIProviderBinding["compatibility"]>;
    transport?: NonNullable<AIProviderBinding["transport"]>;
  } = {
    id: binding.id,
    endpoint: binding.endpoint,
    defaultApi: binding.defaultApi,
    allowUnknownModels: binding.allowUnknownModels,
    credentials: binding.credentials,
  };

  if (binding.allowedModels !== undefined) {
    frozen.allowedModels = Object.freeze([...binding.allowedModels]);
  }
  if (binding.headers !== undefined) {
    frozen.headers = Object.freeze({ ...binding.headers });
  }
  if (binding.queryParams !== undefined) {
    frozen.queryParams = Object.freeze({ ...binding.queryParams });
  }
  if (binding.compatibility !== undefined) {
    frozen.compatibility = deepFreezeJson(binding.compatibility);
  }
  if (binding.transport !== undefined) {
    frozen.transport = Object.freeze({ ...binding.transport });
  }

  return Object.freeze(frozen);
}
