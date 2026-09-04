import type { BuiltModelContext, ContextBuildInput } from "./context-builder.js";
import { ContextBuilder, createDefaultContextBuilder } from "./context-builder.js";
import { createContextPolicy, type ContextPolicy } from "./context-policy.js";
import type {
  ContextCheckpointRecord,
  ContextCheckpointRepository,
} from "./context-persistence.js";
import type { ContextItem } from "./context-item.js";
import { ContextBudgetExceededError } from "./errors.js";
import type { ContextBuildReport } from "./context-build-report.js";
import {
  createContextUsageProjection,
  type ContextUsageProjection,
} from "./context-usage-projection.js";
import { createDeterministicMinimalCheckpoint, type StructuredCheckpoint } from "./checkpoint.js";
import {
  createModelContextProfile,
  resolveModelContextProfile,
  type ModelContextProfile,
} from "./model-context-profile.js";

export interface ContextRuntimePrepareInput {
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly projectId?: string;
  readonly context: ContextBuildInput;
  readonly signal: AbortSignal;
}

export interface ContextRuntimePrepareResult extends BuiltModelContext {
  readonly profile: ModelContextProfile;
  readonly policy: ContextPolicy;
  readonly checkpoint?: ContextCheckpointRecord;
  readonly memoryItems: readonly ContextItem[];
}

export interface ContextRuntimeCoordinatorPort {
  prepareModelContext(
    input: ContextRuntimePrepareInput,
  ): Promise<BuiltModelContext> | BuiltModelContext;
}

type ContextCheckpointRuntimeRepository = Pick<ContextCheckpointRepository, "getLatestByRun"> &
  Partial<Pick<ContextCheckpointRepository, "create">>;

export interface ContextRuntimeCoordinatorOptions {
  readonly builder?: Pick<ContextBuilder, "build">;
  readonly configuredProfiles?: readonly ModelContextProfile[];
  readonly knownProfiles?: readonly ModelContextProfile[];
  readonly overrides?: readonly ModelContextProfile[];
  readonly fallbackProfile?: {
    readonly contextWindowTokens: number;
    readonly maxOutputTokens: number;
    readonly recommendedOutputReserveTokens: number;
    readonly supportsPromptCaching?: boolean;
    readonly supportsUsageReporting?: boolean;
    readonly toolOutputSoftLimitTokens?: number;
  };
  readonly policyOptions?: Parameters<typeof createContextPolicy>[1];
  readonly checkpointRepository?: ContextCheckpointRuntimeRepository;
  readonly checkpointIdFactory?: { create(): string };
  readonly clock?: { now(): number };
  readonly memoryLoader?: (input: {
    readonly projectId?: string;
    readonly goal: string;
    readonly maxTokens: number;
    readonly signal: AbortSignal;
  }) => Promise<readonly ContextItem[]>;
}

export class ContextRuntimeCoordinator implements ContextRuntimeCoordinatorPort {
  private readonly builder: Pick<ContextBuilder, "build">;
  private readonly usageByRun = new Map<string, ContextUsageProjection>();

  constructor(private readonly options: ContextRuntimeCoordinatorOptions = {}) {
    this.builder = options.builder ?? createDefaultContextBuilder();
  }

  getContextUsage(runId: string): ContextUsageProjection | undefined {
    return this.usageByRun.get(runId);
  }

