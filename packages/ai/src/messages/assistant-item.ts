import type { AIContent } from "./content.js";

/** Provider-neutral display phase supplied only when an adapter has an explicit safe signal. */
export type AIMessagePhase = "COMMENTARY" | "FINAL_ANSWER" | "UNKNOWN";

/**
 * One ordered assistant item within a provider turn.
 *
 * The identity is minted by the AI gateway from its call id and a bounded adapter index; raw
 * provider item identifiers never cross this contract. Phase is presentation metadata and never
 * decides Tool execution or Run completion.
 */
export interface AIModelTurnAssistantItem {
  readonly assistantItemId: string;
  readonly phase: AIMessagePhase;
  readonly content: readonly AIContent[];
}

export const AI_MESSAGE_PHASES = [
  "COMMENTARY",
  "FINAL_ANSWER",
  "UNKNOWN",
] as const satisfies readonly AIMessagePhase[];

export function isAIMessagePhase(value: unknown): value is AIMessagePhase {
  return value === "COMMENTARY" || value === "FINAL_ANSWER" || value === "UNKNOWN";
}
