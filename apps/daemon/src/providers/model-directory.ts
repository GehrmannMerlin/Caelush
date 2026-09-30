import { type ModelCatalog, type ModelDescriptor, type ProviderCredentials } from "@caelush/ai";
import type {
  AIModelDirectoryResponse,
  ModelView,
  ProviderView,
  ReasoningPresentation,
} from "@caelush/protocol";
import { getCuratedModelMetadata } from "./curated-model-metadata.js";
import type { RuntimeProviderCredentialAuthority } from "./credential-authority.js";
import { ProviderPresetRegistry, type ProviderPreset } from "./provider-presets.js";

export interface RuntimeModelDirectoryServiceOptions {
  readonly presets: ProviderPresetRegistry;
  readonly credentials: RuntimeProviderCredentialAuthority;
  readonly models: ModelCatalog;
}

export class ModelDiscoveryError extends Error {
  readonly code: "AI_AUTHENTICATION" | "AI_NETWORK" | "AI_INVALID_RESPONSE";
  readonly providerId: string;

  constructor(
    providerId: string,
    code: "AI_AUTHENTICATION" | "AI_NETWORK" | "AI_INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "ModelDiscoveryError";
    this.code = code;
    this.providerId = providerId;
  }
}

/**
 * Host-side model discovery and directory projection.
 *
 * Discovery is intentionally separate from the immutable AI ModelCatalog: network
 * results are cached here, while exact descriptor metadata stays in the frozen
 * catalog and unknown models are projected without invented capabilities.
 */
export class RuntimeModelDirectoryService {
  readonly #presets: ProviderPresetRegistry;
  readonly #credentials: RuntimeProviderCredentialAuthority;
  readonly #models: ModelCatalog;
  readonly #cache = new Map<string, readonly ModelView[]>();
  readonly #states = new Map<string, { state: "READY" | "FAILED"; error?: string }>();

  constructor(options: RuntimeModelDirectoryServiceOptions) {
    this.#presets = options.presets;
    this.#credentials = options.credentials;
    this.#models = options.models;
  }

  async getProviderViews(): Promise<readonly ProviderView[]> {
    const views: ProviderView[] = [];
    for (const preset of this.#presets.list()) {
      const credential = await this.#credentials.describe(preset.id);
      const state = this.#states.get(preset.id);
      views.push({
        id: preset.id,
        displayName: preset.displayName,
        credentialConfigured: credential.configured,
        credentialSource: credential.source,
        credentialWritable: credential.writable,
        discoveryState: state?.state ?? "NOT_CONFIGURED",
        ...(state?.error === undefined ? {} : { discoveryError: state.error }),
      });
    }
    return Object.freeze(views);
  }

