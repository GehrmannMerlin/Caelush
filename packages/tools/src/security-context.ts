/**
 * The legacy Tool security context entry point.
 *
 * ```text
 * Phase 4C moved the canonical declaration to @caelush/agent
 * this module re-exports it
 * ```
 *
 * The general Admission Context — a `PermissionProfile` and an `ApprovalPolicy` — is what the
 * admission coordinator consumes, so it belongs with the contract rather than with the legacy Tool
 * System. Exactly one interface declaration exists in the repository now; this file is an export
 * mapping, not a second shape.
 *
 * The legacy `assertToolSecurityContext` keeps its exact validation semantics — a two-field object
 * with Protocol-valid values, and nothing else — but its throw type changes from the legacy
 * `ToolDispatcherInputError` to the Agent layer's `ToolSecurityContextError`, because the assertion
 * now lives in the layer that owns the contract. A caller that only needs "did this fail" is
 * unaffected; a caller that matched on the legacy class must match on the canonical one.
 */
export {
  assertToolSecurityContext,
  isToolSecurityContext,
  ToolSecurityContextError,
} from "@caelush/agent";
export type { ToolSecurityContext, ToolSecurityContextErrorReason } from "@caelush/agent";
