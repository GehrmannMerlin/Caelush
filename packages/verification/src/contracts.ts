import type {
  ApprovalPolicy,
  PermissionProfile,
  RunId,
  SessionId,
  VerificationCheck,
  VerificationEvidence,
  VerificationPlan,
  VerificationProjectCheckPurpose,
  VerificationCheckStage,
} from "@caelush/protocol";
import type { VerificationProjectProfile } from "./resolver.js";

export type VerificationDiscoveryReason =
  | "SCRIPT_NOT_DEFINED"
  | "PACKAGE_MANAGER_UNKNOWN"
  | "PACKAGE_MANAGER_AMBIGUOUS"
  | "ECOSYSTEM_UNSUPPORTED"
  | "TOOLING_UNAVAILABLE"
  | "PROJECT_PROFILE_INSUFFICIENT";

export interface VerificationCommandSecurityInput {
  readonly kind: "SCRIPT" | "COMMAND";
  readonly label: string;
  readonly body: string;
  readonly workdir: string;
}

export interface VerificationCommandCandidate {
  readonly checkId: VerificationCheck["id"];
  readonly executable: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly provenance: {
    readonly ecosystem: string;
    readonly resolver: string;
    readonly evidencePath?: string;
    readonly scriptName?: string;
  };
  readonly securityInputs: readonly VerificationCommandSecurityInput[];
  readonly candidateHash: string;
}

export type ProjectCheckResolution =
  | { readonly kind: "READY"; readonly candidate: VerificationCommandCandidate }
  | { readonly kind: "UNAVAILABLE"; readonly reason: VerificationDiscoveryReason };

export interface VerificationEvidenceSanitizer {
  redactText(value: string): string;
  boundText(
    value: string,
    maxBytes: number,
  ): {
    readonly text: string;
    readonly omittedBytes: number;
    readonly truncated: boolean;
  };
}

export interface VerificationDiscoveryEvidenceInput {
  readonly id: VerificationEvidence["id"];
  readonly planId: VerificationPlan["id"];
  readonly checkId: VerificationCheck["id"];
  readonly capturedAt: VerificationEvidence["capturedAt"];
  readonly resolver: string;
  readonly ecosystem: string;
  readonly packageScope?: string;
  readonly evidencePath?: string;
  readonly packageManager?: string;
  readonly scriptName?: string;
  readonly candidateHash?: string;
  readonly available?: boolean;
  readonly reason?: VerificationDiscoveryReason;
  readonly securityReasonCode?: string;
}

export interface VerificationCommandEvidenceInput {
  readonly id: VerificationEvidence["id"];
  readonly planId: VerificationPlan["id"];
  readonly checkId: VerificationCheck["id"];
  readonly capturedAt: VerificationEvidence["capturedAt"];
  readonly label: string;
  readonly candidateHash: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs?: number;
  readonly totalOutputBytes: number;
  readonly omittedBytes: number;
  readonly errorCode?: string;
}

export interface VerificationCandidateInput {
  readonly checkId: VerificationCommandCandidate["checkId"];
  readonly executable: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly provenance: VerificationCommandCandidate["provenance"];
  readonly securityInputs: readonly VerificationCommandSecurityInput[];
}

export interface VerificationRuntimeExecResult {
  readonly status: "RUNNING" | "EXITED";
  readonly sessionId?: string;
  readonly output: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly totalOutputBytes: number;
  readonly omittedBytes: number;
  readonly durationMs?: number;
}

export interface VerificationRuntimeArgvRequest {
  readonly signal?: AbortSignal;
  readonly ownerRunId: RunId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly workdir?: string;
  readonly yieldTimeMs: number;
}

export interface VerificationRuntimeProcessInteractionRequest {
  readonly signal?: AbortSignal;
  readonly ownerRunId: RunId;
  readonly sessionId: string;
  readonly chars: string;
  readonly yieldTimeMs: number;
}

export interface VerificationCommandExecutionPort {
  executeArgv(request: VerificationRuntimeArgvRequest): Promise<VerificationRuntimeExecResult>;
  interact(
    request: VerificationRuntimeProcessInteractionRequest,
  ): Promise<VerificationRuntimeExecResult>;
}

export interface VerificationStartCommit {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly check: VerificationCheck;
  readonly discoveryEvidence: VerificationEvidence;
}

export interface VerificationSettlementCommit {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly check: VerificationCheck;
  readonly evidence: readonly VerificationEvidence[];
}

export interface VerificationStartCommitResult {
  readonly check: VerificationCheck;
}

export interface VerificationSettlementCommitResult {
  readonly check: VerificationCheck;
}

export interface VerificationExecutionStorePort {
  startCheck(input: VerificationStartCommit): Promise<VerificationStartCommitResult>;
  settleCheck(input: VerificationSettlementCommit): Promise<VerificationSettlementCommitResult>;
}

export interface VerificationCommandSecurityPort {
  assess(input: {
    readonly permissionProfile: PermissionProfile;
    readonly approvalPolicy: ApprovalPolicy;
    readonly executable: string;
    readonly args: readonly string[];
    readonly workdir: string;
    readonly inputs: readonly VerificationCommandSecurityInput[];
  }):
    | { readonly kind: "ALLOW"; readonly safeReason: string }
    | { readonly kind: "REVIEW_REQUIRED"; readonly reasonCode: string; readonly safeReason: string }
    | { readonly kind: "DENY"; readonly reasonCode: string; readonly safeReason: string };
}

export interface VerificationRunnerInput {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly plan: VerificationPlan;
  readonly profile: VerificationProjectProfile;
  readonly permissionProfile: PermissionProfile;
  readonly approvalPolicy: ApprovalPolicy;
  readonly signal?: AbortSignal;
  readonly now: () => number;
  readonly resolverRegistry: {
    resolve(check: VerificationCheck, profile: VerificationProjectProfile): ProjectCheckResolution;
  };
  readonly security: VerificationCommandSecurityPort;
  readonly execution: VerificationCommandExecutionPort;
  readonly store: VerificationExecutionStorePort;
  readonly evidenceIdFactory: () => VerificationEvidence["id"];
  readonly pollYieldTimeMs?: number;
  readonly evidenceSanitizer: VerificationEvidenceSanitizer;
}

export interface VerificationRunnerResult {
  readonly outcome: "PROJECT_CHECKS_PASSED" | "BLOCKED" | "CANCELLED";
  readonly executedCount: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly errorCount: number;
  readonly skippedCount: number;
  readonly blockingCheckId?: VerificationCheck["id"];
}

export type VerificationProjectCheck = Extract<VerificationCheck["spec"], { kind: "PROJECT" }> & {
  readonly purpose: VerificationProjectCheckPurpose;
};

export type { VerificationCheckStage };
