import type { AIToolChoice } from "@caelush/ai";
import type { StepId, TimestampMs } from "@caelush/protocol";

/** Model settings kept at the Core-to-AI execution boundary. */
export interface AgentLoopModelSettings {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly toolChoice?: AIToolChoice;
}

/** Provider-attempt state used only by Core's durable settlement projection. */
export type AgentProviderTurnState = "NOT_STARTED" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface AgentStepIdFactory {
  create(): StepId;
}

export interface AgentClock {
  now(): TimestampMs;
}

export interface AgentRetryMetadata {
  readonly code: "AI_RATE_LIMIT" | "AI_NETWORK" | "AI_TIMEOUT";
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

/** Bounded verification diagnostic text handed to the Context Engine by Core. */
export interface AgentVerificationRepairContext {
  readonly text: string;
}
