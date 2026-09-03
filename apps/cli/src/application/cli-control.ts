import {
  approvalOptions as sharedApprovalOptions,
  approvalResolutionForOption as sharedApprovalResolutionForOption,
  canCancelRunStatus,
  createApprovalView as createSharedApprovalView,
  isTerminalRunStatus,
  type ApprovalOption,
  type ApprovalOptionKind,
  type ApprovalView,
} from "@caelush/client";
import type { ApprovalRequest } from "@caelush/protocol";
import type { CliViewState } from "./cli-state.js";

export {
  sharedApprovalOptions as approvalOptions,
  sharedApprovalResolutionForOption as approvalResolutionForOption,
  canCancelRunStatus,
  isTerminalRunStatus,
};

export type CliTransportState = "CONNECTED" | "RECONNECTING" | "DISCONNECTED";

export type CliControlMode =
  | "NONE"
  | "APPROVAL"
  | "RESOURCE_GUARD"
  | "CANCELLING"
  | "SESSION_PICKER"
  | "RUN_RECOVERY_PICKER"
  | "PENDING_RUN_CONFIRMATION";

export type CliApprovalOptionKind = ApprovalOptionKind;
export type CliApprovalOption = ApprovalOption;
export type CliApprovalView = ApprovalView & {
  readonly selectedIndex: number;
};

export interface CliApprovalState {
  readonly requests: readonly CliApprovalView[];
  readonly selectedRequestIndex: number;
  readonly submitting: boolean;
}

export interface CliInputKey {
  readonly ctrl?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
}

export type CliInputAction =
  | { readonly kind: "APPROVAL_SUBMIT" }
  | { readonly kind: "RESOURCE_CONTINUE" }
  | { readonly kind: "APPROVAL_CLOSE" }
  | { readonly kind: "APPROVAL_MOVE"; readonly delta: -1 | 1 }
  | { readonly kind: "SESSION_SELECT" }
  | { readonly kind: "SESSION_CLOSE" }
  | { readonly kind: "SESSION_MOVE"; readonly delta: -1 | 1 }
  | { readonly kind: "RUN_RECOVERY_SELECT" }
  | { readonly kind: "RUN_RECOVERY_CLOSE" }
  | { readonly kind: "RUN_RECOVERY_MOVE"; readonly delta: -1 | 1 }
  | { readonly kind: "PENDING_CONFIRM"; readonly confirmed: boolean }
  | { readonly kind: "PENDING_CLOSE" }
  | { readonly kind: "RECONNECT" }
  | { readonly kind: "CANCEL" }
  | { readonly kind: "DETACH" }
  | { readonly kind: "EXIT" }
  | { readonly kind: "COMPOSER" }
  | { readonly kind: "NONE" };

export function createApprovalView(approval: ApprovalRequest): CliApprovalView {
  const view = createSharedApprovalView(approval);
  return {
    ...view,
    selectedIndex: view.options.findIndex((option) => option.kind === "REJECT"),
  };
}

export function routeCliInput(
  state: CliViewState,
  input: string,
  key: CliInputKey,
): CliInputAction {
  if (state.controlMode === "SESSION_PICKER") {
    if (key.escape) return { kind: "SESSION_CLOSE" };
    if (key.return && state.sessionCandidates.length > 0) return { kind: "SESSION_SELECT" };
    if (key.upArrow) return { kind: "SESSION_MOVE", delta: -1 };
    if (key.downArrow) return { kind: "SESSION_MOVE", delta: 1 };
    return { kind: "NONE" };
  }

  if (state.controlMode === "RUN_RECOVERY_PICKER") {
    if (key.escape) return { kind: "RUN_RECOVERY_CLOSE" };
    if (key.return && state.recoveryCandidates.length > 0) {
      return { kind: "RUN_RECOVERY_SELECT" };
    }
    if (key.upArrow) return { kind: "RUN_RECOVERY_MOVE", delta: -1 };
    if (key.downArrow) return { kind: "RUN_RECOVERY_MOVE", delta: 1 };
    return { kind: "NONE" };
  }

  if (state.controlMode === "APPROVAL") {
    if (
      key.ctrl &&
      input.toLowerCase() === "c" &&
      state.activeRun !== undefined &&
      canCancelRunStatus(state.activeRun.status)
    ) {
      return { kind: "CANCEL" };
    }
    if (key.ctrl && input.toLowerCase() === "d" && state.activeRun !== undefined) {
      return { kind: "DETACH" };
    }
    if (key.escape) return { kind: "APPROVAL_CLOSE" };
    if (state.approvalState?.submitting) return { kind: "NONE" };
    if (
      key.return &&
      state.approvalState !== undefined &&
      state.approvalState.requests.length > 0
    ) {
      return { kind: "APPROVAL_SUBMIT" };
    }
    if (key.upArrow) return { kind: "APPROVAL_MOVE", delta: -1 };
    if (key.downArrow) return { kind: "APPROVAL_MOVE", delta: 1 };
    return { kind: "NONE" };
  }

  if (state.controlMode === "RESOURCE_GUARD") {
    if (
      key.ctrl &&
      input.toLowerCase() === "c" &&
      state.activeRun !== undefined &&
      canCancelRunStatus(state.activeRun.status)
    ) {
      return { kind: "CANCEL" };
    }
    if (key.return || input.toLowerCase() === "c") return { kind: "RESOURCE_CONTINUE" };
    return { kind: "NONE" };
  }

  if (state.controlMode === "PENDING_RUN_CONFIRMATION") {
    if (key.escape) return { kind: "PENDING_CLOSE" };
    if (key.return || input.toLowerCase() === "y") {
      return { kind: "PENDING_CONFIRM", confirmed: true };
    }
    if (input.toLowerCase() === "n") {
      return { kind: "PENDING_CONFIRM", confirmed: false };
    }
    return { kind: "NONE" };
  }

  if (state.transportState === "DISCONNECTED") {
    if (input.toLowerCase() === "r" && !key.ctrl) return { kind: "RECONNECT" };
  }

  if (state.activeRun !== undefined && state.controlMode !== "CANCELLING") {
    if (key.ctrl && input.toLowerCase() === "c" && canCancelRunStatus(state.activeRun.status)) {
      return { kind: "CANCEL" };
    }
    if (key.ctrl && input.toLowerCase() === "d") return { kind: "DETACH" };
  }

  if (
    state.activeRun === undefined &&
    key.ctrl &&
    (input.toLowerCase() === "c" || input.toLowerCase() === "d")
  ) {
    return { kind: "EXIT" };
  }
  if (state.composerEnabled) return { kind: "COMPOSER" };
  return { kind: "NONE" };
}
