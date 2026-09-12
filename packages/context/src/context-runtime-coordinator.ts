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
  projectModelContextProfile,
  resolveModelContextProfile,
  type ModelDescriptorProjectionInput,
  type ModelContextProfile,
} from "./model-context-profile.js";
import { buildExecutionUnits, isCompactionCandidate } from "./execution-unit.js";
import {
  ContextPressureController,
  ContextPressureStateMachine,
  type ContextPressureState,
} from "./compaction.js";
import { ContextRehydrator, type ContextAuthoritySnapshot } from "./context-rehydrator.js";
import { estimateLLMMessage } from "./conversation-history.js";
import { projectToolObservationBatch } from "./observation-projector.js";
import { Utf8HeuristicTokenEstimator } from "./token-estimator.js";

export interface ContextRuntimePrepareInput {
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  /**
   * The model's technical metadata authority.
   *
   * When present, Context derives its intrinsic model limits from this descriptor
   * instead of resolving them independently, so the context runtime and the model
   * gateway can never disagree about a context window or an output ceiling. The
   * descriptor comes from the same immutable catalog generation the gateway uses.
   */
  readonly model?: ModelDescriptorProjectionInput;
  readonly projectId?: string;
  readonly context: ContextBuildInput;
  readonly signal: AbortSignal;
  readonly forceRecovery?: boolean;
  readonly authorities?: ContextAuthoritySnapshot;
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
  /** Loads complete durable Tool output by opaque artifact reference for recovery projection. */
  readonly rawObservationLoader?: (input: {
    readonly runId: string;
    readonly artifactRef: string;
  }) => Promise<string | undefined>;
}

export class ContextRuntimeCoordinator implements ContextRuntimeCoordinatorPort {
  private readonly builder: Pick<ContextBuilder, "build">;
  private readonly usageByRun = new Map<string, ContextUsageProjection>();
  private readonly policyByRun = new Map<string, ContextPolicy>();
  private readonly pressureByRun = new Map<string, ContextPressureStateMachine>();

  constructor(private readonly options: ContextRuntimeCoordinatorOptions = {}) {
    this.builder = options.builder ?? createDefaultContextBuilder();
  }

  getContextUsage(runId: string): ContextUsageProjection | undefined {
    return this.usageByRun.get(runId);
  }

  /**
   * Build the compatibility profile from the caller's model descriptor.
   *
   * The descriptor supplies every intrinsic model field. The two policy fields come
   * from configuration: the explicit policy option when set, otherwise the
   * configured/fallback profile's own reserve, which is Context policy metadata and
   * never a model descriptor field.
   */
  #compatibilityProfile(input: ContextRuntimePrepareInput): ModelContextProfile | undefined {
    const descriptor = input.model;
    if (descriptor === undefined) return undefined;

    const policySource =
      this.options.policyOptions?.outputReserveTokens ??
      this.options.configuredProfiles?.find(
        (profile) =>
          profile.providerId === descriptor.ref.provider &&
          profile.modelId === descriptor.ref.model,
      )?.recommendedOutputReserveTokens ??
      this.options.overrides?.find(
        (profile) =>
          profile.providerId === descriptor.ref.provider &&
          profile.modelId === descriptor.ref.model,
      )?.recommendedOutputReserveTokens ??
      this.options.fallbackProfile?.recommendedOutputReserveTokens ??
      2_048;

    const toolOutputSoftLimitTokens = this.options.configuredProfiles
      ?.find(
        (profile) =>
          profile.providerId === descriptor.ref.provider &&
          profile.modelId === descriptor.ref.model,
      )
      ?.toolOutputSoftLimitTokens?.valueOf();

