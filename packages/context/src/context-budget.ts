import { type LLMMessage, type LLMSystemMessage, type LLMUserMessage } from "@caelush/llm/messages";
import type { ContextBuildLimits } from "./context-builder.js";
import type {
  ContextConversationReport,
  ContextRelevantFilesReport,
} from "./context-build-report.js";
import { renderRelevantFileContext } from "./context-renderer.js";
import { ContextBudgetExceededError, type ContextBudgetBreakdown } from "./errors.js";
import {
  estimateLLMMessage,
  selectRecentConversation,
  type ConversationTurnGroup,
} from "./conversation-history.js";
import type { RelevantFileContextSection } from "./relevant-file-plan.js";
import type { TokenEstimator } from "./token-estimator.js";

export interface ContextBudgetInput {
  readonly system: LLMSystemMessage;
  readonly current: LLMUserMessage;
  readonly groups: readonly ConversationTurnGroup[];
  readonly files: readonly RelevantFileContextSection[];
  readonly limits: Required<ContextBuildLimits>;
  readonly estimator: TokenEstimator;
}

export interface ContextBudgetResult {
  readonly messages: readonly LLMMessage[];
  readonly estimatedInputTokens: number;
  readonly remainingTokens: number;
  readonly safetyMarginTokens: number;
  readonly mandatoryTokens: number;
  readonly systemTokens: number;
  readonly currentUserTokens: number;
  readonly conversationTarget: number;
  readonly fileTarget: number;
  readonly conversation: ContextConversationReport;
  readonly relevantFiles: ContextRelevantFilesReport;
}

interface FileSelection {
  readonly sections: readonly RelevantFileContextSection[];
  readonly message: LLMUserMessage | undefined;
  readonly estimatedTokensUsed: number;
  readonly furtherTruncatedFiles: number;
}

function estimateMessages(messages: readonly LLMMessage[], estimator: TokenEstimator): number {
  return messages.reduce((total, message) => total + estimateLLMMessage(message, estimator), 0);
}

function fitTextToMessageBudget(
  sections: readonly RelevantFileContextSection[],
  section: RelevantFileContextSection,
  target: number,
  estimator: TokenEstimator,
  minTokens: number,
): RelevantFileContextSection | undefined {
  const characters = [...section.content];
  let low = 0;
  let high = characters.length;
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const prefix = characters.slice(0, middle).join("");
    const candidate: RelevantFileContextSection = {
      ...section,
      content: prefix,
      estimatedTokens: estimator.estimateText(prefix),
      bytesIncluded: Buffer.byteLength(prefix, "utf8"),
      truncated: true,
    };
    const message = renderRelevantFileContext([...sections, candidate]);
    if (message !== undefined && estimateLLMMessage(message, estimator) <= target) {
      best = prefix;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best === undefined || estimator.estimateText(best) < minTokens) return undefined;
  const lineEnd = best.lastIndexOf("\n");
  const lineSafe = lineEnd >= 0 ? best.slice(0, lineEnd + 1) : best;
  if (lineSafe.length === 0 || estimator.estimateText(lineSafe) < minTokens) return undefined;
  return {
    ...section,
    content: lineSafe,
    estimatedTokens: estimator.estimateText(lineSafe),
    bytesIncluded: Buffer.byteLength(lineSafe, "utf8"),
    truncated: true,
  };
}

function selectFiles(
  files: readonly RelevantFileContextSection[],
  target: number,
  estimator: TokenEstimator,
  minTokens: number,
): FileSelection {
  const sections: RelevantFileContextSection[] = [];
  let furtherTruncatedFiles = 0;
  for (const section of files) {
    const whole = renderRelevantFileContext([...sections, section]);
    if (whole !== undefined && estimateLLMMessage(whole, estimator) <= target) {
      sections.push(section);
      continue;
    }
    const fitted = fitTextToMessageBudget(sections, section, target, estimator, minTokens);
    if (fitted === undefined) break;
    sections.push(fitted);
    furtherTruncatedFiles += 1;
    break;
  }
  const message = renderRelevantFileContext(sections);
  return {
    sections,
    message,
    estimatedTokensUsed: message === undefined ? 0 : estimateLLMMessage(message, estimator),
    furtherTruncatedFiles,
  };
}

function conversationReport(
  provided: readonly ConversationTurnGroup[],
  selected: readonly ConversationTurnGroup[],
  latestTurnTooLarge: boolean,
): ContextConversationReport {
  const selectedMessages = selected.flatMap((group) => group.messages);
  const selectedTokens = selected.reduce((total, group) => total + group.estimatedTokens, 0);
  const selectedStart = provided.length - selected.length;
  const droppedMessages = provided
    .slice(0, selectedStart)
    .reduce((total, group) => total + group.messages.length, 0);
  return {
    providedMessages: provided.reduce((total, group) => total + group.messages.length, 0),
    selectedMessages: selectedMessages.length,
    droppedMessages,
    providedTurns: provided.length,
    selectedTurns: selected.length,
    droppedTurns: selectedStart,
    estimatedTokensUsed: selected.length === 0 ? 0 : selectedTokens,
    requiresCompaction: selectedStart > 0,
    latestTurnTooLarge,
  };
}

