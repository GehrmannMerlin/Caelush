import type { ClientModelSelection } from "@caelush/protocol";
import type { DaemonModelProviderConfig } from "./providers/model-canonicalizer.js";
import { z } from "zod";

export interface DaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly sseHeartbeatIntervalMs: number;
}

export interface DaemonProviderStartupConfiguration {
  readonly providers: readonly DaemonModelProviderConfig[];
  readonly defaultModel?: ClientModelSelection;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  host: "127.0.0.1",
  port: 43120,
  sseHeartbeatIntervalMs: 15_000,
};

export function createDaemonConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return { ...DEFAULT_DAEMON_CONFIG, ...overrides };
}

export function assertLoopbackDaemonHost(host: string): void {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized !== "127.0.0.1" && normalized !== "localhost" && normalized !== "::1") {
    throw new Error("The production daemon may bind only to a loopback host.");
  }
}

export function readProviderConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): DaemonProviderStartupConfiguration {
  const provider = env.CAELUSH_PROVIDER_ID;
  const baseUrl = env.CAELUSH_PROVIDER_BASE_URL;
  const apiKey = env.CAELUSH_PROVIDER_API_KEY;
  const modelProfiles = parseModelProfiles(env.CAELUSH_PROVIDER_MODEL_PROFILES);
  const hasProviderConfiguration =
    provider !== undefined || baseUrl !== undefined || apiKey !== undefined;
  if (hasProviderConfiguration && (provider === undefined || baseUrl === undefined)) {
    throw new Error("CAELUSH_PROVIDER_ID and CAELUSH_PROVIDER_BASE_URL are required together.");
  }

  const providers: DaemonModelProviderConfig[] = [];
  if (provider !== undefined && baseUrl !== undefined) {
    const allowedModels = splitEnvironmentList(env.CAELUSH_PROVIDER_ALLOWED_MODELS);
    providers.push({
      provider,
      baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(allowedModels.length === 0 ? {} : { allowedModels }),
      ...(modelProfiles === undefined ? {} : { modelProfiles }),
    });
  }

  const defaultProvider = env.CAELUSH_DEFAULT_PROVIDER;
  const defaultModel = env.CAELUSH_DEFAULT_MODEL;
  if ((defaultProvider === undefined) !== (defaultModel === undefined)) {
    throw new Error("CAELUSH_DEFAULT_PROVIDER and CAELUSH_DEFAULT_MODEL are required together.");
  }

  return {
    providers,
    ...(defaultProvider === undefined || defaultModel === undefined
      ? {}
      : { defaultModel: { provider: defaultProvider, model: defaultModel } }),
  };
}

const ModelProfileSchema = z
  .object({
    contextWindowTokens: z.number().int().positive().safe(),
    maxOutputTokens: z.number().int().positive().safe(),
    recommendedOutputReserveTokens: z.number().int().nonnegative().safe(),
    supportsPromptCaching: z.boolean().optional(),
    supportsUsageReporting: z.boolean().optional(),
    toolOutputSoftLimitTokens: z.number().int().positive().safe().optional(),
  })
  .strict();

const ModelProfilesSchema = z.record(z.string().min(1), ModelProfileSchema);

function parseModelProfiles(
  value: string | undefined,
):
  | Readonly<Record<string, import("./providers/model-canonicalizer.js").DaemonModelProfileConfig>>
  | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value);
  } catch {
    throw new Error("CAELUSH_PROVIDER_MODEL_PROFILES must contain valid JSON.");
  }
  const parsed = ModelProfilesSchema.safeParse(parsedJson);
  if (!parsed.success) throw new Error("CAELUSH_PROVIDER_MODEL_PROFILES is invalid.");
  const result: Record<
    string,
    import("./providers/model-canonicalizer.js").DaemonModelProfileConfig
  > = {};
  for (const [modelId, profile] of Object.entries(parsed.data)) {
    result[modelId] = {
      contextWindowTokens: profile.contextWindowTokens,
      maxOutputTokens: profile.maxOutputTokens,
      recommendedOutputReserveTokens: profile.recommendedOutputReserveTokens,
      ...(profile.supportsPromptCaching === undefined
        ? {}
        : { supportsPromptCaching: profile.supportsPromptCaching }),
      ...(profile.supportsUsageReporting === undefined
        ? {}
        : { supportsUsageReporting: profile.supportsUsageReporting }),
      ...(profile.toolOutputSoftLimitTokens === undefined
        ? {}
        : { toolOutputSoftLimitTokens: profile.toolOutputSoftLimitTokens }),
    };
  }
  return result;
}

function splitEnvironmentList(value: string | undefined): string[] {
  return value === undefined
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}
