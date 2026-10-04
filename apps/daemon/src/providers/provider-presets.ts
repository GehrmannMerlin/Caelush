import { type AIProviderBinding, type ApiId } from "@caelush/ai";
import { ANTHROPIC_MESSAGES_API_ID } from "@caelush/ai/adapters/anthropic-messages";
import { OPENAI_COMPATIBLE_API_ID } from "@caelush/ai/adapters/openai-compatible";
import type { DaemonModelProviderConfig } from "./model-canonicalizer.js";
import {
  createRuntimeProviderCredentialResolver,
  type RuntimeProviderCredentialAuthority,
} from "./credential-authority.js";

export type ProviderDiscoveryDialect = "OPENAI_MODELS" | "ANTHROPIC_MODELS";
export type ProviderCredentialTransport = "BEARER" | "API_KEY";

export interface ProviderPreset {
  readonly id: string;
  readonly displayName: string;
  readonly endpoint: string;
  readonly api: ApiId;
  readonly credentialReference: string;
  readonly discovery: {
    readonly dialect: ProviderDiscoveryDialect;
    readonly path: string;
    readonly credentialTransport: ProviderCredentialTransport;
  };
  readonly compatibility?: NonNullable<AIProviderBinding["compatibility"]>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly queryParams?: Readonly<Record<string, string>>;
  readonly allowedModels?: readonly string[];
  readonly fetch?: typeof fetch;
}

const BUILTIN_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    api: OPENAI_COMPATIBLE_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "OPENAI_MODELS",
      path: "models",
      credentialTransport: "BEARER",
    },
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1",
    api: OPENAI_COMPATIBLE_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "OPENAI_MODELS",
      path: "models",
      credentialTransport: "BEARER",
    },
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    api: OPENAI_COMPATIBLE_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "OPENAI_MODELS",
      path: "models",
      credentialTransport: "BEARER",
    },
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    endpoint: "https://api.anthropic.com",
    api: ANTHROPIC_MESSAGES_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "ANTHROPIC_MODELS",
      path: "v1/models",
      credentialTransport: "API_KEY",
    },
    compatibility: { anthropicMessages: { authMode: "api-key" } },
  },
  {
    id: "kimi",
    displayName: "Kimi（月之暗面）",
    endpoint: "https://api.moonshot.cn/v1",
    api: OPENAI_COMPATIBLE_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "OPENAI_MODELS",
      path: "models",
      credentialTransport: "BEARER",
    },
  },
  {
    id: "glm",
    displayName: "GLM（智谱）",
    endpoint: "https://open.bigmodel.cn/api/paas/v4",
    api: OPENAI_COMPATIBLE_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "OPENAI_MODELS",
      path: "models",
      credentialTransport: "BEARER",
    },
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    endpoint: "https://api.minimax.io/v1",
    api: OPENAI_COMPATIBLE_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "OPENAI_MODELS",
      path: "models",
      credentialTransport: "BEARER",
    },
  },
  {
    id: "mimo",
    displayName: "MiMo（小米）",
    endpoint: "https://api.xiaomimimo.com/v1",
    api: OPENAI_COMPATIBLE_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "OPENAI_MODELS",
      path: "models",
      credentialTransport: "BEARER",
    },
  },
  {
    id: "qwen",
    displayName: "Qwen（通义千问）",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: OPENAI_COMPATIBLE_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "OPENAI_MODELS",
      path: "models",
      credentialTransport: "BEARER",
    },
  },
  {
    id: "gemini",
    displayName: "Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    api: OPENAI_COMPATIBLE_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "OPENAI_MODELS",
      path: "models",
      credentialTransport: "BEARER",
    },
  },
  {
    id: "groq",
    displayName: "Groq",
    endpoint: "https://api.groq.com/openai/v1",
    api: OPENAI_COMPATIBLE_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "OPENAI_MODELS",
      path: "models",
      credentialTransport: "BEARER",
    },
  },
  {
    id: "mistral",
    displayName: "Mistral AI",
    endpoint: "https://api.mistral.ai/v1",
    api: OPENAI_COMPATIBLE_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "OPENAI_MODELS",
      path: "models",
      credentialTransport: "BEARER",
    },
  },
];

/** Immutable host-owned preset registry; it is not the AI ProviderRegistry. */
export class ProviderPresetRegistry {
  readonly #presets: ReadonlyMap<string, ProviderPreset>;

