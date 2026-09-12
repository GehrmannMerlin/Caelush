export type { ProviderCredentialResolver, ProviderCredentials } from "./credentials.js";

export { assertAIProviderBinding, assertProviderEndpoint } from "./provider-binding.js";
export type { AIProviderBinding, AIProviderTransportOverride } from "./provider-binding.js";

export { PROVIDER_DESCRIPTOR_KEYS } from "./provider-descriptor.js";
export type { AIProviderDescriptor } from "./provider-descriptor.js";

export { describeProvider, ImmutableProviderRegistry } from "./provider-registry.js";
export type { ProviderRegistry } from "./provider-registry.js";

export { createProviderRegistryBuilder } from "./provider-registry-builder.js";
export type { ProviderRegistryBuilder } from "./provider-registry-builder.js";

export type { ResolvedProviderConnection } from "./resolved-provider-connection.js";
