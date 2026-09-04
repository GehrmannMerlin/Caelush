import {
  LLMMessageSchema,
  LLMUserMessageSchema,
  type LLMMessage,
  type LLMUserMessage,
} from "@caelush/llm/messages";
import type { ContextBuildReport } from "./context-build-report.js";
import { assembleContextBudget } from "./context-budget.js";
import { validateAndGroupConversation } from "./conversation-history.js";
import { ContextBuildError, ContextConversationError } from "./errors.js";
import { renderSystemContext, type VerificationRepairContextInput } from "./context-renderer.js";
import type { RelevantFileContextPlan } from "./relevant-file-plan.js";
import type { ProjectIntelligenceSnapshot } from "./snapshot.js";
import { Utf8HeuristicTokenEstimator, type TokenEstimator } from "./token-estimator.js";
import { redactText } from "@caelush/security/redaction";
import type { ProjectPackage, ProjectProfile } from "./project-profile.js";
import { createContextPolicy, type ContextPolicy } from "./context-policy.js";
import type { ModelContextProfile } from "./model-context-profile.js";
import { createContextBuildTrace } from "./context-build-trace.js";
import type { ContextItem } from "./context-item.js";
import type { StructuredCheckpoint } from "./checkpoint.js";

export interface ContextBuildLimits {
  readonly maxInputTokens: number;
  readonly safetyMarginTokens?: number;
  readonly maxConversationTokens?: number;
  readonly maxRelevantFileTokens?: number;
  readonly minRelevantFileTokens?: number;
}

export interface ContextBuildCommonInput {
  readonly baseSystemPrompt: string;
  readonly snapshot: ProjectIntelligenceSnapshot;
  readonly relevantFiles?: RelevantFileContextPlan;
  readonly history?: readonly LLMMessage[];
  /** Durable agent_messages.sequence values aligned with history when available. */
  readonly historySourceSequences?: readonly number[];
  readonly limits: ContextBuildLimits;
  readonly verificationRepairContext?: VerificationRepairContextInput;
  readonly modelContextProfile?: ModelContextProfile;
  readonly contextPolicy?: ContextPolicy;
  readonly checkpoint?: StructuredCheckpoint;
  readonly memoryItems?: readonly ContextItem[];
}

export interface UserTurnContextBuildInput extends ContextBuildCommonInput {
  readonly mode?: "USER_TURN";
  readonly currentUserMessage: LLMUserMessage;
}

export interface ToolContinuationContextBuildInput extends ContextBuildCommonInput {
  readonly mode: "TOOL_CONTINUATION";
  readonly currentTurnMessages: readonly LLMMessage[];
}

