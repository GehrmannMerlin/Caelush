import type {
  ApprovalRequest,
  ApprovalRequestId,
  ApprovalResolution,
  ApprovalScope,
  RiskLevel,
  RunId,
} from "@caelush/protocol";

const MAX_APPROVAL_TEXT_BYTES = 2 * 1024;
const MAX_APPROVAL_SUMMARY_BYTES = 512;
const MAX_APPROVAL_CAPABILITIES = 16;

export type ApprovalOptionKind = "APPROVE_ONCE" | "APPROVE_RUN" | "REJECT";

export interface ApprovalOption {
  readonly kind: ApprovalOptionKind;
  readonly label: string;
}

export interface ApprovalView {
  readonly id: ApprovalRequestId;
  readonly runId: RunId;
  readonly createdAt: number;
  readonly title: string;
  readonly reason: string;
  readonly riskLevel: RiskLevel;
  readonly scope: ApprovalScope;
  readonly toolName?: string;
  readonly requiredCapabilities: readonly string[];
  readonly summary?: string;
  readonly options: readonly ApprovalOption[];
}

export function approvalOptions(scope: ApprovalScope): readonly ApprovalOption[] {
  const options: ApprovalOption[] = [{ kind: "APPROVE_ONCE", label: "Approve once" }];
  if (scope === "RUN") {
    options.push({ kind: "APPROVE_RUN", label: "Approve this action for this Run" });
  }
  options.push({ kind: "REJECT", label: "Reject" });
  return options;
}

export function approvalResolutionForOption(kind: ApprovalOptionKind): ApprovalResolution {
  switch (kind) {
    case "APPROVE_ONCE":
      return { action: "APPROVE", scope: "ONCE" };
    case "APPROVE_RUN":
      return { action: "APPROVE", scope: "RUN" };
    case "REJECT":
      return { action: "REJECT" };
  }
}

export function createApprovalView(approval: ApprovalRequest): ApprovalView {
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
    createdAt: approval.createdAt,
    title: boundedString(approval.title, MAX_APPROVAL_TEXT_BYTES) ?? "Approval required",
    reason: boundedString(approval.reason, MAX_APPROVAL_TEXT_BYTES) ?? "Approval is required.",
    riskLevel: approval.riskLevel,
    scope: approval.scope,
    ...(toolName === undefined ? {} : { toolName }),
    requiredCapabilities,
    ...(summary === undefined ? {} : { summary }),
    options: approvalOptions(approval.scope),
  };
}

function boundedString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(encoded.slice(0, maxBytes)).replace(/\uFFFD$/u, "");
}
