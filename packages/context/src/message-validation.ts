import { assertAIMessage } from "@caelush/ai";
import type { AIMessage, AIUserMessage } from "@caelush/ai";

export function isAIMessage(value: unknown): value is AIMessage {
  try {
    assertAIMessage(value);
    return true;
  } catch {
    return false;
  }
}

export function isAIUserMessage(value: unknown): value is AIUserMessage {
  return isAIMessage(value) && value.role === "user";
}
