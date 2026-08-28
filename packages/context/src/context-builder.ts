import {
  LLMMessageSchema,
  LLMUserMessageSchema,
  type LLMMessage,
  type LLMUserMessage,
} from "@caelush/llm/messages";
import type { ContextBuildReport } from "./context-build-report.js";
import { assembleContextBudget } from "./context-budget.js";
import { validateAndGroupConversation } from "./conversation-history.js";
import { ContextBuildError } from "./errors.js";
import { renderSystemContext } from "./context-renderer.js";
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

export function validateContextBuildLimits(
  input: ContextBuildLimits,
): Required<ContextBuildLimits> {
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
    const history = input.history ?? [];
    const conversation = validateAndGroupConversation(history, this.tokenEstimator);
    const system = renderSystemContext(input.baseSystemPrompt, input.snapshot);
    const budget = assembleContextBudget({
      system: system.message,
      current: input.currentUserMessage,
      groups: conversation.groups,
      files: input.relevantFiles?.sections ?? [],
      limits,
      estimator: this.tokenEstimator,
    });
    for (const message of budget.messages) {
      if (!LLMMessageSchema.safeParse(message).success) {
        throw new ContextBuildError("context builder produced an invalid message");
      }
    }
    const report: ContextBuildReport = {
      limits,
      estimatedInputTokens: budget.estimatedInputTokens,
      remainingTokens: budget.remainingTokens,
      systemTokens: budget.systemTokens,
      currentUserTokens: budget.currentUserTokens,
      mandatoryTokens: budget.mandatoryTokens,
      snapshotDiagnosticCount: input.snapshot.diagnostics.length,
      conversation: budget.conversation,
      relevantFiles: budget.relevantFiles,
      system: {
        instructionCount: system.instructionCount,
        instructionBytes: system.instructionBytes,
        snapshotDiagnosticCount: input.snapshot.diagnostics.length,
        projectRoot: input.snapshot.projectRoot.projectRoot,
        ...(input.snapshot.profile.activePackage?.relativePath === undefined
          ? {}
          : { activePackage: input.snapshot.profile.activePackage.relativePath }),
      },
    };
    return { messages: budget.messages, report };
  }
}

export function createDefaultContextBuilder(): ContextBuilder {
  return new ContextBuilder({ tokenEstimator: new Utf8HeuristicTokenEstimator() });
}
