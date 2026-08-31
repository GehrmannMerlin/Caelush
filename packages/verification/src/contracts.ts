import type {
  VerificationCheck,
  VerificationEvidence,
  VerificationPlan,
  VerificationProjectCheckPurpose,
  VerificationCheckStage,
} from "@caelush/protocol";

export type VerificationDiscoveryReason =
  | "NOT_AVAILABLE"
  | "UNKNOWN_PACKAGE_MANAGER"
  | "AMBIGUOUS_PACKAGE_MANAGER"
  | "MISSING_SCRIPT"
  | "UNSUPPORTED_ECOSYSTEM"
  | "INVALID_PROJECT_PROFILE";

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
}

export interface VerificationCandidateInput {
  readonly checkId: VerificationCommandCandidate["checkId"];
  readonly executable: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly provenance: VerificationCommandCandidate["provenance"];
  readonly securityInputs: readonly VerificationCommandSecurityInput[];
}

export type VerificationProjectCheck = Extract<VerificationCheck["spec"], { kind: "PROJECT" }> & {
  readonly purpose: VerificationProjectCheckPurpose;
};

export type { VerificationCheckStage };
