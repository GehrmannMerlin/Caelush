import type { ModelCatalog, ProviderRegistry } from "@caelush/ai";
import type { ClientModelSelection, ModelRef } from "@caelush/protocol";

export interface DaemonModelProfileConfig {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly recommendedOutputReserveTokens: number;
  readonly supportsPromptCaching?: boolean;
  readonly supportsUsageReporting?: boolean;
  readonly toolOutputSoftLimitTokens?: number;
}

export interface DaemonModelProviderConfig {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly queryParams?: Readonly<Record<string, string>>;
  readonly allowedModels?: readonly string[];
  readonly modelProfiles?: Readonly<Record<string, DaemonModelProfileConfig>>;
  readonly fetch?: typeof fetch;
}

export interface DaemonModelCanonicalizer {
  canonicalize(selection: ClientModelSelection): ModelRef;
}

export class DaemonModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonModelConfigurationError";
  }
}

/**
 * Model canonicalization backed by the AI subsystem's own catalogs.
 *
 * The canonical form of a client selection is exactly `provider + model`: identity is
 * what the model catalog and provider registry agree on, and the provider binding
 * owns the endpoint.
 *
 * The replaced `ConfiguredModelCanonicalizer` copied `provider.baseUrl` into
 * `ModelRef.baseUrl`, which competed with the provider registry for endpoint
 * authority. Nothing here writes an endpoint into a model reference.
 */
export class CatalogModelCanonicalizer implements DaemonModelCanonicalizer {
  constructor(
    private readonly models: ModelCatalog,
    private readonly providers: ProviderRegistry,
  ) {}

  canonicalize(selection: ClientModelSelection): ModelRef {
    if (!this.providers.has(selection.provider)) {
      throw new DaemonModelConfigurationError("The requested model provider is unavailable.");
    }
    const ref: ModelRef = { provider: selection.provider, model: selection.model };
    try {
      this.models.resolve({ provider: ref.provider, model: ref.model });
    } catch {
      throw new DaemonModelConfigurationError("The requested model is unavailable.");
    }
    return ref;
  }
}

export function toClientModelSelection(model: ModelRef): ClientModelSelection {
  return { provider: model.provider, model: model.model };
}
