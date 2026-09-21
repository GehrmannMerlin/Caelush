import { createHash } from "node:crypto";
import type { Capability, JsonObject, RiskLevel, ToolName } from "@caelush/protocol";
import { canonicalJsonString, type ToolSecurityContext } from "@caelush/agent";

/**
 * The Coding Tool approval identity.
 *
 * ```text
 * toolName + prepared args + Coding security metadata + security context  →  SHA-256
 * ```
 *
 * ## What the key is for
 *
 * An approval is a decision about one exact call. The key is the host-internal fingerprint that decides
 * whether a *stored* grant covers *this* call, so an approval resolved under one set of arguments,
 * capabilities and policies can never be reused for a different one.
 *
 * ## Why it lives here
 *
 * Every input except the tool name and the arguments is Coding/Security overlay semantics: the risk
 * level, the required capabilities, the runtime requirements and the two Run policies. Those are the
 * Coding overlay's facts, so the algorithm that binds them together is the Coding overlay's too. The
 * Security Gate that *consumes* the key stays in `@caelush/security`; this module only computes it.
 *
 * ## Determinism is the whole contract
 *
 * ```text
 * same prepared args + same metadata + same context  →  byte-identical key
 * ```
 *
 * That is what keeps a durable approval valid across a restart, and what keeps it valid across this
 * migration: the identity moved owner, and it must not have moved value. The inputs are the same, the
 * sorting is the same, the canonical JSON encoding is the same — one shared implementation of canonical
 * encoding, imported from `@caelush/agent` rather than reimplemented — and therefore the digest is the
 * same. A compatibility test compares this function against the legacy algorithm for representative
 * arguments of all nine builtins.
 *
 * ## Raw arguments never enter it
 *
 * `args` must be the **prepared, normalized, schema-validated** arguments. Falling back to the provider's
 * raw arguments would make the key depend on a representation the Tool never received, and two calls
 * that execute identically could fingerprint differently.
 */
export interface CodingToolApprovalIdentityInput {
  readonly toolName: ToolName;
  readonly security: {
    readonly riskLevel: RiskLevel;
    readonly requiredCapabilities: readonly Capability[];
    readonly runtimeRequirements: JsonObject;
  };
  readonly args: JsonObject;
  /** The Run's validated authorization context. It comes from durable state, never from arguments. */
  readonly securityContext: Pick<ToolSecurityContext, "permissionProfile" | "approvalPolicy">;
}

/** Host-internal identity for an exact security decision; never expose this as a model field. */
export function computeCodingToolApprovalKey(input: CodingToolApprovalIdentityInput): string {
  const identity = {
    toolName: input.toolName,
    args: input.args,
    riskLevel: input.security.riskLevel,
    requiredCapabilities: [...input.security.requiredCapabilities].sort(),
    runtimeRequirements: input.security.runtimeRequirements,
    permissionProfile: input.securityContext.permissionProfile,
    approvalPolicy: input.securityContext.approvalPolicy,
  };
  return createHash("sha256").update(canonicalJsonString(identity), "utf8").digest("hex");
}
