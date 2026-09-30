import type {
  EnumerableModelDescriptorSourcePort,
  ModelDescriptor,
  ModelDescriptorSourcePort,
  ModelReasoningProfile,
} from "@caelush/ai";
import type { ReasoningLevel } from "@caelush/ai";
import type { ModelView, ReasoningPresentation } from "@caelush/protocol";
import type { ProviderPreset } from "./provider-presets.js";

interface CuratedModelRecord {
  readonly provider: string;
  readonly model: string;
  readonly displayName: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly capabilities: ModelDescriptor["capabilities"];
  readonly reasoning?: ModelReasoningProfile;
  readonly adapterMetadata?: ModelDescriptor["adapterMetadata"];
  readonly reasoningPresentation?: ReasoningPresentation;
}

const openAIReasoning: ModelReasoningProfile = {
  supportedLevels: ["OFF", "LOW", "MEDIUM", "HIGH", "XHIGH"],
  defaultLevel: "MEDIUM",
  supportsSummary: "UNKNOWN",
};

const openAIReasoningGpt51: ModelReasoningProfile = {
  supportedLevels: ["OFF", "LOW", "MEDIUM", "HIGH"],
  defaultLevel: "OFF",
  supportsSummary: "UNKNOWN",
};

const deepSeekReasoning: ModelReasoningProfile = {
  supportedLevels: ["OFF", "LOW", "HIGH"],
  defaultLevel: "HIGH",
  supportsSummary: "UNKNOWN",
};

const deepSeekV4Reasoning: ModelReasoningProfile = {
  supportedLevels: ["OFF", "MINIMAL", "LOW", "MEDIUM", "HIGH", "XHIGH"],
  defaultLevel: "HIGH",
  supportsSummary: "UNKNOWN",
};

const anthropicReasoning: ModelReasoningProfile = {
  supportedLevels: ["OFF", "MINIMAL", "LOW", "MEDIUM", "HIGH", "XHIGH"],
  defaultLevel: "MEDIUM",
  supportsSummary: "SUPPORTED",
};

const records: readonly CuratedModelRecord[] = [
  model(
    "openai",
    "gpt-5.1",
    "GPT-5.1",
    400_000,
    128_000,
    openAIReasoningGpt51,
    {
      "openai-compatible": {
        reasoningEffortByLevel: { LOW: "low", MEDIUM: "medium", HIGH: "high" },
      },
    },
    presentation(openAIReasoningGpt51),
  ),
  model("openai", "gpt-4o", "GPT-4o", 128_000, 16_384),
  model("openai", "gpt-4o-mini", "GPT-4o mini", 128_000, 16_384),
  model(
    "openai",
    "o3-mini",
    "o3-mini",
    200_000,
    100_000,
    openAIReasoning,
    {
      "openai-compatible": {
        reasoningEffortByLevel: { LOW: "low", MEDIUM: "medium", HIGH: "high", XHIGH: "xhigh" },
      },
    },
    presentation(openAIReasoning, { XHIGH: "Max" }),
  ),
  model("deepseek", "deepseek-chat", "DeepSeek Chat", 64_000, 8_192),
  model(
    "deepseek",
    "deepseek-reasoner",
    "DeepSeek Reasoner",
    64_000,
    8_192,
    deepSeekReasoning,
    { "openai-compatible": { reasoningEffortByLevel: { LOW: "low", HIGH: "high" } } },
    presentation(deepSeekReasoning),
  ),
  currentModel("deepseek", "deepseek-flash", "DeepSeek V4.1 Flash", true, deepSeekV4Reasoning),
  currentModel("deepseek", "deepseek-v4-flash", "DeepSeek V4 Flash", true, deepSeekV4Reasoning),
  currentModel("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro", false, deepSeekV4Reasoning),
  model(
    "anthropic",
    "claude-sonnet-4-6",
    "Claude Sonnet 4.6",
    200_000,
    64_000,
    anthropicReasoning,
    anthropicMetadata(),
    presentation(anthropicReasoning, { XHIGH: "Extra High" }),
  ),
  model(
    "anthropic",
    "claude-opus-4-6",
    "Claude Opus 4.6",
    200_000,
    64_000,
    anthropicReasoning,
    anthropicMetadata(),
    presentation(anthropicReasoning, { XHIGH: "Extra High" }),
  ),
  model(
    "anthropic",
    "claude-opus-4-8",
    "Claude Opus 4.8",
    200_000,
    64_000,
    anthropicReasoning,
    anthropicMetadata(),
    presentation(anthropicReasoning, { XHIGH: "Extra High" }),
  ),
  model(
    "anthropic",
    "claude-sonnet-4-5-20250929",
    "Claude Sonnet 4.5",
    200_000,
    64_000,
    anthropicReasoning,
    anthropicMetadata(),
    presentation(anthropicReasoning, { XHIGH: "Extra High" }),
  ),
  model(
    "anthropic",
    "claude-haiku-4-5-20251001",
    "Claude Haiku 4.5",
    200_000,
    64_000,
    anthropicReasoning,
    anthropicMetadata(),
    presentation(anthropicReasoning, { XHIGH: "Extra High" }),
  ),
  model(
    "anthropic",
    "claude-3-7-sonnet-latest",
    "Claude 3.7 Sonnet",
    200_000,
    64_000,
    anthropicReasoning,
    anthropicMetadata(),
    presentation(anthropicReasoning, { XHIGH: "Extra High" }),
  ),
  model(
    "anthropic",
    "claude-sonnet-4-20250514",
    "Claude Sonnet 4",
    200_000,
    64_000,
    anthropicReasoning,
    anthropicMetadata(),
    presentation(anthropicReasoning, { XHIGH: "Extra High" }),
  ),
  model(
    "anthropic",
    "claude-opus-4-20250514",
    "Claude Opus 4",
    200_000,
    64_000,
    anthropicReasoning,
    anthropicMetadata(),
    presentation(anthropicReasoning, { XHIGH: "Extra High" }),
  ),
];

