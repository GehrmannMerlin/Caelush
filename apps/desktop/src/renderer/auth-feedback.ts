import type { AccountState, AccountStatus } from "../main/account/state.js";
import { accountNoticeMessage, errorMessage } from "./account-messages.js";

export type AuthScreen = "login" | "register" | "verify" | "forgot" | "reset";

export interface AuthFeedback {
  readonly screen: AuthScreen;
  readonly generation: number;
  readonly tone: "info" | "error";
  readonly message: string;
}

type AuthAccountState = Pick<AccountState, "status" | "lastError" | "notice">;

export function isCurrentAuthOperation(generation: number, currentGeneration: number): boolean {
  return generation === currentGeneration;
}

const persistentAuthErrorStatuses: ReadonlySet<AccountStatus> = new Set([
  "ERROR",
  "LOCKED",
  "SESSION_EXPIRED",
  "OFFLINE_GRANT_EXPIRED",
  "DEVICE_REVOKED",
]);

export function isCurrentAuthFeedback(
  feedback: AuthFeedback | null,
  screen: AuthScreen,
  generation: number,
): boolean {
  return feedback !== null && feedback.screen === screen && feedback.generation === generation;
}

export function resolveAuthMessage(
  feedback: AuthFeedback | null,
  screen: AuthScreen,
  generation: number,
  state: AuthAccountState,
): AuthFeedback | null {
  if (isCurrentAuthFeedback(feedback, screen, generation)) return feedback;

  if (state.lastError !== null && persistentAuthErrorStatuses.has(state.status)) {
    return {
      screen,
      generation,
      tone: "error",
      message: errorMessage(state.lastError),
    };
  }

  if (screen === "login" && state.notice !== null) {
    return {
      screen,
      generation,
      tone: "info",
      message: accountNoticeMessage(state.notice),
    };
  }

  return null;
}
