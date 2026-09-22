import {
  ApprovalPolicySchema,
  PermissionProfileSchema,
  type ApprovalPolicy,
  type PermissionProfile,
} from "@caelush/protocol";

/**
 * What a Run is allowed to do, as data.
 *
 * ```ts
 * export interface ToolSecurityContext {
 *   readonly permissionProfile: PermissionProfile;
 *   readonly approvalPolicy: ApprovalPolicy;
 * }
 * ```
 *
 * ```text
 * ToolExecutionEnvironment   where / with what runtime   (Tool System V2)
 * ToolSecurityContext        what policy this Run runs under
 * ```
 *
 * The context is **durable Run policy**, never model input: it is derived from the persisted
 * `AgentRun`, validated at the Run boundary, and forwarded unchanged through the batch and dispatch
 * requests. A Tool that could choose its own permission profile would be authorizing itself.
 *
 * ## Why the canonical declaration lives here
 *
 * Phase 4C moved the Tool Invocation Security Context into the general Agent Tool Layer. It names
 * only Protocol values — `PermissionProfile` and `ApprovalPolicy` — so a general Agent host can
 * express its own policy without a Coding product, and the layer that consumes it (the admission
 * coordinator) shares a package with the layer that declares it. Phase 4F removed the legacy
 * `@caelush/tools` package, so `@caelush/agent` is now the only declaration of `ToolSecurityContext`.
 */
export interface ToolSecurityContext {
  readonly permissionProfile: PermissionProfile;
  readonly approvalPolicy: ApprovalPolicy;
}

/** Why a security context was refused. A host maps this onto its own error vocabulary. */
export type ToolSecurityContextErrorReason =
  "NOT_AN_OBJECT" | "UNEXPECTED_FIELDS" | "INVALID_PERMISSION_PROFILE" | "INVALID_APPROVAL_POLICY";

export class ToolSecurityContextError extends Error {
  readonly reason: ToolSecurityContextErrorReason;

  constructor(reason: ToolSecurityContextErrorReason) {
    super("Tool security context is invalid.");
    this.name = "ToolSecurityContextError";
    this.reason = reason;
  }
}

/**
 * Refuse anything that is not exactly a two-field, Protocol-valid security context.
 *
 * The check is deliberately *exact*: two own properties and nothing else. A context that carried a
 * third field would be a second, host-specific policy channel that the admission layer does not
 * understand and therefore cannot honour, so it is refused rather than ignored.
 *
 * The failure is thrown, never defaulted: a missing or malformed policy context must never become
 * "no policy configured, therefore allow".
 */
export function assertToolSecurityContext(value: unknown): asserts value is ToolSecurityContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolSecurityContextError("NOT_AN_OBJECT");
  }
  const context = value as Record<string, unknown>;
  if (Object.keys(context).length !== 2) {
    throw new ToolSecurityContextError("UNEXPECTED_FIELDS");
  }
  if (!Object.hasOwn(context, "permissionProfile") || !Object.hasOwn(context, "approvalPolicy")) {
    throw new ToolSecurityContextError("UNEXPECTED_FIELDS");
  }
  if (!PermissionProfileSchema.safeParse(context.permissionProfile).success) {
    throw new ToolSecurityContextError("INVALID_PERMISSION_PROFILE");
  }
  if (!ApprovalPolicySchema.safeParse(context.approvalPolicy).success) {
    throw new ToolSecurityContextError("INVALID_APPROVAL_POLICY");
  }
}

/** The structural predicate form, for a caller that wants a boolean rather than a throw. */
export function isToolSecurityContext(value: unknown): value is ToolSecurityContext {
  try {
    assertToolSecurityContext(value);
    return true;
  } catch {
    return false;
  }
}