  async prepareModelContext(
    input: ContextRuntimePrepareInput,
  ): Promise<ContextRuntimePrepareResult> {
    if (input.signal.aborted) throw new ContextRuntimeCancelledError();
    const checkpoint =
      this.options.checkpointRepository === undefined
        ? undefined
        : await this.options.checkpointRepository.getLatestByRun(input.runId);
    if (input.signal.aborted) throw new ContextRuntimeCancelledError();
    const profile = resolveModelContextProfile({
      providerId: input.providerId,
      modelId: input.modelId,
      ...(input.context.modelContextProfile === undefined
        ? this.options.configuredProfiles === undefined
          ? {}
          : { configuredProfiles: this.options.configuredProfiles }
        : { configuredProfiles: [input.context.modelContextProfile] }),
      ...(this.options.knownProfiles === undefined
        ? {}
        : { knownProfiles: this.options.knownProfiles }),
      ...(this.options.overrides === undefined ? {} : { overrides: this.options.overrides }),
      ...(this.options.fallbackProfile === undefined
        ? {}
        : { fallback: this.options.fallbackProfile }),
    });
    const policy = createContextPolicy(profile, this.options.policyOptions);
    const goal =
      input.context.mode === "TOOL_CONTINUATION"
        ? input.context.currentTurnMessages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join(" ") || input.context.baseSystemPrompt
        : input.context.currentUserMessage.content;
    const memoryItems =
      this.options.memoryLoader === undefined
        ? []
        : await this.options.memoryLoader({
            ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
            goal,
            maxTokens: policy.maxMemoryContextTokens,
            signal: input.signal,
          });
    if (input.signal.aborted) throw new ContextRuntimeCancelledError();
    const buildInput: ContextBuildInput = {
      ...input.context,
      modelContextProfile: profile,
      contextPolicy: policy,
      ...(checkpoint === undefined ? {} : { checkpoint: checkpoint.structuredCheckpoint }),
      ...(memoryItems.length === 0 ? {} : { memoryItems }),
    };
    let context: BuiltModelContext;
    let compactedCheckpoint = checkpoint;
    let compactionCount = 0;
    try {
      context = this.builder.build(buildInput);
      if (
        context.report.trace !== undefined &&
        context.report.trace.pressureRatio >= policy.emergencyCompactionRatio &&
        hasCompressibleHistory(buildInput)
      ) {
        const compacted = await this.compact(input.runId, buildInput, profile, checkpoint);
        compactedCheckpoint = compacted.checkpoint;
        compactionCount = 1;
        context = this.builder.build(compacted.input);
      }
    } catch (error) {
      if (!(error instanceof ContextBudgetExceededError) || !hasCompressibleHistory(buildInput)) {
        throw error;
      }
      const compacted = await this.compact(input.runId, buildInput, profile, checkpoint);
      compactedCheckpoint = compacted.checkpoint;
      compactionCount = 1;
      context = this.builder.build(compacted.input);
    }
    if (input.signal.aborted) throw new ContextRuntimeCancelledError();
    if (compactionCount > 0) {
      context = {
        ...context,
        report: withCompactionMetadata(context.report, compactionCount, compactedCheckpoint),
      };
    }
    this.recordUsage(input, profile, policy, context.report, compactionCount);
    return {
      ...context,
      profile,
      policy,
      ...(compactedCheckpoint === undefined ? {} : { checkpoint: compactedCheckpoint }),
      memoryItems,
    };
  }

  private recordUsage(
    input: ContextRuntimePrepareInput,
    profile: ModelContextProfile,
    policy: ContextPolicy,
    report: ContextBuildReport,
    compactionCount: number,
  ): void {
    const trace = report.trace;
    if (trace === undefined) return;
    const previous = this.usageByRun.get(input.runId);
    const now = this.options.clock?.now() ?? Date.now();
    this.usageByRun.set(
      input.runId,
      createContextUsageProjection({
        runId: input.runId,
        providerId: profile.providerId,
        modelId: profile.modelId,
        contextWindowTokens: trace.contextWindow,
        effectiveInputLimitTokens: policy.effectiveInputLimit,
        estimatedInputTokens: trace.estimatedInputTokens,
        pressureState:
          trace.estimatedInputTokens >= policy.emergencyCompactionTokens
            ? "EMERGENCY"
            : trace.estimatedInputTokens >= policy.proactiveCompactionTokens
              ? "PROACTIVE"
              : "NORMAL",
        compactionCount: (previous?.compactionCount ?? 0) + compactionCount,
        ...(compactionCount === 0 && previous?.lastCompactionAt !== undefined
          ? { lastCompactionAt: previous.lastCompactionAt }
          : compactionCount === 0
            ? {}
            : { lastCompactionAt: now }),
        breakdown: {
          pinned: 0,
          checkpoint: trace.checkpointTokens,
          recentTail: trace.recentTailTokens,
          project: trace.projectTokens,
          files: trace.fileTokens,
          toolObservations: trace.observationTokens,
          memory: trace.memoryTokens,
        },
        updatedAt: now,
      }),
    );
  }

