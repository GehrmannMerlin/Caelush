export type ModelContextProfileSource =
  "CONFIGURATION" | "KNOWN_METADATA" | "LEGACY_LIMITS" | "OVERRIDE" | "FALLBACK";

/**
 * COMPATIBILITY PROJECTION — not model metadata authority.
 *
 * Since Phase 2C the model's technical metadata authority is the AI core's
 * `ModelDescriptor`: `contextWindowTokens`, `maxOutputTokens`, `supportsPromptCaching`
 * and `supportsUsageReporting` all originate there and are projected here by
 * `projectModelContextProfile` for the Context runtime's existing consumers.
 *
 * The two fields that are *not* model intrinsics — `recommendedOutputReserveTokens`
 * and `toolOutputSoftLimitTokens` — are Context policy. They are combined into this
 * compatibility view but never originate from a model descriptor, and nothing may
 * read them back as if they described the model.
 */
export interface ModelContextProfile {
  readonly providerId: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly recommendedOutputReserveTokens: number;
  readonly supportsPromptCaching: boolean;
  readonly supportsUsageReporting: boolean;
  readonly toolOutputSoftLimitTokens?: number;
  readonly profileSource: ModelContextProfileSource;
}

/** The subset of an AI model descriptor this projection consumes. */
export interface ModelDescriptorProjectionInput {
  readonly ref: { readonly provider: string; readonly model: string };
  readonly limits: { readonly contextWindowTokens: number; readonly maxOutputTokens: number };
  readonly capabilities: {
    readonly promptCaching: "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN";
    readonly usageReporting: "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN";
  };
  readonly source: string;
}

/**
 * Project the AI core's model descriptor plus Context policy metadata onto the
 * legacy compatibility profile.
 *
 * The intrinsic fields come from the descriptor and cannot be overridden here. The
 * policy fields come from the caller's policy configuration, so a descriptor can
 * never smuggle an output reserve or a tool-output limit into Context policy.
 */
export function projectModelContextProfile(input: {
  readonly descriptor: ModelDescriptorProjectionInput;
  readonly recommendedOutputReserveTokens: number;
  readonly toolOutputSoftLimitTokens?: number;
}): ModelContextProfile {
  const { descriptor } = input;
  return {
    providerId: descriptor.ref.provider,
    modelId: descriptor.ref.model,
    contextWindowTokens: descriptor.limits.contextWindowTokens,
    maxOutputTokens: descriptor.limits.maxOutputTokens,
    recommendedOutputReserveTokens: input.recommendedOutputReserveTokens,
    // Only an explicit SUPPORTED is a true capability. UNKNOWN must never be
    // promoted to a guarantee the descriptor did not make.
    supportsPromptCaching: descriptor.capabilities.promptCaching === "SUPPORTED",
    supportsUsageReporting: descriptor.capabilities.usageReporting === "SUPPORTED",
    ...(input.toolOutputSoftLimitTokens === undefined
      ? {}
      : { toolOutputSoftLimitTokens: input.toolOutputSoftLimitTokens }),
    profileSource: descriptor.source === "FALLBACK" ? "FALLBACK" : "CONFIGURATION",
  };
}

export interface ModelContextProfileInput extends Omit<
  ModelContextProfile,
  "profileSource" | "providerId" | "modelId"
> {
  readonly providerId: string;
  readonly modelId: string;
  readonly profileSource?: ModelContextProfileSource;
}

export interface ModelContextProfileResolutionInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly configuredProfiles?: readonly ModelContextProfile[];
  readonly knownProfiles?: readonly ModelContextProfile[];
  readonly overrides?: readonly ModelContextProfile[];
  readonly legacyLimits?: Readonly<{
    readonly maxInputTokens: number;
    readonly outputReserveTokens?: number;
    readonly safetyReserveTokens?: number;
  }>;
  readonly fallback?: Readonly<{
    readonly contextWindowTokens: number;
    readonly maxOutputTokens: number;
    readonly recommendedOutputReserveTokens: number;
    readonly supportsPromptCaching?: boolean;
    readonly supportsUsageReporting?: boolean;
    readonly toolOutputSoftLimitTokens?: number;
  }>;
}

interface FallbackProfileConfig {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly recommendedOutputReserveTokens: number;
  readonly supportsPromptCaching: boolean;
  readonly supportsUsageReporting: boolean;
  readonly toolOutputSoftLimitTokens?: number;
}

const DEFAULT_LEGACY_SAFETY_RESERVE = 512;

const DEFAULT_FALLBACK: FallbackProfileConfig = {
  contextWindowTokens: 16_000,
  maxOutputTokens: 4096,
  recommendedOutputReserveTokens: 2048,
  supportsPromptCaching: false,
  supportsUsageReporting: false,
} as const;

