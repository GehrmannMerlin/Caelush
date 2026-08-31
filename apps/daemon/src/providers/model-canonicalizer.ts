import type { ClientModelSelection, ModelRef } from "@caelush/protocol";

export interface DaemonModelProviderConfig {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly queryParams?: Readonly<Record<string, string>>;
  readonly allowedModels?: readonly string[];
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

export class ConfiguredModelCanonicalizer implements DaemonModelCanonicalizer {
  private readonly providers: ReadonlyMap<string, DaemonModelProviderConfig>;

  constructor(configs: readonly DaemonModelProviderConfig[] = []) {
    this.providers = new Map(configs.map((config) => [config.provider, { ...config }]));
  }

  canonicalize(selection: ClientModelSelection): ModelRef {
    const provider = this.providers.get(selection.provider);
    if (this.providers.size > 0 && provider === undefined) {
      throw new DaemonModelConfigurationError("The requested model provider is unavailable.");
    }
    if (provider === undefined) return { ...selection };
    if (provider.allowedModels !== undefined && !provider.allowedModels.includes(selection.model)) {
      throw new DaemonModelConfigurationError("The requested model is unavailable.");
    }
    return { ...selection, baseUrl: provider.baseUrl };
  }
}

export function toClientModelSelection(model: ModelRef): ClientModelSelection {
  return { provider: model.provider, model: model.model };
}
