import type { BuiltModelContext, ContextBuildInput } from "./context-builder.js";
import { ContextBuilder, createDefaultContextBuilder } from "./context-builder.js";
import { createContextPolicy, type ContextPolicy } from "./context-policy.js";
import type {
  ContextCheckpointRecord,
  ContextCheckpointRepository,
} from "./context-persistence.js";
import type { ContextItem } from "./context-item.js";
import { ContextBudgetExceededError } from "./errors.js";
import { ContextExhaustedError } from "./context-overflow.js";
import type { ContextBuildReport } from "./context-build-report.js";
import {
  createContextUsageProjection,
  type ContextUsageProjection,
} from "./context-usage-projection.js";
import { createStructuredCheckpoint, type StructuredCheckpoint } from "./checkpoint.js";
import {
  createModelContextProfile,
  resolveModelContextProfile,
  type ModelContextProfile,
} from "./model-context-profile.js";
import { buildExecutionUnits, isCompactionCandidate } from "./execution-unit.js";
import { ContextPressureController } from "./compaction.js";
import { ContextRehydrator } from "./context-rehydrator.js";
import { estimateLLMMessage } from "./conversation-history.js";
import { projectToolObservationBatch } from "./observation-projector.js";
import { Utf8HeuristicTokenEstimator } from "./token-estimator.js";

export interface ContextRuntimePrepareInput {
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly projectId?: string;
  readonly context: ContextBuildInput;
  readonly signal: AbortSignal;
  readonly forceRecovery?: boolean;
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
  getContextPolicy?(
    runId: string,
  ): Pick<ContextPolicy, "maxSingleObservationTokens" | "maxObservationBatchTokens"> | undefined;
}

type ContextCheckpointRuntimeRepository = Pick<ContextCheckpointRepository, "getLatestByRun"> &
  Partial<Pick<ContextCheckpointRepository, "create">> & {
    updateTokensAfter?(checkpointId: string, tokensAfter: number): Promise<void>;
  };

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
  readonly usageRepository?: {
    upsert(state: ContextUsageProjection): Promise<void>;
  };
}

export class ContextRuntimeCoordinator implements ContextRuntimeCoordinatorPort {
  private readonly builder: Pick<ContextBuilder, "build">;
  private readonly usageByRun = new Map<string, ContextUsageProjection>();
  private readonly policyByRun = new Map<string, ContextPolicy>();

  constructor(private readonly options: ContextRuntimeCoordinatorOptions = {}) {
    this.builder = options.builder ?? createDefaultContextBuilder();
  }

  getContextUsage(runId: string): ContextUsageProjection | undefined {
    return this.usageByRun.get(runId);
  }

