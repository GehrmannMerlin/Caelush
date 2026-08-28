import { LLMProviderError, LLMProviderNotFoundError } from "./errors.js";
import { ProviderIdSchema } from "./provider.js";
import type { LLMProvider, ProviderId } from "./provider.js";

export class LLMProviderRegistry {
  private readonly providers = new Map<ProviderId, LLMProvider>();

  register(provider: LLMProvider): void {
    const parsedId = ProviderIdSchema.safeParse(provider.id);
    if (!parsedId.success) {
      throw new LLMProviderError(`Invalid LLM provider id "${provider.id}".`);
    }
    if (this.providers.has(parsedId.data)) {
      throw new LLMProviderError(`LLM provider "${parsedId.data}" is already registered.`, {
        providerId: parsedId.data,
      });
    }
    this.providers.set(parsedId.data, provider);
  }

  get(providerId: string): LLMProvider {
    const provider = this.providers.get(providerId as ProviderId);
    if (provider === undefined) {
      throw new LLMProviderNotFoundError(providerId);
    }
    return provider;
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId as ProviderId);
  }

  listProviderIds(): readonly ProviderId[] {
    return [...this.providers.keys()];
  }
}