export interface CuratedModelMetadata {
  readonly descriptor: ModelDescriptor;
  readonly reasoningPresentation?: ReasoningPresentation;
}

const byIdentity = new Map(
  records.map((record) => [`${record.provider}\u0000${record.model}`, record]),
);

export function getCuratedModelMetadata(
  provider: string,
  modelId: string,
): CuratedModelMetadata | undefined {
  const record = byIdentity.get(`${provider}\u0000${modelId}`);
  if (record === undefined) return undefined;
  return {
    descriptor: descriptorFromRecord(record),
    ...(record.reasoningPresentation === undefined
      ? {}
      : { reasoningPresentation: record.reasoningPresentation }),
  };
}

/** Create the immutable enumerable exact-model source plus conservative fallback source. */
export function createCuratedModelDescriptorSources(presets: readonly ProviderPreset[]): {
  readonly curated: EnumerableModelDescriptorSourcePort;
  readonly fallback: ModelDescriptorSourcePort;
} {
  const providerIds = new Set(presets.map((preset) => preset.id));
  const descriptors = records
    .filter((record) => providerIds.has(record.provider))
    .map(descriptorFromRecord);
  return {
    curated: {
      id: "builtin-curated-model-metadata",
      priority: 0,
      resolve: (ref) =>
        descriptors.find(
          (descriptor) =>
            descriptor.ref.provider === ref.provider && descriptor.ref.model === ref.model,
        ),
      list: () => descriptors,
    },
    fallback: {
      id: "runtime-provider-safe-fallbacks",
      priority: 250,
      resolve: (ref) => {
        const preset = presets.find((candidate) => candidate.id === ref.provider);
        if (preset === undefined) return undefined;
        return fallbackDescriptor(preset, ref.model);
      },
    },
  };
}

export function projectReasoningPresentation(
  metadata: CuratedModelMetadata | undefined,
): ReasoningPresentation | undefined {
  return metadata?.reasoningPresentation;
}

