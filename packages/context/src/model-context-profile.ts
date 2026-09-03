export type ModelContextProfileSource =
  "CONFIGURATION" | "KNOWN_METADATA" | "OVERRIDE" | "FALLBACK";

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

export function createModelContextProfile(input: ModelContextProfileInput): ModelContextProfile {
  requireText("providerId", input.providerId);
  requireText("modelId", input.modelId);
  requirePositiveSafeInteger("contextWindowTokens", input.contextWindowTokens);
  requirePositiveSafeInteger("maxOutputTokens", input.maxOutputTokens);
  requirePositiveSafeInteger(
    "recommendedOutputReserveTokens",
    input.recommendedOutputReserveTokens,
  );
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