function relevantFilesReport(
  provided: readonly RelevantFileContextSection[],
  selected: FileSelection,
  estimator: TokenEstimator,
): ContextRelevantFilesReport {
  return {
    providedFiles: provided.length,
    selectedFiles: selected.sections.length,
    droppedFiles: provided.length - selected.sections.length,
    estimatedTokensUsed:
      selected.message === undefined ? 0 : estimateLLMMessage(selected.message, estimator),
    furtherTruncatedFiles: selected.furtherTruncatedFiles,
  };
}

export function assembleContextBudget(input: ContextBudgetInput): ContextBudgetResult {
  const systemTokens = estimateLLMMessage(input.system, input.estimator);
  const currentUserTokens = estimateLLMMessage(input.current, input.estimator);
  const mandatoryTokens = systemTokens + currentUserTokens;
  const breakdown: ContextBudgetBreakdown = {
    maxInputTokens: input.limits.maxInputTokens,
    safetyMarginTokens: input.limits.safetyMarginTokens,
    systemTokens,
    currentUserTokens,
    mandatoryTokens,
  };
  if (mandatoryTokens + input.limits.safetyMarginTokens > input.limits.maxInputTokens) {
    throw new ContextBudgetExceededError(breakdown);
  }

  const optionalBudget =
    input.limits.maxInputTokens - input.limits.safetyMarginTokens - mandatoryTokens;
  const conversationTarget = Math.min(
    Math.floor((optionalBudget * 2) / 5),
    input.limits.maxConversationTokens,
  );
  const fileTarget = Math.min(
    optionalBudget - Math.floor((optionalBudget * 2) / 5),
    input.limits.maxRelevantFileTokens,
  );
  const firstConversation = selectRecentConversation(input.groups, conversationTarget);
  const firstFiles = selectFiles(
    input.files,
    fileTarget,
    input.estimator,
    input.limits.minRelevantFileTokens,
  );
  const conversationUnused = Math.max(
    0,
    conversationTarget - firstConversation.estimatedTokensUsed,
  );
  const fileUnused = Math.max(0, fileTarget - firstFiles.estimatedTokensUsed);
  const secondConversationTarget = Math.min(
    input.limits.maxConversationTokens,
    conversationTarget + fileUnused,
  );
  const secondFileTarget = Math.min(
    input.limits.maxRelevantFileTokens,
    fileTarget + conversationUnused,
  );
  const secondConversation = selectRecentConversation(input.groups, secondConversationTarget);
  let selectedGroups = input.groups.slice(input.groups.length - secondConversation.selectedTurns);
  let selectedFiles = selectFiles(
    input.files,
    secondFileTarget,
    input.estimator,
    input.limits.minRelevantFileTokens,
  );

  const compose = (): readonly LLMMessage[] => [
    input.system,
    ...selectedGroups.flatMap((group) => group.messages),
    ...(selectedFiles.message === undefined ? [] : [selectedFiles.message]),
    input.current,
  ];
  let messages = compose();
  while (
    estimateMessages(messages, input.estimator) + input.limits.safetyMarginTokens >
    input.limits.maxInputTokens
  ) {
    if (selectedFiles.sections.length > 0) {
      const removed = selectedFiles.sections.at(-1);
      const original = input.files.find(
        (section) => section.provenance.relativePath === removed?.provenance.relativePath,
      );
      const removedByFurtherTruncation =
        removed !== undefined && original !== undefined && original.content !== removed.content;
      selectedFiles = {
        ...selectedFiles,
        sections: selectedFiles.sections.slice(0, -1),
        message: renderRelevantFileContext(selectedFiles.sections.slice(0, -1)),
        estimatedTokensUsed: 0,
        furtherTruncatedFiles:
          selectedFiles.furtherTruncatedFiles - (removedByFurtherTruncation ? 1 : 0),
      };
      selectedFiles = {
        ...selectedFiles,
        estimatedTokensUsed:
          selectedFiles.message === undefined
            ? 0
            : estimateLLMMessage(selectedFiles.message, input.estimator),
      };
    } else if (selectedGroups.length > 0) {
      selectedGroups = selectedGroups.slice(1);
    } else {
      throw new ContextBudgetExceededError(breakdown);
    }
    messages = compose();
  }
  const estimatedInputTokens = estimateMessages(messages, input.estimator);
  return {
    messages,
    estimatedInputTokens,
    remainingTokens:
      input.limits.maxInputTokens - input.limits.safetyMarginTokens - estimatedInputTokens,
    safetyMarginTokens: input.limits.safetyMarginTokens,
    mandatoryTokens,
    systemTokens,
    currentUserTokens,
    conversationTarget,
    fileTarget,
    conversation: conversationReport(
      input.groups,
      selectedGroups,
      secondConversation.latestTurnTooLarge,
    ),
    relevantFiles: relevantFilesReport(input.files, selectedFiles, input.estimator),
  };
}