  getContextPolicy(
    runId: string,
  ): Pick<ContextPolicy, "maxSingleObservationTokens" | "maxObservationBatchTokens"> | undefined {
    const policy = this.policyByRun.get(runId);
    if (policy === undefined) return undefined;
    return {
      maxSingleObservationTokens: policy.maxSingleObservationTokens,
      maxObservationBatchTokens: policy.maxObservationBatchTokens,
    };
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
      legacyLimits: {
        maxInputTokens: input.context.limits.maxInputTokens,
      },
      ...(this.options.fallbackProfile === undefined
        ? {}
        : { fallback: this.options.fallbackProfile }),
    });
    const policy = createContextPolicy(profile, this.options.policyOptions);
    this.policyByRun.set(input.runId, policy);
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
    let workingInput = buildInput;
    let context: BuiltModelContext;
    let compactedCheckpoint = checkpoint;
    let compactionCount = 0;
    if (input.forceRecovery && hasCompressibleHistory(workingInput)) {
      const compacted = await this.compact(input.runId, workingInput, profile, checkpoint, policy);
      compactedCheckpoint = compacted.checkpoint;
      compactionCount = 1;
      workingInput = this.tightenOpenTurn(compacted.input, policy, "EMERGENCY");
    }
    try {
      context = this.builder.build(workingInput);
      if (
        context.report.trace !== undefined &&
        (context.report.trace.pressureRatio >= policy.proactiveCompactionRatio ||
          context.report.conversation.requiresCompaction) &&
        hasCompressibleHistory(workingInput)
      ) {
        const compacted = await this.compact(
          input.runId,
          workingInput,
          profile,
          checkpoint,
          policy,
        );
        compactionCount = 1;
        workingInput = compacted.input;
        context = this.builder.build(compacted.input);
        compactedCheckpoint = await this.updateCheckpointTokensAfter(compacted.checkpoint, context);
      }
    } catch (error) {
      if (!(error instanceof ContextBudgetExceededError)) throw error;
      workingInput = this.tightenOpenTurn(buildInput, policy, "TIGHT");
      try {
        context = this.builder.build(workingInput);
      } catch (tightError) {
        if (
          !(tightError instanceof ContextBudgetExceededError) ||
          !hasCompressibleHistory(buildInput)
        ) {
          await this.recordFailedUsage(input, profile, policy, workingInput);
          throw new ContextExhaustedError();
        }
        const compacted = await this.compact(
          input.runId,
          workingInput,
          profile,
          checkpoint,
          policy,
        );
        compactionCount = 1;
        workingInput = compacted.input;
        try {
          context = this.builder.build(workingInput);
        } catch {
          workingInput = this.tightenOpenTurn(workingInput, policy, "EMERGENCY");
          try {
            context = this.builder.build(workingInput);
          } catch {
            workingInput = this.tightenOpenTurn(workingInput, policy, "MINIMAL");
            try {
              context = this.builder.build(workingInput);
            } catch {
              await this.recordFailedUsage(input, profile, policy, workingInput);
              throw new ContextExhaustedError();
            }
          }
        }
        compactedCheckpoint = await this.updateCheckpointTokensAfter(compacted.checkpoint, context);
      }
    }
    if (input.signal.aborted) throw new ContextRuntimeCancelledError();
    if (compactionCount > 0) {
      if (compactedCheckpoint !== undefined && compactedCheckpoint.tokensAfter === 0) {
        compactedCheckpoint = await this.updateCheckpointTokensAfter(compactedCheckpoint, context);
      }
      context = {
        ...context,
        report: withCompactionMetadata(context.report, compactionCount, compactedCheckpoint),
      };
    }
    await this.recordUsage(input, profile, policy, context.report, compactionCount);
    return {
      ...context,
      profile,
      policy,
      ...(compactedCheckpoint === undefined ? {} : { checkpoint: compactedCheckpoint }),
      memoryItems,
    };
  }

  private async recordUsage(
    input: ContextRuntimePrepareInput,
    profile: ModelContextProfile,
    policy: ContextPolicy,
    report: ContextBuildReport,
    compactionCount: number,
  ): Promise<void> {
    const trace = report.trace;
    if (trace === undefined) return;
    const previous = this.usageByRun.get(input.runId);
    const now = this.options.clock?.now() ?? Date.now();
    const usage = createContextUsageProjection({
      runId: input.runId,
      providerId: profile.providerId,
      modelId: profile.modelId,
      profileSource: profile.profileSource,
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
    });
    this.usageByRun.set(input.runId, usage);
    await this.options.usageRepository?.upsert(usage);
  }

  private async compact(
    runId: string,
    input: ContextBuildInput,
    profile: ModelContextProfile,
    previousCheckpoint: ContextCheckpointRecord | undefined,
    policy: ContextPolicy,
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
    const estimator = new Utf8HeuristicTokenEstimator();
    const units = buildExecutionUnits(history, {
      runId,
      createdAt: this.options.clock?.now() ?? Date.now(),
      estimateText: estimator.estimateText.bind(estimator),
    });
    const eligible = units.filter((unit) => isCompactionCandidate(unit));
    const tokensBefore = history.reduce(
      (total, message) => total + estimateLLMMessage(message, estimator),
      0,
    );
    const maxCompactionTokens = Math.max(0, tokensBefore - policy.targetRecentTailTokens);
    const oldestCandidates = [];
    let selectedTokens = 0;
    for (const unit of eligible) {
      if (selectedTokens + unit.tokenEstimate > maxCompactionTokens) break;
      oldestCandidates.push(unit);
      selectedTokens += unit.tokenEstimate;
    }
    if (oldestCandidates.length === 0 && eligible.length > 1) oldestCandidates.push(eligible[0]!);
    const pressure = new ContextPressureController({ policy });
    const pressureResult = await pressure.compact({
      runId,
      estimatedInputTokens: tokensBefore,
      units: oldestCandidates,
      goal:
        input.mode === "TOOL_CONTINUATION"
          ? input.currentTurnMessages
              .filter((message) => message.role === "user")
              .map((message) => message.content)
              .join(" ")
          : input.currentUserMessage.content,
      changedFiles: [],
      recentErrors: [],
      verificationState: "PENDING",
      sourceRange: { from: 0, to: Math.max(0, history.length - 1) },
    });
    const selectedUnits = pressureResult.selectedUnits;
    const legacyHistoryCut =
      selectedUnits.length === 0 && eligible.length === 0 && history.length > 0;
    if (selectedUnits.length === 0 && !legacyHistoryCut) throw new ContextExhaustedError();
    const selectedRanges = legacyHistoryCut
      ? ([[0, history.length - 1]] as const)
      : selectedUnits.map((unit) => [unit.sourceSequenceFrom, unit.sourceSequenceTo] as const);
    const retainedHistory = history.filter(
      (_message, index) => !selectedRanges.some(([from, to]) => index >= from && index <= to),
    );
    const goal =
      input.mode === "TOOL_CONTINUATION"
        ? input.currentTurnMessages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join(" ")
        : input.currentUserMessage.content;
    const sourceRange = legacyHistoryCut
      ? { from: 0, to: history.length }
      : {
          from: selectedUnits[0]!.sourceSequenceFrom,
          to: selectedUnits.at(-1)!.sourceSequenceTo,
        };
    const structuredCheckpoint: StructuredCheckpoint = createStructuredCheckpoint({
      goal,
      constraints: [],
      completedWork: selectedUnits.map((unit) => `completed execution unit ${unit.id}`),
      inProgress: input.mode === "TOOL_CONTINUATION" ? ["open tool turn remains active"] : [],
      blocked: [],
      importantDiscoveries: [],
      keyDecisions: [],
      changedFiles: [],
      readFiles: [],
      recentErrors: [],
      verificationState: "PENDING",
      activeProcesses: [],
      pendingApprovals: [],
      resourceGovernance: "UNCHANGED",
      criticalReferences: [],
      nextIntent: "continue from the retained recent execution tail",
      sourceRange,
    });
    const sourceSequenceFrom = legacyHistoryCut ? 0 : selectedUnits[0]!.sourceSequenceFrom;
    const sourceSequenceTo = legacyHistoryCut
      ? history.length
      : selectedUnits.at(-1)!.sourceSequenceTo;
    const checkpoint = await this.options.checkpointRepository.create({
      checkpointId:
        this.options.checkpointIdFactory?.create() ?? `checkpoint:${runId}:${history.length}`,
      runId,
      ...(previousCheckpoint === undefined
        ? {}
        : { previousCheckpointId: previousCheckpoint.checkpointId }),
      sourceSequenceFrom,
      sourceSequenceTo,
      tokensBefore,
      tokensAfter: 0,
      structuredCheckpoint,
      modelRef: { providerId: profile.providerId, modelId: profile.modelId },
      createdAt: this.options.clock?.now() ?? Date.now(),
    });
    const rehydrated = await new ContextRehydrator().rehydrate({
      checkpoint: checkpoint.structuredCheckpoint,
      authorities: { goal, verificationState: "PENDING" },
    });
    const rehydratedCheckpoint = rehydrated.checkpoint ?? checkpoint.structuredCheckpoint;
    return {
      checkpoint,
      input: {
        ...input,
        history: retainedHistory,
        checkpoint: rehydratedCheckpoint,
      },
    };
  }

  private tightenOpenTurn(
    input: ContextBuildInput,
    policy: ContextPolicy,
    level: "TIGHT" | "EMERGENCY" | "MINIMAL",
  ): ContextBuildInput {
    if (input.mode !== "TOOL_CONTINUATION") return input;
    const multiplier = level === "TIGHT" ? 0.5 : level === "EMERGENCY" ? 0.25 : 0.08;
    const projected = projectToolObservationBatch({
      observations: input.currentTurnMessages
        .filter((message) => message.role === "tool")
        .map((message) => ({
          sourceToolInvocationId: message.toolCallId,
          toolName: message.toolName,
          content: message.content,
        })),
      maxSingleObservationTokens: Math.max(
        1,
        Math.floor(policy.maxSingleObservationTokens * multiplier),
      ),
      maxObservationBatchTokens: Math.max(
        1,
        Math.floor(policy.maxObservationBatchTokens * multiplier),
      ),
      estimator: new Utf8HeuristicTokenEstimator(),
    });
    let projectedIndex = 0;
    return {
      ...input,
      currentTurnMessages: input.currentTurnMessages.map((message) => {
        if (message.role !== "tool") return message;
        const observation = projected[projectedIndex++];
        return observation === undefined ? message : { ...message, content: observation.summary };
      }),
    };
  }

  private async updateCheckpointTokensAfter(
    checkpoint: ContextCheckpointRecord,
    context: BuiltModelContext,
  ): Promise<ContextCheckpointRecord> {
    const update = this.options.checkpointRepository?.updateTokensAfter;
    const tokensAfter = context.report.estimatedInputTokens;
    if (update !== undefined) await update(checkpoint.checkpointId, tokensAfter);
    return { ...checkpoint, tokensAfter };
  }

  private async recordFailedUsage(
    input: ContextRuntimePrepareInput,
    profile: ModelContextProfile,
    policy: ContextPolicy,
    attempted: ContextBuildInput,
  ): Promise<void> {
    const estimator = new Utf8HeuristicTokenEstimator();
    const currentTurn =
      attempted.mode === "TOOL_CONTINUATION"
        ? attempted.currentTurnMessages
        : [attempted.currentUserMessage];
    const estimatedInputTokens =
      estimator.estimateText(attempted.baseSystemPrompt) +
      currentTurn.reduce((total, message) => total + estimateLLMMessage(message, estimator), 0);
    const previous = this.usageByRun.get(input.runId);
    const now = this.options.clock?.now() ?? Date.now();
    const usage = createContextUsageProjection({
      runId: input.runId,
      providerId: profile.providerId,
      modelId: profile.modelId,
      profileSource: profile.profileSource,
      contextWindowTokens: profile.contextWindowTokens,
      effectiveInputLimitTokens: policy.effectiveInputLimit,
      estimatedInputTokens,
      pressureState: "EMERGENCY",
      compactionCount: previous?.compactionCount ?? 0,
      ...(previous?.lastCompactionAt === undefined
        ? {}
        : { lastCompactionAt: previous.lastCompactionAt }),
      breakdown: {
        pinned: 0,
        checkpoint: 0,
        recentTail: currentTurn.reduce(
          (total, message) => total + estimateLLMMessage(message, estimator),
          0,
        ),
        project: estimator.estimateText(attempted.baseSystemPrompt),
        files: 0,
        toolObservations: currentTurn
          .filter((message) => message.role === "tool")
          .reduce((total, message) => total + estimator.estimateText(message.content), 0),
        memory: 0,
      },
      updatedAt: now,
      lastBuildStatus: "CONTEXT_EXHAUSTED",
    });
    this.usageByRun.set(input.runId, usage);
    await this.options.usageRepository?.upsert(usage);
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
