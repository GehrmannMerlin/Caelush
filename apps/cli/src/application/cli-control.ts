import type {
  ApprovalRequest,
  ApprovalRequestId,
  ApprovalResolution,
  ApprovalScope,
  RiskLevel,
  RunId,
  RunStatus,
} from "@caelush/protocol";
import type { CliViewState } from "./cli-state.js";

const MAX_APPROVAL_TEXT_BYTES = 2 * 1024;
const MAX_APPROVAL_SUMMARY_BYTES = 512;
const MAX_APPROVAL_CAPABILITIES = 16;

export type CliTransportState = "CONNECTED" | "RECONNECTING" | "DISCONNECTED";

export type CliControlMode =
  | "NONE"
  | "APPROVAL"
  | "CANCELLING"
  | "SESSION_PICKER"
  | "RUN_RECOVERY_PICKER"
  | "PENDING_RUN_CONFIRMATION";

export type CliApprovalOptionKind = "APPROVE_ONCE" | "APPROVE_RUN" | "REJECT";

export interface CliApprovalOption {
  readonly kind: CliApprovalOptionKind;
  readonly label: string;
}

export interface CliApprovalView {
  readonly id: ApprovalRequestId;
  readonly runId: RunId;
  readonly title: string;
  readonly reason: string;
  readonly riskLevel: RiskLevel;
  readonly scope: ApprovalScope;
  readonly toolName?: string;
  readonly requiredCapabilities: readonly string[];
  readonly summary?: string;
  readonly options: readonly CliApprovalOption[];
  readonly selectedIndex: number;
}

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

export function approvalOptions(scope: ApprovalScope): readonly CliApprovalOption[] {
  const options: CliApprovalOption[] = [
    { kind: "APPROVE_ONCE", label: "Approve once" },
  ];
  if (scope === "RUN") {
    options.push({ kind: "APPROVE_RUN", label: "Approve this action for this Run" });
  }
  options.push({ kind: "REJECT", label: "Reject" });
  return options;
}

export function approvalResolutionForOption(kind: CliApprovalOptionKind): ApprovalResolution {
  switch (kind) {
    case "APPROVE_ONCE":
      return { action: "APPROVE", scope: "ONCE" };
    case "APPROVE_RUN":
      return { action: "APPROVE", scope: "RUN" };
    case "REJECT":
      return { action: "REJECT" };
  }
}

export function createApprovalView(approval: ApprovalRequest): CliApprovalView {
  const options = approvalOptions(approval.scope);
  const action = approval.action;
  const toolName = boundedString(action.toolName, MAX_APPROVAL_SUMMARY_BYTES);
  const summary = boundedString(action.summary, MAX_APPROVAL_SUMMARY_BYTES);
  const requiredCapabilities = Array.isArray(action.requiredCapabilities)
    ? action.requiredCapabilities
        .filter((value): value is string => typeof value === "string")
        .slice(0, MAX_APPROVAL_CAPABILITIES)
        .map((value) => boundedString(value, MAX_APPROVAL_SUMMARY_BYTES))
        .filter((value): value is string => value !== undefined)
    : [];
  return {
    id: approval.id,
    runId: approval.runId,
    title: boundedString(approval.title, MAX_APPROVAL_TEXT_BYTES) ?? "Approval required",
    reason: boundedString(approval.reason, MAX_APPROVAL_TEXT_BYTES) ?? "Approval is required.",
    riskLevel: approval.riskLevel,
    scope: approval.scope,
    ...(toolName === undefined ? {} : { toolName }),
    requiredCapabilities,
    ...(summary === undefined ? {} : { summary }),
    options,
    selectedIndex: options.findIndex((option) => option.kind === "REJECT"),
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
    if (key.escape) return { kind: "APPROVAL_CLOSE" };
    if (state.approvalState?.submitting) return { kind: "NONE" };
    if (key.return && state.approvalState?.requests.length !== 0) {
      return { kind: "APPROVAL_SUBMIT" };
    }
    if (key.upArrow) return { kind: "APPROVAL_MOVE", delta: -1 };
    if (key.downArrow) return { kind: "APPROVAL_MOVE", delta: 1 };
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

  if (state.activeRun === undefined && key.ctrl && (input === "c" || input === "d")) {
    return { kind: "EXIT" };
  }
  if (state.composerEnabled) return { kind: "COMPOSER" };
  return { kind: "NONE" };
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "TIMEOUT" ||
    status === "MAX_STEPS_REACHED" ||
    status === "BUDGET_EXCEEDED"
  );
}

export function canCancelRunStatus(status: RunStatus): boolean {
  return status === "RUNNING" || status === "WAITING_APPROVAL" || status === "VERIFYING";
}

function boundedString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(encoded.slice(0, maxBytes)).replace(/\uFFFD$/u, "");
}
