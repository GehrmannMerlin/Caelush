import { createHash } from "node:crypto";
import type {
  JsonObject,
  PermissionProfile,
  ApprovalPolicy,
  Capability,
  RiskLevel,
  ToolDefinition,
  ToolName,
} from "@caelush/protocol";
import { canonicalJsonString } from "./json-canonical.js";
import type { ToolSecurityContext } from "./security-context.js";

export interface ToolApprovalKeyInput {
  readonly toolName: ToolName;
  readonly definition: {
    readonly description?: string;
    readonly name?: ToolName;
    readonly riskLevel: ToolDefinition["riskLevel"];
    readonly requiredCapabilities: readonly Capability[];
    readonly runtimeRequirements: JsonObject;
  };
  readonly args: JsonObject;
  readonly securityContext: Pick<ToolSecurityContext, "permissionProfile" | "approvalPolicy">;
}

/** Host-internal identity for an exact security decision; never expose this as a model field. */
export function computeToolApprovalKey(input: ToolApprovalKeyInput): string {
  const identity = {
    toolName: input.toolName,
    args: input.args,
    riskLevel: input.definition.riskLevel satisfies RiskLevel,
    requiredCapabilities: [...input.definition.requiredCapabilities].sort(),
    runtimeRequirements: input.definition.runtimeRequirements,
    permissionProfile: input.securityContext.permissionProfile satisfies PermissionProfile,
    approvalPolicy: input.securityContext.approvalPolicy satisfies ApprovalPolicy,
  };
  return createHash("sha256").update(canonicalJsonString(identity), "utf8").digest("hex");
}
