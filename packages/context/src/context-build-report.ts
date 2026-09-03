import type { ContextBudgetBreakdown } from "./errors.js";
import type { ContextBuildTrace } from "./context-build-trace.js";

export interface ContextBuildLimitsReport {
  readonly maxInputTokens: number;
  readonly safetyMarginTokens: number;
  readonly maxConversationTokens: number;
  readonly maxRelevantFileTokens: number;
  readonly minRelevantFileTokens: number;
}

export interface ContextConversationReport {
  readonly providedMessages: number;
  readonly selectedMessages: number;
  readonly droppedMessages: number;
  readonly providedTurns: number;
  readonly selectedTurns: number;
  readonly droppedTurns: number;
  readonly estimatedTokensUsed: number;
  readonly requiresCompaction: boolean;
  readonly latestTurnTooLarge: boolean;
}

export interface ContextRelevantFilesReport {
  readonly providedFiles: number;
  readonly selectedFiles: number;
  readonly droppedFiles: number;
  readonly estimatedTokensUsed: number;
  readonly furtherTruncatedFiles: number;
}

export interface ContextSystemReport {
  readonly instructionCount: number;
  readonly instructionBytes: number;
  readonly snapshotDiagnosticCount: number;
  readonly projectRoot: string;
  readonly activePackage?: string;
}

export interface ContextCurrentTurnReport {
  readonly type: "USER_TURN" | "TOOL_CONTINUATION";
  readonly messageCount: number;
  readonly estimatedTokens: number;
}

export interface ContextBuildReport {
  readonly limits: ContextBuildLimitsReport;
  readonly estimatedInputTokens: number;
  readonly remainingTokens: number;
  readonly systemTokens: number;
  readonly currentUserTokens: number;
  readonly currentTurn: ContextCurrentTurnReport;
  readonly mandatoryTokens: number;
  readonly snapshotDiagnosticCount: number;
  readonly conversation: ContextConversationReport;
  readonly relevantFiles: ContextRelevantFilesReport;
  readonly system: ContextSystemReport;
  readonly mandatoryBreakdown?: ContextBudgetBreakdown;
  readonly trace?: ContextBuildTrace;
}