function requireText(name: string, value: string): void {
  if (value.trim().length === 0) throw new RangeError(`${name} must not be empty`);
}

function requirePositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function requireNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export function createModelContextProfile(input: ModelContextProfileInput): ModelContextProfile {
  requireText("providerId", input.providerId);
  requireText("modelId", input.modelId);
  requirePositiveSafeInteger("contextWindowTokens", input.contextWindowTokens);
  requirePositiveSafeInteger("maxOutputTokens", input.maxOutputTokens);
  if (
    !Number.isSafeInteger(input.recommendedOutputReserveTokens) ||
    input.recommendedOutputReserveTokens < 0
  ) {
    throw new RangeError("recommendedOutputReserveTokens must be a non-negative safe integer");
  }
  if (input.recommendedOutputReserveTokens >= input.contextWindowTokens) {
    throw new RangeError("recommendedOutputReserveTokens must be less than contextWindowTokens");
  }
  if (
    input.toolOutputSoftLimitTokens !== undefined &&
    (!Number.isSafeInteger(input.toolOutputSoftLimitTokens) || input.toolOutputSoftLimitTokens <= 0)
  ) {
    throw new RangeError("toolOutputSoftLimitTokens must be a positive safe integer");
  }
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    contextWindowTokens: input.contextWindowTokens,
    maxOutputTokens: input.maxOutputTokens,
    recommendedOutputReserveTokens: input.recommendedOutputReserveTokens,
    supportsPromptCaching: input.supportsPromptCaching,
    supportsUsageReporting: input.supportsUsageReporting,
    ...(input.toolOutputSoftLimitTokens === undefined
      ? {}
      : { toolOutputSoftLimitTokens: input.toolOutputSoftLimitTokens }),
    profileSource: input.profileSource ?? "CONFIGURATION",
  };
}

function findProfile(
  profiles: readonly ModelContextProfile[] | undefined,
  providerId: string,
  modelId: string,
): ModelContextProfile | undefined {
  return profiles?.find(
    (profile) => profile.providerId === providerId && profile.modelId === modelId,
  );
}

function cloneProfile(
  profile: ModelContextProfile,
  profileSource: ModelContextProfileSource,
): ModelContextProfile {
  return createModelContextProfile({ ...profile, profileSource });
}

export function resolveModelContextProfile(
  input: ModelContextProfileResolutionInput,
): ModelContextProfile {
  requireText("providerId", input.providerId);
  requireText("modelId", input.modelId);
  const configured = findProfile(input.configuredProfiles, input.providerId, input.modelId);
  if (configured !== undefined) return cloneProfile(configured, "CONFIGURATION");
  const known = findProfile(input.knownProfiles, input.providerId, input.modelId);
  if (known !== undefined) return cloneProfile(known, "KNOWN_METADATA");
  const override = findProfile(input.overrides, input.providerId, input.modelId);
  if (override !== undefined) return cloneProfile(override, "OVERRIDE");
  if (input.legacyLimits !== undefined) {
    requirePositiveSafeInteger("legacyLimits.maxInputTokens", input.legacyLimits.maxInputTokens);
    const outputReserveTokens = input.legacyLimits.outputReserveTokens ?? 0;
    const safetyReserveTokens =
      input.legacyLimits.safetyReserveTokens ?? DEFAULT_LEGACY_SAFETY_RESERVE;
    requireNonNegativeSafeInteger("legacyLimits.outputReserveTokens", outputReserveTokens);
    requireNonNegativeSafeInteger("legacyLimits.safetyReserveTokens", safetyReserveTokens);
    return createModelContextProfile({
      providerId: input.providerId,
      modelId: input.modelId,
      contextWindowTokens:
        input.legacyLimits.maxInputTokens + outputReserveTokens + safetyReserveTokens,
      maxOutputTokens: Math.max(1, outputReserveTokens),
      recommendedOutputReserveTokens: outputReserveTokens,
      supportsPromptCaching: false,
      supportsUsageReporting: false,
      profileSource: "LEGACY_LIMITS",
    });
  }
  const fallback = input.fallback ?? DEFAULT_FALLBACK;
  return createModelContextProfile({
    providerId: input.providerId,
    modelId: input.modelId,
    contextWindowTokens: fallback.contextWindowTokens,
    maxOutputTokens: fallback.maxOutputTokens,
    recommendedOutputReserveTokens: fallback.recommendedOutputReserveTokens,
    supportsPromptCaching: fallback.supportsPromptCaching ?? false,
    supportsUsageReporting: fallback.supportsUsageReporting ?? false,
    ...(fallback.toolOutputSoftLimitTokens === undefined
      ? {}
      : { toolOutputSoftLimitTokens: fallback.toolOutputSoftLimitTokens }),
    profileSource: "FALLBACK",
  });
}
