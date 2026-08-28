import {
  LLMMessageSchema,
  LLMUserMessageSchema,
  type LLMMessage,
  type LLMUserMessage,
} from "@caelush/llm/messages";
import type { ContextBuildReport } from "./context-build-report.js";
import {
  ContextBuildError,
  ContextBudgetExceededError,
  type ContextBudgetBreakdown,
} from "./errors.js";
import type { RelevantFileContextPlan } from "./relevant-file-plan.js";
import type { ProjectIntelligenceSnapshot } from "./snapshot.js";
import { Utf8HeuristicTokenEstimator, type TokenEstimator } from "./token-estimator.js";

export interface ContextBuildLimits {
  readonly maxInputTokens: number;
  readonly safetyMarginTokens?: number;
  readonly maxConversationTokens?: number;
  readonly maxRelevantFileTokens?: number;
  readonly minRelevantFileTokens?: number;
}

export interface ContextBuildInput {
  readonly baseSystemPrompt: string;
  readonly snapshot: ProjectIntelligenceSnapshot;
  readonly relevantFiles?: RelevantFileContextPlan;
  readonly history?: readonly LLMMessage[];
  readonly currentUserMessage: LLMUserMessage;
  readonly limits: ContextBuildLimits;
}

export interface BuiltModelContext {
  readonly messages: readonly LLMMessage[];
  readonly report: ContextBuildReport;
}

export interface ContextBuilderOptions {
  readonly tokenEstimator?: TokenEstimator;
}

const DEFAULT_SAFETY_MARGIN = 512;
const DEFAULT_MAX_CONVERSATION = 12000;
const DEFAULT_MAX_RELEVANT_FILES = 12000;
const DEFAULT_MIN_RELEVANT_FILE = 128;

function invalidLimit(message: string): ContextBuildError {
  return new ContextBuildError(message);
}

function requireSafeInteger(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw invalidLimit(
      `${name} must be a ${minimum === 0 ? "non-negative" : "positive"} safe integer`,
    );
  }
}

export function validateContextBuildLimits(input: ContextBuildLimits): Required<ContextBuildLimits> {
  requireSafeInteger("maxInputTokens", input.maxInputTokens, 1);
  const safetyMarginTokens = input.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN;
  const maxConversationTokens = input.maxConversationTokens ?? DEFAULT_MAX_CONVERSATION;
  const maxRelevantFileTokens = input.maxRelevantFileTokens ?? DEFAULT_MAX_RELEVANT_FILES;
  const minRelevantFileTokens = input.minRelevantFileTokens ?? DEFAULT_MIN_RELEVANT_FILE;
  requireSafeInteger("safetyMarginTokens", safetyMarginTokens, 0);
  requireSafeInteger("maxConversationTokens", maxConversationTokens, 0);
  requireSafeInteger("maxRelevantFileTokens", maxRelevantFileTokens, 0);
  requireSafeInteger("minRelevantFileTokens", minRelevantFileTokens, 1);
  if (safetyMarginTokens >= input.maxInputTokens) {
    throw invalidLimit("safetyMarginTokens must be less than maxInputTokens");
  }
  return {
    maxInputTokens: input.maxInputTokens,
    safetyMarginTokens,
    maxConversationTokens,
    maxRelevantFileTokens,
    minRelevantFileTokens,
  };
}

function emptyReport(
  limits: Required<ContextBuildLimits>,
  estimator: TokenEstimator,
  currentUser: LLMUserMessage,
  snapshot: ProjectIntelligenceSnapshot,
): ContextBuildReport {
  const currentUserTokens = estimator.estimateText(JSON.stringify(currentUser));
  return {
    limits,
    estimatedInputTokens: currentUserTokens,
    remainingTokens: limits.maxInputTokens - limits.safetyMarginTokens - currentUserTokens,
    systemTokens: 0,
    currentUserTokens,
    mandatoryTokens: currentUserTokens,
    conversation: {
      providedMessages: 0,
      selectedMessages: 0,
      droppedMessages: 0,
      providedTurns: 0,
      selectedTurns: 0,
      droppedTurns: 0,
      estimatedTokensUsed: 0,
      requiresCompaction: false,
      latestTurnTooLarge: false,
    },
    relevantFiles: {
      providedFiles: 0,
      selectedFiles: 0,
      droppedFiles: 0,
      estimatedTokensUsed: 0,
      furtherTruncatedFiles: 0,
    },
    system: {
      instructionCount: snapshot.instructions.entries.length,
      instructionBytes: snapshot.instructions.totalBytes,
      snapshotDiagnosticCount: snapshot.diagnostics.length,
      projectRoot: snapshot.projectRoot.projectRoot,
      ...(snapshot.profile.activePackage?.relativePath === undefined
        ? {}
        : { activePackage: snapshot.profile.activePackage.relativePath }),
    },
  };
}

export class ContextBuilder {
  private readonly tokenEstimator: TokenEstimator;

  constructor(options: ContextBuilderOptions = {}) {
    this.tokenEstimator = options.tokenEstimator ?? new Utf8HeuristicTokenEstimator();
  }

  build(input: ContextBuildInput): BuiltModelContext {
    const limits = validateContextBuildLimits(input.limits);
    if (!LLMUserMessageSchema.safeParse(input.currentUserMessage).success) {
      throw new ContextBuildError("current user message is invalid");
    }
    if (input.history !== undefined) {
      for (const message of input.history) {
        if (!LLMMessageSchema.safeParse(message).success) {
          throw new ContextBuildError("conversation history contains an invalid message");
        }
      }
    }
    const report = emptyReport(limits, this.tokenEstimator, input.currentUserMessage, input.snapshot);
    const breakdown: ContextBudgetBreakdown = {
      maxInputTokens: limits.maxInputTokens,
      safetyMarginTokens: limits.safetyMarginTokens,
      systemTokens: report.systemTokens,
      currentUserTokens: report.currentUserTokens,
      mandatoryTokens: report.mandatoryTokens,
    };
    if (report.mandatoryTokens + limits.safetyMarginTokens > limits.maxInputTokens) {
      throw new ContextBudgetExceededError(breakdown);
    }
    return { messages: [input.currentUserMessage], report };
  }
}

export function createDefaultContextBuilder(): ContextBuilder {
  return new ContextBuilder({ tokenEstimator: new Utf8HeuristicTokenEstimator() });
}
