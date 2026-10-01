import type {
  AIModelDirectoryResponse,
  AIProviderConnectionResponse,
  AIProvidersResponse,
  AgentSession,
  ClientModelSelection,
  ClientModelSelectionWithReasoning,
  ConnectProviderRequest,
  ProviderView,
  ReasoningLevel,
  UpdateAISelectionRequest,
  UpdateSessionModelSelectionRequest,
} from "@caelush/protocol";
import { createTimestampMs } from "@caelush/protocol";
import {
  StorageNotFoundError,
  type AISelectionRepository,
  type SessionRepository,
} from "@caelush/storage";
import type { DaemonModelCanonicalizer } from "../providers/model-canonicalizer.js";
import {
  EnvironmentCredentialReadOnlyError,
  type RuntimeProviderCredentialAuthority,
} from "../providers/credential-authority.js";
import {
  ModelDiscoveryError,
  ModelSelectionError,
  RuntimeModelDirectoryService,
} from "../providers/model-directory.js";
import type { ProviderPresetRegistry } from "../providers/provider-presets.js";

export interface AIConfigurationServiceOptions {
  readonly presets: ProviderPresetRegistry;
  /** Existing native host bindings remain outside the Runtime Preset control plane. */
  readonly compatibilityProviderIds?: ReadonlySet<string>;
  readonly credentials: RuntimeProviderCredentialAuthority;
  readonly directory: RuntimeModelDirectoryService;
  readonly selections: AISelectionRepository;
  readonly sessions: SessionRepository;
  readonly modelCanonicalizer: DaemonModelCanonicalizer;
  readonly now?: () => number;
}

export class AIConfigurationService {
  private readonly now: () => number;

  constructor(private readonly options: AIConfigurationServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async listProviders(): Promise<AIProvidersResponse> {
    return { providers: [...(await this.options.directory.getProviderViews())] };
  }

  async getDirectory(providerId?: string): Promise<AIModelDirectoryResponse> {
    if (providerId !== undefined) {
      this.requireProvider(providerId);
      return this.options.directory.getDirectory(providerId);
    }
    const models: AIModelDirectoryResponse["models"] = [];
    for (const provider of this.options.presets.list()) {
      try {
        const directory = await this.options.directory.getDirectory(provider.id);
        models.push(...directory.models);
      } catch (error) {
        // An unavailable provider must not make other connected providers disappear
        // from the model menu. Its safe failure remains visible in GET providers.
        if (!(error instanceof ModelDiscoveryError)) throw error;
      }
    }
    return { models };
  }

  async connect(
    providerId: string,
    input: ConnectProviderRequest,
    signal?: AbortSignal,
  ): Promise<AIProviderConnectionResponse> {
    this.requireProvider(providerId);
    const current = await this.options.credentials.describe(providerId);
    if (!current.writable && current.source === "ENVIRONMENT") {
      throw new EnvironmentCredentialReadOnlyError(providerId);
    }

    // Validate with the candidate only. The existing local value is untouched
    // until discovery/authentication succeeds.
    const candidateDirectory = await this.options.directory.discoverWithCandidate(
      providerId,
      input.apiKey,
      signal,
    );
    await this.options.credentials.set(providerId, input.apiKey);
    this.options.directory.invalidate(providerId);
    this.options.directory.cacheValidatedDirectory(candidateDirectory);
    return {
      provider: await this.providerView(providerId),
      directory: candidateDirectory,
    };
  }

  async disconnect(providerId: string): Promise<void> {
    this.requireProvider(providerId);
    await this.options.credentials.unset(providerId);
    this.options.directory.invalidate(providerId);
  }

  async getDefaultSelection(): Promise<{ selection?: ClientModelSelectionWithReasoning }> {
    const selection = await this.options.selections.getDefault();
    return selection === undefined ? {} : { selection };
  }

  async setDefaultSelection(
    selection: UpdateAISelectionRequest,
  ): Promise<{ selection: ClientModelSelectionWithReasoning }> {
    await this.validateSelection({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningLevel === undefined
        ? {}
        : { reasoningLevel: selection.reasoningLevel }),
    });
    await this.options.selections.setDefault(selection);
    return { selection };
  }

  async getNewSessionSelection(): Promise<ClientModelSelectionWithReasoning | undefined> {
    return this.options.selections.getDefault();
  }