  private async compact(
    runId: string,
    input: ContextBuildInput,
    profile: ModelContextProfile,
    previousCheckpoint: ContextCheckpointRecord | undefined,
  ): Promise<{ readonly input: ContextBuildInput; readonly checkpoint: ContextCheckpointRecord }> {
    if (
      this.options.checkpointRepository === undefined ||
      this.options.checkpointRepository.create === undefined
    ) {
      throw new ContextBudgetExceededError({
        maxInputTokens: input.limits.maxInputTokens,
        safetyMarginTokens: input.limits.safetyMarginTokens ?? 0,
        systemTokens: 0,
        currentUserTokens: 0,
        mandatoryTokens: 0,
      });
    }
    const history = input.history ?? [];
    const goal =
      input.mode === "TOOL_CONTINUATION"
        ? input.currentTurnMessages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join(" ")
        : input.currentUserMessage.content;
    const structuredCheckpoint: StructuredCheckpoint = createDeterministicMinimalCheckpoint({
      goal,
      changedFiles: [],
      recentErrors: [],
      verificationState: "PENDING",
      sourceRange: { from: 0, to: history.length },
    });
    const checkpoint = await this.options.checkpointRepository.create({
      checkpointId:
        this.options.checkpointIdFactory?.create() ?? `checkpoint:${runId}:${history.length}`,
      runId,
      ...(previousCheckpoint === undefined
        ? {}
        : { previousCheckpointId: previousCheckpoint.checkpointId }),
      sourceSequenceFrom: structuredCheckpoint.sourceRange.from,
      sourceSequenceTo: structuredCheckpoint.sourceRange.to,
      tokensBefore: input.history?.length ?? 0,
      tokensAfter: 0,
      structuredCheckpoint,
      modelRef: { providerId: profile.providerId, modelId: profile.modelId },
      createdAt: this.options.clock?.now() ?? Date.now(),
    });
    return {
      checkpoint,
      input: {
        ...input,
        history: [],
        checkpoint: checkpoint.structuredCheckpoint,
      },
    };
  }
}

function hasCompressibleHistory(input: ContextBuildInput): boolean {
  return (input.history?.length ?? 0) > 0;
}

function withCompactionMetadata(
  report: ContextBuildReport,
  compactionCount: number,
  checkpoint: ContextCheckpointRecord | undefined,
): ContextBuildReport {
  if (report.trace === undefined) return report;
  return {
    ...report,
    trace: {
      ...report.trace,
      compactionCount: report.trace.compactionCount + compactionCount,
      ...(checkpoint === undefined ? {} : { checkpointId: checkpoint.checkpointId }),
    },
  };
}

export class ContextRuntimeCancelledError extends Error {
  constructor() {
    super("Context runtime preparation was cancelled.");
    this.name = "ContextRuntimeCancelledError";
  }
}

export function createContextRuntimeBuilderAdapter(
  builder: Pick<ContextBuilder, "build">,
): ContextRuntimeCoordinatorPort {
  return {
    prepareModelContext(input) {
      if (input.signal.aborted) throw new ContextRuntimeCancelledError();
      const context = builder.build(input.context);
      if (input.signal.aborted) throw new ContextRuntimeCancelledError();
      const profile = createModelContextProfile({
        providerId: input.providerId,
        modelId: input.modelId,
        contextWindowTokens: input.context.limits.maxInputTokens + 1,
        maxOutputTokens: 1,
        recommendedOutputReserveTokens: 1,
        supportsPromptCaching: false,
        supportsUsageReporting: false,
        profileSource: "OVERRIDE",
      });
      const policyOptions = {
        outputReserveTokens: 1,
        safetyReserveTokens: 0,
        ...(input.context.limits.maxConversationTokens === undefined
          ? {}
          : { maxConversationTokens: input.context.limits.maxConversationTokens }),
        ...(input.context.limits.maxRelevantFileTokens === undefined
          ? {}
          : { maxRelevantFileTokens: input.context.limits.maxRelevantFileTokens }),
      };
      return {
        ...context,
        profile,
        policy: createContextPolicy(profile, policyOptions),
        memoryItems: [],
      };
    },
  };
}
