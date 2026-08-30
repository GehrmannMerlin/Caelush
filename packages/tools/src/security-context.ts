import {
  ApprovalPolicySchema,
  PermissionProfileSchema,
  type ApprovalPolicy,
  type PermissionProfile,
} from "@caelush/protocol";
import { ToolDispatcherInputError } from "./dispatcher-errors.js";

export interface ToolSecurityContext {
  readonly permissionProfile: PermissionProfile;
  readonly approvalPolicy: ApprovalPolicy;
}

export function assertToolSecurityContext(value: unknown): asserts value is ToolSecurityContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolDispatcherInputError("Tool security context is invalid.");
  }
  const context = value as Record<string, unknown>;
  if (
    Object.keys(context).length !== 2 ||
    !Object.hasOwn(context, "permissionProfile") ||
    !Object.hasOwn(context, "approvalPolicy") ||
    !PermissionProfileSchema.safeParse(context.permissionProfile).success ||
    !ApprovalPolicySchema.safeParse(context.approvalPolicy).success
  ) {
    throw new ToolDispatcherInputError("Tool security context is invalid.");
  }
}