    return projectModelContextProfile({
      descriptor,
      recommendedOutputReserveTokens: policySource,
      ...(toolOutputSoftLimitTokens === undefined ? {} : { toolOutputSoftLimitTokens }),
    });
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
    // The descriptor, when the caller supplies one, owns every intrinsic model
    // field. `resolveModelContextProfile` remains available for compatibility
    // callers and for tests, but it is no longer consulted on the migrated path.
    const configuredProfile =
      input.model === undefined ? undefined : this.#compatibilityProfile(input);
    const profile =
      configuredProfile ??
      resolveModelContextProfile({
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
    const pressureState =
      this.pressureByRun.get(input.runId) ?? new ContextPressureStateMachine(policy);
    this.pressureByRun.set(input.runId, pressureState);
    if (input.forceRecovery) pressureState.markRecovering();
    const goal =
      input.authorities?.goal ??
      (input.context.mode === "TOOL_CONTINUATION"
        ? input.context.currentTurnMessages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join(" ") || input.context.baseSystemPrompt
        : input.context.currentUserMessage.content);
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
    let preCompactionTokens: number | undefined;
    let compactedCheckpoint = checkpoint;
    let compactionCount = 0;
    const recoveryStages: string[] = [];
    if (input.forceRecovery) {
      if (hasCompressibleHistory(workingInput)) {
        recoveryStages.push("COMPACT_CLOSED_UNITS");
        const compacted = await this.compact(
          input.runId,
          workingInput,
          profile,
          checkpoint,
          policy,
          this.estimateFullInput(workingInput),
          input.authorities,
        );
        compactedCheckpoint = compacted.checkpoint;
        compactionCount = 1;
        workingInput =
          input.context.mode === "TOOL_CONTINUATION"
            ? await this.tightenOpenTurn(input.runId, compacted.input, policy, "EMERGENCY")
            : compacted.input;
      } else if (input.context.mode === "TOOL_CONTINUATION") {
        recoveryStages.push("REPROJECT_OPEN_OBSERVATIONS_EMERGENCY");
        workingInput = await this.tightenOpenTurn(input.runId, workingInput, policy, "EMERGENCY");
      } else {
        await this.recordFailedUsage(input, profile, policy, workingInput, ["OVERFLOW_EXHAUSTED"]);
        pressureState.markExhausted();
        throw new ContextExhaustedError();
      }
    }
    try {
      context = this.builder.build(workingInput);
      preCompactionTokens = context.report.estimatedInputTokens;
      const initialMeasuredTokens = measuredContextTokens(context);
      if (initialMeasuredTokens !== undefined) pressureState.observe(initialMeasuredTokens);
      if (
        context.report.trace !== undefined &&
        (context.report.trace.pressureRatio >= policy.proactiveCompactionRatio ||
          context.report.conversation.requiresCompaction) &&
        hasCompressibleHistory(workingInput)
      ) {
        recoveryStages.push("PROACTIVE_COMPACTION");
        const compacted = await this.compact(
          input.runId,
          workingInput,
          profile,
          checkpoint,
          policy,
          context.report.estimatedInputTokens,
          input.authorities,
        );
        compactionCount = 1;
        workingInput = compacted.input;
        context = this.builder.build(compacted.input);
        const compactedMeasuredTokens = measuredContextTokens(context);
        if (compactedMeasuredTokens !== undefined)
          pressureState.markRecovered(compactedMeasuredTokens);
        compactedCheckpoint = await this.updateCheckpointTokensAfter(compacted.checkpoint, context);
      }
    } catch (error) {
      if (!(error instanceof ContextBudgetExceededError)) throw error;
      recoveryStages.push("REPROJECT_OPEN_OBSERVATIONS_TIGHT");
      workingInput = await this.tightenOpenTurn(input.runId, buildInput, policy, "TIGHT");
      try {
        context = this.builder.build(workingInput);
        const tightMeasuredTokens = measuredContextTokens(context);
        if (tightMeasuredTokens !== undefined) pressureState.observe(tightMeasuredTokens);
      } catch (tightError) {
        if (
          !(tightError instanceof ContextBudgetExceededError) ||
          !hasCompressibleHistory(buildInput)
        ) {
          await this.recordFailedUsage(input, profile, policy, workingInput, recoveryStages);
          pressureState.markExhausted();
          throw new ContextExhaustedError();
        }
        const compacted = await this.compact(
          input.runId,
          workingInput,
          profile,
          checkpoint,
          policy,
          preCompactionTokens ?? this.estimateFullInput(buildInput),
          input.authorities,
        );
        recoveryStages.push("COMPACT_CLOSED_UNITS");
        compactionCount = 1;
        workingInput = compacted.input;
        try {
          context = this.builder.build(workingInput);
          const recoveredMeasuredTokens = measuredContextTokens(context);
          if (recoveredMeasuredTokens !== undefined)
            pressureState.markRecovered(recoveredMeasuredTokens);
        } catch {
          recoveryStages.push("REPROJECT_OPEN_OBSERVATIONS_EMERGENCY");
          workingInput = await this.tightenOpenTurn(input.runId, workingInput, policy, "EMERGENCY");
          try {
            context = this.builder.build(workingInput);
            const emergencyMeasuredTokens = measuredContextTokens(context);
            if (emergencyMeasuredTokens !== undefined)
              pressureState.markRecovered(emergencyMeasuredTokens);
          } catch {
            recoveryStages.push("REPROJECT_OPEN_OBSERVATIONS_MINIMAL");
            workingInput = await this.tightenOpenTurn(input.runId, workingInput, policy, "MINIMAL");
            try {
              context = this.builder.build(workingInput);
              const minimalMeasuredTokens = measuredContextTokens(context);
              if (minimalMeasuredTokens !== undefined)
                pressureState.markRecovered(minimalMeasuredTokens);
            } catch {
              await this.recordFailedUsage(input, profile, policy, workingInput, recoveryStages);
              pressureState.markExhausted();
              throw new ContextExhaustedError();
            }
          }
        }
        compactedCheckpoint = await this.updateCheckpointTokensAfter(compacted.checkpoint, context);
      }
    }
    if (input.signal.aborted) throw new ContextRuntimeCancelledError();
    if (compactionCount > 0) {
      if (compactedCheckpoint !== undefined) {
        compactedCheckpoint = await this.updateCheckpointTokensAfter(compactedCheckpoint, context);
      }
      context = {
        ...context,
        report: withCompactionMetadata(context.report, compactionCount, compactedCheckpoint),
      };
    }
    await this.recordUsage(input, profile, policy, context.report, compactionCount, recoveryStages);
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
    recoveryStages: readonly string[] = [],
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
      rawContextWindowTokens: profile.contextWindowTokens,
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
        systemTokens: trace.systemTokens,
        goalTokens: trace.goalTokens,
        currentUserTokens: report.currentUserTokens ?? trace.goalTokens,
        relevantFileTokens: trace.fileTokens,
        currentTurnTokens: report.currentTurn?.estimatedTokens ?? trace.recentTailTokens,
        mandatoryTokens: report.mandatoryTokens ?? trace.systemTokens + trace.goalTokens,
      },
      updatedAt: now,
      lastBuildAt: now,
      lastRecoveryStages: recoveryStages,
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
    preCompactionTokens?: number,
    authorities: ContextAuthoritySnapshot = {},
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
      ...(input.historySourceSequences === undefined
        ? {}
        : { sourceSequences: input.historySourceSequences }),
    });
    const eligible = units.filter((unit) => isCompactionCandidate(unit));
    const tokensBefore =
      preCompactionTokens ??
      history.reduce((total, message) => total + estimateLLMMessage(message, estimator), 0);
    const maxCompactionTokens = Math.max(0, tokensBefore - policy.targetRecentTailTokens);
    const oldestCandidates = [];
    let selectedTokens = 0;
    for (const unit of eligible) {
      if (selectedTokens + unit.tokenEstimate > maxCompactionTokens) break;
      oldestCandidates.push(unit);
      selectedTokens += unit.tokenEstimate;
    }
    if (oldestCandidates.length === 0 && eligible.length > 0) oldestCandidates.push(eligible[0]!);
    const pressure = new ContextPressureController({ policy });
    const selectedSourceRange = {
      from: oldestCandidates[0]!.sourceSequenceFrom,
      to: oldestCandidates.at(-1)!.sourceSequenceTo,
      kind:
        input.historySourceSequences === undefined
          ? ("LOCAL_HISTORY_INDEX" as const)
          : ("DURABLE_MESSAGE_SEQUENCE" as const),
    };
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
      changedFiles: authorities.changedFiles ?? [],
      recentErrors: authorities.recentErrors ?? [],
      verificationState: authorities.verificationState ?? "UNKNOWN",
      sourceRange: selectedSourceRange,
    });
    const selectedUnits = pressureResult.selectedUnits;
    if (selectedUnits.length === 0) throw new ContextExhaustedError();
    const selectedRanges = selectedUnits.map(
      (unit) =>
        [
          unit.historyIndexFrom ?? unit.sourceSequenceFrom,
          unit.historyIndexTo ?? unit.sourceSequenceTo,
        ] as const,
    );
    const retainedHistory = history.filter(
      (_message, index) => !selectedRanges.some(([from, to]) => index >= from && index <= to),
    );
    const goal =
      authorities.goal ??
      (input.mode === "TOOL_CONTINUATION"
        ? input.currentTurnMessages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join(" ")
        : input.currentUserMessage.content);
    const sourceRange = {
      from: selectedUnits[0]!.sourceSequenceFrom,
      to: selectedUnits.at(-1)!.sourceSequenceTo,
      kind:
        input.historySourceSequences === undefined
          ? ("LOCAL_HISTORY_INDEX" as const)
          : ("DURABLE_MESSAGE_SEQUENCE" as const),
    };
    const structuredCheckpoint: StructuredCheckpoint = createStructuredCheckpoint({
      goal,
      constraints: [],
      completedWork: selectedUnits.map((unit) => `completed execution unit ${unit.id}`),
      inProgress: input.mode === "TOOL_CONTINUATION" ? ["open tool turn remains active"] : [],
      blocked: [],
      importantDiscoveries: [],
      keyDecisions: [],
      changedFiles: authorities.changedFiles ?? [],
      readFiles: [],
      recentErrors: authorities.recentErrors ?? [],
      verificationState: authorities.verificationState ?? "UNKNOWN",
      activeProcesses: authorities.activeProcesses ?? [],
      pendingApprovals: authorities.pendingApprovals ?? [],
      resourceGovernance: authorities.resourceGovernance ?? "UNKNOWN",
      criticalReferences: [],
      nextIntent: "continue from the retained recent execution tail",
      sourceRange,
    });
    const sourceSequenceFrom = selectedUnits[0]!.sourceSequenceFrom;
    const sourceSequenceTo = selectedUnits.at(-1)!.sourceSequenceTo;
    const compactedInput: ContextBuildInput = {
      ...input,
      history: retainedHistory,
      checkpoint: structuredCheckpoint,
    };
    let provisionalInput = compactedInput;
    let provisionalContext: BuiltModelContext;
    try {
      provisionalContext = this.builder.build(provisionalInput);
    } catch {
      provisionalInput = await this.tightenOpenTurn(runId, compactedInput, policy, "EMERGENCY");
      provisionalContext = this.builder.build(provisionalInput);
    }
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
      tokensAfter: provisionalContext.report.estimatedInputTokens,
      structuredCheckpoint,
      modelRef: { providerId: profile.providerId, modelId: profile.modelId },
      createdAt: this.options.clock?.now() ?? Date.now(),
    });
    const rehydrated = await new ContextRehydrator().rehydrate({
      checkpoint: checkpoint.structuredCheckpoint,
      authorities: {
        ...authorities,
        goal,
        verificationState: authorities.verificationState ?? "UNKNOWN",
      },
    });
    const rehydratedCheckpoint = rehydrated.checkpoint ?? checkpoint.structuredCheckpoint;
    return {
      checkpoint,
      input: {
        ...provisionalInput,
        checkpoint: rehydratedCheckpoint,
      },
    };
  }

  getContextPressureState(runId: string): ContextPressureState | undefined {
    return this.pressureByRun.get(runId)?.state;
  }

  private async tightenOpenTurn(
    runId: string,
    input: ContextBuildInput,
    policy: ContextPolicy,
    level: "TIGHT" | "EMERGENCY" | "MINIMAL",
  ): Promise<ContextBuildInput> {
    if (input.mode !== "TOOL_CONTINUATION") return input;
    const multiplier = level === "TIGHT" ? 0.5 : level === "EMERGENCY" ? 0.25 : 0.08;
    const rawContents = await Promise.all(
      input.currentTurnMessages
        .filter((message) => message.role === "tool")
        .map(async (message) => {
          if (message.rawArtifactRef !== undefined) {
            if (this.options.rawObservationLoader === undefined) {
              throw new ContextExhaustedError();
            }
            const raw = await this.options.rawObservationLoader({
              runId,
              artifactRef: message.rawArtifactRef,
            });
            if (raw === undefined) throw new ContextExhaustedError();
            return raw;
          }
          return message.content;
        }),
    );
    let rawIndex = 0;
    const projected = projectToolObservationBatch({
      observations: input.currentTurnMessages
        .filter((message) => message.role === "tool")
        .map((message) => ({
          sourceToolInvocationId: message.toolCallId,
          toolName: message.toolName,
          content: rawContents[rawIndex++] ?? message.content,
          ...(message.rawArtifactRef === undefined
            ? {}
            : { rawArtifactRef: message.rawArtifactRef }),
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

  private estimateFullInput(input: ContextBuildInput): number {
    try {
      const {
        modelContextProfile: _profile,
        contextPolicy: _policy,
        ...inputWithoutPolicy
      } = input;
      void _profile;
      void _policy;
      const measured = this.builder.build({
        ...inputWithoutPolicy,
        limits: {
          ...input.limits,
          maxInputTokens: Number.MAX_SAFE_INTEGER,
          safetyMarginTokens: 0,
          maxConversationTokens: Number.MAX_SAFE_INTEGER,
          maxRelevantFileTokens: Number.MAX_SAFE_INTEGER,
          minRelevantFileTokens: 1,
        },
      });
      return measured.report.estimatedInputTokens;
    } catch {
      const estimator = new Utf8HeuristicTokenEstimator();
      const currentTurn =
        input.mode === "TOOL_CONTINUATION" ? input.currentTurnMessages : [input.currentUserMessage];
      return (
        estimator.estimateText(input.baseSystemPrompt) +
        (input.history ?? []).reduce(
          (total, message) => total + estimateLLMMessage(message, estimator),
          0,
        ) +
        currentTurn.reduce((total, message) => total + estimateLLMMessage(message, estimator), 0)
      );
    }
  }

  private async recordFailedUsage(
    input: ContextRuntimePrepareInput,
    profile: ModelContextProfile,
    policy: ContextPolicy,
    attempted: ContextBuildInput,
    recoveryStages: readonly string[] = [],
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
      rawContextWindowTokens: profile.contextWindowTokens,
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
        systemTokens: estimator.estimateText(attempted.baseSystemPrompt),
        goalTokens:
          attempted.mode === "USER_TURN"
            ? estimator.estimateText(attempted.currentUserMessage.content)
            : 0,
        currentUserTokens:
          attempted.mode === "USER_TURN"
            ? estimateLLMMessage(attempted.currentUserMessage, estimator)
            : 0,
        relevantFileTokens: 0,
        currentTurnTokens: currentTurn.reduce(
          (total, message) => total + estimateLLMMessage(message, estimator),
          0,
        ),
        mandatoryTokens:
          estimator.estimateText(attempted.baseSystemPrompt) +
          currentTurn.reduce((total, message) => total + estimateLLMMessage(message, estimator), 0),
      },
      updatedAt: now,
      lastBuildAt: now,
      lastRecoveryStages: recoveryStages,
      lastBuildStatus: "CONTEXT_EXHAUSTED",
    });
    this.usageByRun.set(input.runId, usage);
    await this.options.usageRepository?.upsert(usage);
  }
}

function hasCompressibleHistory(input: ContextBuildInput): boolean {
  if (input.history === undefined || input.history.length === 0) return false;
  const estimator = new Utf8HeuristicTokenEstimator();
  return buildExecutionUnits(input.history, {
    runId: "context-runtime",
    createdAt: 0,
    estimateText: estimator.estimateText.bind(estimator),
  }).some(isCompactionCandidate);
}

function measuredContextTokens(context: BuiltModelContext): number | undefined {
  return context.report.trace?.estimatedInputTokens ?? context.report.estimatedInputTokens;
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
