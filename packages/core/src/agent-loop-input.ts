import type { ContextBuildLimits, VerificationRepairContextInput } from "@caelush/context";
import type { LLMMessage, LLMToolResultMessage } from "@caelush/llm/messages";
import type {
  AIModelRequest,
  AIModelTurnResult,
  AIToolChoice,
  AIToolSpec,
  AIUserMessage,
  ModelUsage,
} from "@caelush/ai";
import type { ContextBuildReport } from "@caelush/agent";
import type { AgentLoopAdvanceResult } from "@caelush/agent";
import type {
  AgentError,
  AgentRun,
  AgentState,
  AgentStep,
  StepId,
  TimestampMs,
} from "@caelush/protocol";
import type { AgentToolCallsDecision, AgentLoopOutcome } from "./agent-decision.js";
import type { AgentBudgetBlock } from "./agent-errors.js";
import type { AgentLoopDependencies, AgentProviderTurnState } from "./agent-loop-ports.js";

export interface AgentRetryMetadata {
  readonly code: "AI_RATE_LIMIT" | "AI_NETWORK" | "AI_TIMEOUT";
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export interface AgentLoopModelSettings {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly toolChoice?: AIToolChoice;
}

export interface AgentLoopCommonInput {
  readonly signal: AbortSignal;
  readonly run: AgentRun;
  readonly state: AgentState;
  readonly history: readonly LLMMessage[];
  /** Durable conversation sequence values aligned with history when available. */
  readonly historySourceSequences?: readonly number[];
  readonly baseSystemPrompt: string;
  readonly contextLimits: ContextBuildLimits;
  /**
   * The model-visible Tool catalog for this turn.
   *
   * It is the AI package's `AIToolSpec` — exactly `name`, `description` and `inputSchema` — because that
   * is the one model-facing Tool contract in the architecture. Phase 4F replaced the legacy Protocol
   * `ToolDefinition` here: the registry already stores a tool's model-facing spec separately from its
   * executable contract, so passing that spec through is not a projection but the value itself, and the
   * legacy seven-field shape cannot leak risk level, capabilities or runtime requirements into a
   * provider request.
   */
  readonly tools?: readonly AIToolSpec[];
  readonly modelSettings?: AgentLoopModelSettings;
  readonly cwd?: string;
  readonly explicitPaths?: readonly string[];
  readonly verificationRepairContext?: VerificationRepairContextInput;
}

export type AgentLoopStartInput = AgentLoopCommonInput;

/**
 * A continuation of the same Run without new user input.
 *
 * The Run continues from where it was — the previous Reasons' durable messages stay as they
 * are — so the frozen loop receives a `CONTINUATION` rather than a fabricated user message.
 * `VERIFICATION_REPAIR` is the wired reason; `STEERING` is contract-only.
 */
export interface AgentLoopContinuationInput extends AgentLoopCommonInput {
  readonly reason: "VERIFICATION_REPAIR" | "STEERING";
  readonly messages?: readonly AIUserMessage[];
}

export interface AgentLoopResumeInput extends AgentLoopCommonInput {
  readonly pendingDecision: AgentToolCallsDecision;
  readonly toolResults: readonly LLMToolResultMessage[];
  /**
   * The durable Step that produced `pendingDecision`.
   *
   * It is the `sourceStepId` of the continuation the Run Layer is resuming from — the step that
   * requested the tools — never the Step of the resume attempt itself and never the model
   * turn's call identity. The Run Layer owns Step identity, so it supplies this; the loop would
   * have nothing truthful to derive it from.
   */
  readonly sourceStepId: StepId;
}

/**
 * The Core-private record of the frozen kernel result a projection came from.
 *
 * ```text
 * CORE COMPATIBILITY SIDECAR — not a Protocol field, never durable, never on the wire
 * ```
 *
 * The facade calls `AgentLoop.advance()` and projects what it returns into the legacy
 * `AgentLoopExecutionResult` the Run Layer has always consumed. Phase 3C's settlement router needs
 * the *original* frozen result, and re-deriving one from the legacy projection would mean guessing
 * at a context receipt, a model turn, a usage count and a Step identity. This carries the object
 * the kernel actually returned instead.
 *
 * It is absent — deliberately, and never fabricated — on every result this facade produces without
 * a kernel `advance()` behind it: a failure before the provider was contacted, a cancellation
 * before the Step existed, the `maxSteps` gate, and a budget admission block. A consumer that sees
 * `canonical === undefined` is looking at a pure compatibility outcome, and must treat it as one.
 */
export interface AgentLoopCanonicalResultCarrier {
  readonly canonical?: AgentLoopAdvanceResult;
}

export interface AgentLoopOutcomeResult extends AgentLoopCanonicalResultCarrier {
  readonly status: "OUTCOME";
  readonly outcome: AgentLoopOutcome;
  readonly state: AgentState;
  readonly step?: AgentStep;
  readonly messagesToAppend: readonly LLMMessage[];
  /** The frozen context receipt's report, carried through untouched. */
  readonly contextReport?: ContextBuildReport;
  readonly providerTurnState: AgentProviderTurnState;
}

export interface AgentLoopFailureResult extends AgentLoopCanonicalResultCarrier {
  readonly status: "FAILED";
  readonly error: AgentError;
  readonly state: AgentState;
  readonly step?: AgentStep;
  readonly messagesToAppend: readonly LLMMessage[];
  readonly contextReport?: ContextBuildReport;
  readonly providerTurnState: AgentProviderTurnState;
  readonly retry?: AgentRetryMetadata;
  readonly budget?: AgentBudgetBlock;
  readonly usage?: ModelUsage;
}

export interface AgentLoopCancelledResult extends AgentLoopCanonicalResultCarrier {
  readonly status: "CANCELLED";
  readonly state: AgentState;
  readonly step?: AgentStep;
  readonly messagesToAppend: readonly LLMMessage[];
  readonly contextReport?: ContextBuildReport;
  readonly providerTurnState: "NOT_STARTED" | "CANCELLED";
}

export type AgentLoopExecutionResult =
  AgentLoopOutcomeResult | AgentLoopFailureResult | AgentLoopCancelledResult;

export type AgentLoopRequest = AIModelRequest;
export type AgentLoopTurn = AIModelTurnResult;
export type AgentLoopTimestamp = TimestampMs;
export type AgentLoopStepId = StepId;

export type { AgentLoopDependencies };