  async getDirectory(
    providerId: string,
    options: { readonly signal?: AbortSignal; readonly refresh?: boolean } = {},
  ): Promise<AIModelDirectoryResponse> {
    const preset = this.#presets.get(providerId);
    const cached = this.#cache.get(providerId);
    if (cached !== undefined && options.refresh !== true) {
      return { provider: providerId, models: [...cached] };
    }

    const credential = await this.#credentials.describe(providerId);
    if (!credential.configured) {
      this.#cache.delete(providerId);
      this.#states.delete(providerId);
      return { provider: providerId, models: [] };
    }

    try {
      const resolved = await this.#credentials.resolve(
        providerId,
        options.signal ?? new AbortController().signal,
      );
      const modelIds = await this.discoverWithCredential(providerId, resolved, options.signal);
      const models = modelIds.map((modelId) => this.projectModel(preset, modelId));
      this.#cache.set(providerId, Object.freeze(models));
      this.#states.set(providerId, { state: "READY" });
      return { provider: providerId, models: [...models] };
    } catch (error) {
      const safe = safeDiscoveryFailure(error, providerId);
      this.#states.set(providerId, { state: "FAILED", error: safe.message });
      throw safe;
    }
  }

  /** Validate a candidate key without saving it or changing the current cache. */
  async discoverWithCandidate(
    providerId: string,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<AIModelDirectoryResponse> {
    const preset = this.#presets.get(providerId);
    const modelIds = await this.discoverWithCredential(providerId, { apiKey }, signal);
    const models = modelIds.map((modelId) => this.projectModel(preset, modelId));
    return { provider: providerId, models };
  }

  /** Invalidate only the provider whose credential or endpoint changed. */
  invalidate(providerId: string): void {
    this.#cache.delete(providerId);
    this.#states.delete(providerId);
  }

  invalidateAll(): void {
    this.#cache.clear();
    this.#states.clear();
  }

  /** Cache a successful candidate discovery after the caller persists its key. */
  cacheValidatedDirectory(directory: AIModelDirectoryResponse): void {
    if (directory.provider === undefined) return;
    this.#cache.set(directory.provider, Object.freeze([...directory.models]));
    this.#states.set(directory.provider, { state: "READY" });
  }

  /** Validate model identity and exact reasoning level for Session/Run writes. */
  async validateSelection(input: {
    readonly provider: string;
    readonly model: string;
    readonly reasoningLevel?: import("@caelush/protocol").ReasoningLevel;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const preset = this.#presets.get(input.provider);
    // A legacy daemon may intentionally expose an allowlist without a working
    // discovery endpoint. Its allowlist is already a host-owned routing fact,
    // so validate those entries locally and preserve the pre-V1 API behavior.
    // New control-plane selections still come from discovery and take the path
    // below when no legacy allowlist can answer the question.
    if (preset.allowedModels?.includes(input.model) === true) {
      const credential = await this.#credentials.describe(input.provider);
      if (!credential.configured) {
        throw new ModelSelectionError(
          "MODEL_UNAVAILABLE",
          "The selected provider is not connected.",
        );
      }
      const model = this.projectModel(preset, input.model);
      validateReasoningSelection(model, input.reasoningLevel);
      return;
    }
    const directory = await this.getDirectory(
      input.provider,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    const model = directory.models.find((candidate) => candidate.id === input.model);
    if (model === undefined)
      throw new ModelSelectionError("MODEL_UNAVAILABLE", "The selected model is unavailable.");
    validateReasoningSelection(model, input.reasoningLevel);
  }

  private projectModel(preset: ProviderPreset, modelId: string): ModelView {
    let descriptor: ModelDescriptor;
    try {
      descriptor = this.#models.resolve({ provider: preset.id, model: modelId });
    } catch {
      // A directory can still safely display an accessible id even if a host chose
      // not to register a fallback descriptor. It carries no reasoning/capability claim.
      return {
        provider: preset.id,
        id: modelId,
        displayName: modelId,
        availability: "AVAILABLE",
      };
    }

    const curated = getCuratedModelMetadata(preset.id, modelId);
    const reasoning =
      descriptor.reasoning === undefined
        ? undefined
        : descriptor.source === "BUILTIN"
          ? (curated?.reasoningPresentation ?? presentReasoning(descriptor))
          : presentReasoning(descriptor);
    return {
      provider: preset.id,
      id: modelId,
      displayName: descriptor.displayName ?? modelId,
      availability: "AVAILABLE",
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }

  private async discoverWithCredential(
    providerId: string,
    credentials: ProviderCredentials,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const preset = this.#presets.get(providerId);
    const endpoint = new URL(preset.discovery.path, ensureTrailingSlash(preset.endpoint));
    for (const [key, value] of Object.entries(preset.queryParams ?? {})) {
      endpoint.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      ...(preset.headers ?? {}),
      accept: "application/json",
    };
    if (preset.discovery.credentialTransport === "API_KEY") {
      if (credentials.apiKey === undefined)
        throw new ModelDiscoveryError(
          providerId,
          "AI_AUTHENTICATION",
          "Provider authentication failed.",
        );
      headers["x-api-key"] = credentials.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (credentials.apiKey !== undefined) {
      headers.authorization = `Bearer ${credentials.apiKey}`;
    } else if (credentials.bearerToken !== undefined) {
      headers.authorization = `Bearer ${credentials.bearerToken}`;
    } else {
      throw new ModelDiscoveryError(
        providerId,
        "AI_AUTHENTICATION",
        "Provider authentication failed.",
      );
    }

    const fetchImpl = preset.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "GET",
        headers,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new ModelDiscoveryError(providerId, "AI_NETWORK", "Model discovery was cancelled.");
      }
      throw new ModelDiscoveryError(providerId, "AI_NETWORK", "Provider could not be reached.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new ModelDiscoveryError(providerId, "AI_AUTHENTICATION", "API key is invalid.");
    }
    if (!response.ok) {
      throw new ModelDiscoveryError(providerId, "AI_NETWORK", "Model discovery failed.");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ModelDiscoveryError(
        providerId,
        "AI_INVALID_RESPONSE",
        "Model discovery returned an invalid response.",
      );
    }
    const ids = extractModelIds(payload);
    return Object.freeze(ids.filter((id) => !isClearlyNonChatModel(id)).sort(compareStrings));
  }
}

function validateReasoningSelection(
  model: ModelView,
  reasoningLevel: import("@caelush/protocol").ReasoningLevel | undefined,
): void {
  if (reasoningLevel === undefined) return;
  const options = model.reasoning?.options ?? [];
  if (!options.some((option) => option.level === reasoningLevel)) {
    throw new ModelSelectionError(
      "REASONING_UNSUPPORTED",
      "The selected reasoning level is not supported by this model.",
    );
  }
}

export class ModelSelectionError extends Error {
  readonly kind:
    "PROVIDER_UNAVAILABLE" | "MODEL_UNAVAILABLE" | "REASONING_UNSUPPORTED" | "NO_MODEL_SELECTED";

  constructor(
    kind:
      "PROVIDER_UNAVAILABLE" | "MODEL_UNAVAILABLE" | "REASONING_UNSUPPORTED" | "NO_MODEL_SELECTED",
    message: string,
  ) {
    super(message);
    this.name = "ModelSelectionError";
    this.kind = kind;
  }
}

function extractModelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ModelDiscoveryError(
      "unknown",
      "AI_INVALID_RESPONSE",
      "Model discovery returned an invalid response.",
    );
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new ModelDiscoveryError(
      "unknown",
      "AI_INVALID_RESPONSE",
      "Model discovery returned an invalid response.",
    );
  }
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id.trim().length > 0) ids.push(id);
  }
  return [...new Set(ids)];
}