export type ContextBuildInput = UserTurnContextBuildInput | ToolContinuationContextBuildInput;

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
    const policy =
      input.contextPolicy ??
      (input.modelContextProfile === undefined
        ? undefined
        : createContextPolicy(input.modelContextProfile));
    const limits = validateContextBuildLimits(
      policy === undefined
        ? input.limits
        : {
            ...input.limits,
            maxInputTokens: policy.effectiveInputLimit,
            // The policy has already subtracted output and safety reserves from the
            // raw provider window. The legacy builder field must not subtract safety
            // a second time on this path.
            safetyMarginTokens: 0,
            maxConversationTokens: policy.conversationCapTokens,
            maxRelevantFileTokens: policy.relevantFileCapTokens,
          },
    );
    const isContinuation = input.mode === "TOOL_CONTINUATION";
    const currentTurn = isContinuation ? input.currentTurnMessages : [input.currentUserMessage];
    if (currentTurn.length === 0) throw new ContextBuildError("current turn must not be empty");
    if (!isContinuation && !LLMUserMessageSchema.safeParse(input.currentUserMessage).success) {
      throw new ContextBuildError("current user message is invalid");
    }
    if (isContinuation) {
      if (currentTurn.some((message) => message.role === "system")) {
        throw new ContextConversationError("current continuation cannot contain system messages");
      }
      const currentConversation = validateAndGroupConversation(currentTurn, this.tokenEstimator);
      if (currentConversation.groups.length !== 1) {
        throw new ContextConversationError("current continuation must contain one turn group");
      }
      if (currentTurn.at(-1)?.role !== "tool") {
        throw new ContextConversationError("current continuation must end with a tool result");
      }
    }
    const history = input.history ?? [];
    const conversation = validateAndGroupConversation(history, this.tokenEstimator);
    const snapshot = redactProjectDerivedSnapshot(input.snapshot);
    const relevantFiles =
      input.relevantFiles === undefined ? undefined : redactRelevantFiles(input.relevantFiles);
    const system = renderSystemContext(
      input.baseSystemPrompt,
      snapshot,
      input.verificationRepairContext,
      {
        ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
        ...(input.memoryItems === undefined ? {} : { memoryItems: input.memoryItems }),
      },
    );
    const budget = assembleContextBudget({
      system: system.message,
      ...(isContinuation ? {} : { current: input.currentUserMessage }),
      currentTurn,
      currentTurnType: isContinuation ? "TOOL_CONTINUATION" : "USER_TURN",
      groups: conversation.groups,
      files: relevantFiles?.sections ?? [],
      limits,
      estimator: this.tokenEstimator,
    });
    for (const message of budget.messages) {
      if (!LLMMessageSchema.safeParse(message).success) {
        throw new ContextBuildError("context builder produced an invalid message");
      }
    }
    const effectiveInputLimit = policy?.effectiveInputLimit ?? limits.maxInputTokens;
    const trace = createContextBuildTrace({
      contextWindow: policy?.contextWindowTokens ?? limits.maxInputTokens,
      effectiveInputLimit,
      estimatedInputTokens: budget.estimatedInputTokens,
      systemTokens: budget.systemTokens,
      goalTokens: budget.currentUserTokens,
      checkpointTokens:
        input.checkpoint === undefined
          ? 0
          : this.tokenEstimator.estimateText(JSON.stringify(input.checkpoint)),
      recentTailTokens: budget.currentTurnTokens,
      projectTokens: budget.systemTokens,
      fileTokens: budget.relevantFiles.estimatedTokensUsed,
      observationTokens: currentTurn
        .filter((message) => message.role === "tool")
        .reduce((total, message) => total + this.tokenEstimator.estimateText(message.content), 0),
      memoryTokens: (input.memoryItems ?? []).reduce(
        (total, item) => total + (item.content === undefined ? 0 : item.tokenEstimate),
        0,
      ),
      droppedItems: budget.conversation.droppedMessages + budget.relevantFiles.droppedFiles,
      truncatedItems: budget.relevantFiles.furtherTruncatedFiles,
      pressureRatio: budget.estimatedInputTokens / effectiveInputLimit,
      compactionCount: 0,
      loadedFileCount: budget.relevantFiles.selectedFiles,
      observationCount: currentTurn.filter((message) => message.role === "tool").length,
    });
    const report: ContextBuildReport = {
      limits,
      estimatedInputTokens: budget.estimatedInputTokens,
      remainingTokens: budget.remainingTokens,
      systemTokens: budget.systemTokens,
      currentUserTokens: budget.currentUserTokens,
      currentTurn: {
        type: isContinuation ? "TOOL_CONTINUATION" : "USER_TURN",
        messageCount: currentTurn.length,
        estimatedTokens: budget.currentTurnTokens,
      },
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
      trace,
    };
    return { messages: budget.messages, report };
  }
}

function redactRelevantFiles(plan: RelevantFileContextPlan): RelevantFileContextPlan {
  return {
    ...plan,
    sections: plan.sections.map((section) => ({
      ...section,
      content: redactText(section.content),
    })),
  };
}

function redactProjectPackage(packageInfo: ProjectPackage): ProjectPackage {
  return {
    ...packageInfo,
    ...(packageInfo.name === undefined ? {} : { name: redactText(packageInfo.name) }),
    ...(packageInfo.packageManager === undefined
      ? {}
      : { packageManager: redactText(packageInfo.packageManager) }),
    ...(packageInfo.nodeVersionRange === undefined
      ? {}
      : { nodeVersionRange: redactText(packageInfo.nodeVersionRange) }),
    scripts: packageInfo.scripts.map((script) => ({
      ...script,
      command: redactText(script.command),
    })),
  };
}

function redactProjectProfile(profile: ProjectProfile): ProjectProfile {
  return {
    ...profile,
    ...(profile.rootPackage === undefined
      ? {}
      : { rootPackage: redactProjectPackage(profile.rootPackage) }),
    ...(profile.activePackage === undefined
      ? {}
      : { activePackage: redactProjectPackage(profile.activePackage) }),
  };
}

function redactProjectDerivedSnapshot(
  snapshot: ProjectIntelligenceSnapshot,
): ProjectIntelligenceSnapshot {
  return {
    ...snapshot,
    profile: redactProjectProfile(snapshot.profile),
    instructions: {
      ...snapshot.instructions,
      entries: snapshot.instructions.entries.map((entry) => ({
        ...entry,
        content: redactText(entry.content),
      })),
    },
  };
}

export function createDefaultContextBuilder(): ContextBuilder {
  return new ContextBuilder({ tokenEstimator: new Utf8HeuristicTokenEstimator() });
}
