import type { ApprovalPolicy, PermissionProfile } from "@caelush/protocol";
import {
  combineSecurityDecisions,
  type SecurityDecision,
  type SecurityDecisionCode,
} from "./decision.js";
import { evaluateInputSecurityPolicy } from "./input-policy.js";
import { evaluateSecurityPolicy } from "./evaluator.js";

export interface VerificationCommandSecurityInput {
  readonly kind: "SCRIPT" | "COMMAND";
  readonly label: string;
  readonly body: string;
  readonly workdir: string;
}

export interface VerificationCommandSecurityAssessmentInput {
  readonly permissionProfile: PermissionProfile;
  readonly approvalPolicy: ApprovalPolicy;
  readonly executable: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly inputs: readonly VerificationCommandSecurityInput[];
}

export type VerificationSecurityDecision =
  | {
      readonly kind: "ALLOW";
      readonly reasonCode: "ALLOWED_BY_POLICY";
      readonly safeReason: string;
    }
  | {
      readonly kind: "REVIEW_REQUIRED";
      readonly reasonCode: SecurityDecisionCode;
      readonly safeReason: string;
    }
  | {
      readonly kind: "DENY";
      readonly reasonCode: SecurityDecisionCode;
      readonly safeReason: string;
    };

export interface VerificationCommandSecurityPort {
  assess(input: VerificationCommandSecurityAssessmentInput): VerificationSecurityDecision;
}

export function assessVerificationCommand(
  input: VerificationCommandSecurityAssessmentInput,
): VerificationSecurityDecision {
  let decision = evaluateSecurityPolicy({
    permissionProfile: input.permissionProfile,
    approvalPolicy: input.approvalPolicy,
    riskLevel: "LOW",
    requiredCapabilities: ["SHELL_EXEC", "PROCESS_START"],
  });

  for (const securityInput of input.inputs) {
    const assessment = evaluateInputSecurityPolicy(
      {
        resourceAccesses: [],
        shellCommand: {
          command: securityInput.body,
          workdir: securityInput.workdir,
          tty: false,
        },
        secretScanInputs: [{ kind: "COMMAND", text: securityInput.body }],
      },
      {
        permissionProfile: input.permissionProfile,
        approvalPolicy: input.approvalPolicy,
      },
    );
    if (assessment.kind === "DENY") {
      return fromSecurityDecision({
        kind: "DENY",
        reasonCode: assessment.reasonCode,
        safeReason: assessment.safeReason,
      } as Extract<SecurityDecision, { kind: "DENY" }>);
    }
    if (assessment.kind === "REQUIRE_APPROVAL") {
      decision = combineSecurityDecisions(decision, {
        kind: "REQUIRE_APPROVAL",
        reasonCode: assessment.reasonCode,
        safeReason: assessment.safeReason,
      } as Extract<SecurityDecision, { kind: "REQUIRE_APPROVAL" }>);
    }
  }

  return fromSecurityDecision(decision);
}

export const verificationCommandSecurityPort: VerificationCommandSecurityPort = {
  assess: assessVerificationCommand,
};

function fromSecurityDecision(decision: SecurityDecision): VerificationSecurityDecision {
  if (decision.kind === "REQUIRE_APPROVAL") {
    return {
      kind: "REVIEW_REQUIRED",
      reasonCode: decision.reasonCode,
      safeReason: decision.safeReason,
    };
  }
  return decision;
}