function presentReasoning(descriptor: ModelDescriptor): ReasoningPresentation {
  return {
    ...(descriptor.reasoning?.defaultLevel === undefined
      ? {}
      : { defaultLevel: descriptor.reasoning.defaultLevel }),
    options: (descriptor.reasoning?.supportedLevels ?? []).map((level) => ({
      level,
      displayName: level === "XHIGH" ? "Extra High" : `${level[0]}${level.slice(1).toLowerCase()}`,
    })),
  };
}

function ensureTrailingSlash(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
}

function isClearlyNonChatModel(id: string): boolean {
  return /(?:^|[-_/])(embedding|moderation|tts|whisper|transcription|dall-e|image|audio|video|realtime)(?:[-_/]|$)/iu.test(
    id,
  );
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function safeDiscoveryFailure(error: unknown, providerId: string): ModelDiscoveryError {
  if (error instanceof ModelDiscoveryError) {
    return error.providerId === providerId
      ? error
      : new ModelDiscoveryError(providerId, error.code, error.message);
  }
  if (error instanceof Error && error.name === "AIError") {
    return new ModelDiscoveryError(providerId, "AI_AUTHENTICATION", "API key is invalid.");
  }
  return new ModelDiscoveryError(providerId, "AI_NETWORK", "Model discovery failed.");
}