  async validateSelection(selection: {
    readonly provider: string;
    readonly model: string;
    readonly reasoningLevel?: ReasoningLevel;
  }): Promise<void> {
    if (!this.options.presets.has(selection.provider)) {
      if (this.options.compatibilityProviderIds?.has(selection.provider) === true) return;
      throw new ModelSelectionError(
        "PROVIDER_UNAVAILABLE",
        "The selected provider is unavailable.",
      );
    }
    await this.options.directory.validateSelection(selection);
  }

  /**
   * Preserve the legacy Run-create contract for configured allowlists. Older
   * callers may submit an arbitrary model id and expect the AI gateway's
   * provider allowlist to reject it only when execution starts. New control
   * plane writes remain strict through validateSelection above.
   */
  async validateRunSelection(
    selection: {
      readonly provider: string;
      readonly model: string;
      readonly reasoningLevel?: ReasoningLevel;
    },
    context: { readonly explicitModel: boolean } = { explicitModel: false },
  ): Promise<void> {
    if (this.options.compatibilityProviderIds?.has(selection.provider) === true) return;
    if (context.explicitModel && this.options.presets.has(selection.provider)) {
      const preset = this.options.presets.get(selection.provider);
      if (preset.allowedModels !== undefined && !preset.allowedModels.includes(selection.model)) {
        const credential = await this.options.credentials.describe(selection.provider);
        if (!credential.configured) {
          throw new ModelSelectionError(
            "PROVIDER_UNAVAILABLE",
            "The selected provider is not connected.",
          );
        }
        return;
      }
    }
    await this.validateSelection(selection);
  }

  async updateSessionSelection(
    sessionId: AgentSession["id"],
    input: UpdateSessionModelSelectionRequest,
  ): Promise<AgentSession> {
    await this.validateSelection({
      provider: input.defaultModel.provider,
      model: input.defaultModel.model,
      ...(input.defaultReasoningLevel === undefined
        ? {}
        : { reasoningLevel: input.defaultReasoningLevel }),
    });
    const session = await this.options.sessions.get(sessionId);
    if (session === null) throw new StorageNotFoundError("AgentSession", sessionId);
    const sessionWithoutReasoning = { ...session };
    delete sessionWithoutReasoning.defaultReasoningLevel;
    const updated =
      input.defaultReasoningLevel === undefined
        ? {
            ...sessionWithoutReasoning,
            defaultModel: this.options.modelCanonicalizer.canonicalize(input.defaultModel),
            updatedAt: createTimestampMs(this.now()),
          }
        : {
            ...session,
            defaultModel: this.options.modelCanonicalizer.canonicalize(input.defaultModel),
            defaultReasoningLevel: input.defaultReasoningLevel,
            updatedAt: createTimestampMs(this.now()),
          };
    await this.options.sessions.update(updated);
    return updated;
  }

  private async providerView(providerId: string): Promise<ProviderView> {
    const view = (await this.options.directory.getProviderViews()).find(
      (provider) => provider.id === providerId,
    );
    if (view === undefined)
      throw new ModelSelectionError(
        "PROVIDER_UNAVAILABLE",
        "The selected provider is unavailable.",
      );
    return view;
  }

  private requireProvider(providerId: string): void {
    if (!this.options.presets.has(providerId)) {
      throw new ModelSelectionError(
        "PROVIDER_UNAVAILABLE",
        "The selected provider is unavailable.",
      );
    }
  }
}

export function toAIConfigurationError(error: unknown):
  | {
      readonly kind:
        | "AUTHENTICATION"
        | "PROVIDER_UNAVAILABLE"
        | "MODEL_UNAVAILABLE"
        | "REASONING_UNSUPPORTED"
        | "ENVIRONMENT_READ_ONLY"
        | "NO_MODEL_SELECTED";
      readonly message: string;
    }
  | undefined {
  if (error instanceof EnvironmentCredentialReadOnlyError) {
    return { kind: "ENVIRONMENT_READ_ONLY", message: error.message };
  }
  if (error instanceof ModelDiscoveryError) {
    return error.code === "AI_AUTHENTICATION"
      ? { kind: "AUTHENTICATION", message: error.message }
      : { kind: "PROVIDER_UNAVAILABLE", message: error.message };
  }
  if (error instanceof ModelSelectionError) {
    return { kind: error.kind, message: error.message };
  }
  return undefined;
}

export function selectionFromSession(
  selection: ClientModelSelection | undefined,
  reasoningLevel: ReasoningLevel | undefined,
): ClientModelSelectionWithReasoning | undefined {
  if (selection === undefined) return undefined;
  return reasoningLevel === undefined ? { ...selection } : { ...selection, reasoningLevel };
}