function model(
  provider: string,
  modelId: string,
  displayName: string,
  contextWindowTokens: number,
  maxOutputTokens: number,
  reasoning?: ModelReasoningProfile,
  adapterMetadata?: ModelDescriptor["adapterMetadata"],
  reasoningPresentation?: ReasoningPresentation,
): CuratedModelRecord {
  return {
    provider,
    model: modelId,
    displayName,
    contextWindowTokens,
    maxOutputTokens,
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "UNKNOWN",
      structuredOutput: "UNKNOWN",
      vision: "UNKNOWN",
      reasoning: reasoning === undefined ? "UNKNOWN" : "SUPPORTED",
      reasoningSummary: reasoning?.supportsSummary ?? "UNKNOWN",
      promptCaching: "UNKNOWN",
      usageReporting: "UNKNOWN",
    },
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(adapterMetadata === undefined ? {} : { adapterMetadata }),
    ...(reasoningPresentation === undefined ? {} : { reasoningPresentation }),
  };
}

function currentModel(
  provider: string,
  modelId: string,
  displayName: string,
  vision: boolean,
  reasoning: ModelReasoningProfile,
): CuratedModelRecord {
  return {
    provider,
    model: modelId,
    displayName,
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 393_216,
    capabilities: {
      streaming: "SUPPORTED",
      // The public model directory does not guarantee tool-call behavior unless
      // the provider explicitly declares it; the fallback remains conservative.
      toolCalling: "UNKNOWN",
      parallelToolCalls: "UNKNOWN",
      structuredOutput: "UNKNOWN",
      vision: vision ? "SUPPORTED" : "UNSUPPORTED",
      reasoning: "SUPPORTED",
      reasoningSummary: "UNKNOWN",
      promptCaching: "UNKNOWN",
      usageReporting: "UNKNOWN",
    },
    reasoning,
    adapterMetadata: {
      "openai-compatible": {
        reasoningEffortByLevel: {
          MINIMAL: "low",
          LOW: "low",
          MEDIUM: "high",
          HIGH: "high",
          XHIGH: "max",
        },
      },
    },
    reasoningPresentation: presentation(reasoning, { XHIGH: "Max" }),
  };
}

function descriptorFromRecord(record: CuratedModelRecord): ModelDescriptor {
  return {
    ref: { provider: record.provider, model: record.model },
    api: record.provider === "anthropic" ? "anthropic-messages" : "openai-compatible-chat",
    displayName: record.displayName,
    limits: {
      contextWindowTokens: record.contextWindowTokens,
      maxOutputTokens: record.maxOutputTokens,
    },
    capabilities: record.capabilities,
    ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning }),
    source: "BUILTIN",
    ...(record.adapterMetadata === undefined ? {} : { adapterMetadata: record.adapterMetadata }),
  };
}

function fallbackDescriptor(preset: ProviderPreset, modelId: string): ModelDescriptor {
  return {
    ref: { provider: preset.id, model: modelId },
    api: preset.api,
    limits: { contextWindowTokens: 16_000, maxOutputTokens: 4_096 },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "UNKNOWN",
      parallelToolCalls: "UNKNOWN",
      structuredOutput: "UNKNOWN",
      vision: "UNKNOWN",
      reasoning: "UNKNOWN",
      reasoningSummary: "UNKNOWN",
      promptCaching: "UNKNOWN",
      usageReporting: "UNKNOWN",
    },
    source: "FALLBACK",
  };
}

function presentation(
  profile: ModelReasoningProfile,
  overrides: Partial<Record<ReasoningLevel, string>> = {},
): ReasoningPresentation {
  return {
    ...(profile.defaultLevel === undefined ? {} : { defaultLevel: profile.defaultLevel }),
    options: profile.supportedLevels.map((level) => ({
      level,
      displayName: overrides[level] ?? titleCase(level),
    })),
  };
}

function anthropicMetadata(): ModelDescriptor["adapterMetadata"] {
  return {
    anthropicMessages: {
      thinking: {
        supported: true,
        defaultEnabled: false,
        disableSupported: true,
        display: "summarized",
        budgetTokensByLevel: {
          MINIMAL: 1_024,
          LOW: 2_048,
          MEDIUM: 8_192,
          HIGH: 16_384,
          XHIGH: 32_768,
        },
        effortByLevel: {
          MINIMAL: "low",
          LOW: "low",
          MEDIUM: "medium",
          HIGH: "high",
          XHIGH: "max",
        },
      },
    },
  };
}

function titleCase(level: ReasoningLevel): string {
  return level === "XHIGH" ? "Extra High" : `${level[0]}${level.slice(1).toLowerCase()}`;
}
