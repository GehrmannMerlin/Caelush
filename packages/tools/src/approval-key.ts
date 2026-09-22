import type {
  Capability,
  JsonObject,
  PermissionProfile,
  ApprovalPolicy,
  RiskLevel,
  ToolDefinition,
  ToolName,
} from "@caelush/protocol";
import { computeCodingToolApprovalKey } from "@caelush/coding-agent";

import type { ToolSecurityContext } from "./security-context.js";

/**
 * The legacy Tool approval identity — delegated to the canonical Coding implementation.
 *
 * ```text
 * @caelush/tools/src/approval-key.ts          this file: the legacy signature
 *        └── delegates ──▶  @caelush/coding-agent
 *                             tools/security/approval-identity.ts
 * ```
 *
 * ## Why the algorithm moved
 *
 * Every input except the Tool name and the arguments is Coding/Security overlay semantics: the risk
 * level, the required capabilities, the runtime requirements and the two Run policies. An algorithm
 * that binds those together is the overlay's algorithm, so Phase 4E moved it to the package that owns
 * the metadata it reads. The Security Gate that *consumes* a key stays in `@caelush/security`.
 *
 * ## Why a durable approval survives the move
 *
 * The identity is `SHA-256(canonicalJsonString(identity))` over exactly the same seven fields, sorted
 * the same way, encoded by the same `canonicalJsonString` — which has itself been a re-export of
 * `@caelush/agent` since the legacy JSON helpers were consolidated. Nothing about the bytes changed,
 * so a grant persisted before the migration still matches a key computed after it. The fidelity test
 * in the Phase 4E suite compares the two functions byte for byte for all nine Tools.
 *
 * ## What this file may not grow back into
 *
 * It owns no hashing, no canonical encoding, no field ordering and no defaulting. If it did, one
 * migration would have produced two answers to "does this grant cover this call".
 */
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
  return computeCodingToolApprovalKey({
    toolName: input.toolName,
    security: {
      riskLevel: input.definition.riskLevel satisfies RiskLevel,
      requiredCapabilities: input.definition.requiredCapabilities,
      runtimeRequirements: input.definition.runtimeRequirements,
    },
    args: input.args,
    securityContext: {
      permissionProfile: input.securityContext.permissionProfile satisfies PermissionProfile,
      approvalPolicy: input.securityContext.approvalPolicy satisfies ApprovalPolicy,
    },
  });
}