  constructor(presets: readonly ProviderPreset[]) {
    const map = new Map<string, ProviderPreset>();
    for (const preset of presets) {
      if (map.has(preset.id)) throw new TypeError(`Provider preset "${preset.id}" is duplicated.`);
      map.set(preset.id, freezePreset(preset));
    }
    this.#presets = map;
    Object.freeze(this);
  }

  get(providerId: string): ProviderPreset {
    const preset = this.#presets.get(providerId);
    if (preset === undefined) throw new Error(`Provider preset "${providerId}" is unavailable.`);
    return preset;
  }

  has(providerId: string): boolean {
    return this.#presets.has(providerId);
  }

  list(): readonly ProviderPreset[] {
    return Object.freeze([...this.#presets.values()]);
  }
}

/** Build built-ins and preserve the existing generic environment provider seam. */
export function createProviderPresetRegistry(
  legacyProviders: readonly DaemonModelProviderConfig[] = [],
): ProviderPresetRegistry {
  const configured = new Map(legacyProviders.map((provider) => [provider.provider, provider]));
  const presets = BUILTIN_PRESETS.map((preset) =>
    applyLegacyOverride(preset, configured.get(preset.id)),
  );
  for (const provider of legacyProviders) {
    if (presets.some((preset) => preset.id === provider.provider)) continue;
    presets.push(createLegacyPreset(provider));
  }
  return new ProviderPresetRegistry(presets);
}

export function listBuiltinProviderPresets(): readonly ProviderPreset[] {
  return Object.freeze(BUILTIN_PRESETS.map(freezePreset));
}

export function toProviderPresetBinding(
  preset: ProviderPreset,
  credentials: RuntimeProviderCredentialAuthority,
): AIProviderBinding {
  return {
    id: preset.id,
    endpoint: preset.endpoint,
    defaultApi: preset.api,
    allowUnknownModels: true,
    ...(preset.allowedModels === undefined ? {} : { allowedModels: preset.allowedModels }),
    credentials: createRuntimeProviderCredentialResolver(credentials, preset.id),
    ...(preset.compatibility === undefined ? {} : { compatibility: preset.compatibility }),
    ...(preset.headers === undefined ? {} : { headers: preset.headers }),
    ...(preset.queryParams === undefined ? {} : { queryParams: preset.queryParams }),
    ...(preset.fetch === undefined ? {} : { transport: { fetch: preset.fetch } }),
  };
}

function applyLegacyOverride(
  preset: ProviderPreset,
  legacy: DaemonModelProviderConfig | undefined,
): ProviderPreset {
  if (legacy === undefined) return preset;
  return {
    ...preset,
    endpoint: legacy.baseUrl,
    ...(legacy.allowedModels === undefined ? {} : { allowedModels: legacy.allowedModels }),
    ...(legacy.headers === undefined ? {} : { headers: legacy.headers }),
    ...(legacy.queryParams === undefined ? {} : { queryParams: legacy.queryParams }),
    ...(legacy.fetch === undefined ? {} : { fetch: legacy.fetch }),
  };
}

function createLegacyPreset(provider: DaemonModelProviderConfig): ProviderPreset {
  return {
    id: provider.provider,
    displayName: provider.provider,
    endpoint: provider.baseUrl,
    api: OPENAI_COMPATIBLE_API_ID,
    credentialReference: "CAELUSH_PROVIDER_API_KEY",
    discovery: {
      dialect: "OPENAI_MODELS",
      path: discoveryPath(provider.baseUrl),
      credentialTransport: "BEARER",
    },
    ...(provider.allowedModels === undefined ? {} : { allowedModels: provider.allowedModels }),
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
    ...(provider.queryParams === undefined ? {} : { queryParams: provider.queryParams }),
    ...(provider.fetch === undefined ? {} : { fetch: provider.fetch }),
  };
}

function discoveryPath(endpoint: string): string {
  try {
    const path = new URL(endpoint).pathname.replace(/\/+$/u, "");
    return path.endsWith("/v1") ? "models" : "v1/models";
  } catch {
    return "models";
  }
}

function freezePreset(preset: ProviderPreset): ProviderPreset {
  return Object.freeze({
    ...preset,
    discovery: Object.freeze({ ...preset.discovery }),
    ...(preset.headers === undefined ? {} : { headers: Object.freeze({ ...preset.headers }) }),
    ...(preset.queryParams === undefined
      ? {}
      : { queryParams: Object.freeze({ ...preset.queryParams }) }),
    ...(preset.allowedModels === undefined
      ? {}
      : { allowedModels: Object.freeze([...preset.allowedModels]) }),
  });
}
