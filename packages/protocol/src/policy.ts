import { z } from "zod";

export const PermissionProfileSchema = z.enum(["READ_ONLY", "PROJECT_ACCESS", "FULL_ACCESS"]);
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

/** Product-level permission presets. Low-level policy composition is not client-selectable. */
export const PermissionPresetIdSchema = z.enum(["VIEW_ONLY", "WORKSPACE_WRITE", "FULL_ACCESS"]);
export type PermissionPresetId = z.infer<typeof PermissionPresetIdSchema>;

export const ProcessBoundarySchema = z.enum(["READ_ONLY", "WORKSPACE_WRITE", "UNRESTRICTED"]);
export type ProcessBoundary = z.infer<typeof ProcessBoundarySchema>;

export const FilesystemBoundarySchema = z.enum([
  "WORKSPACE_READ_ONLY",
  "WORKSPACE_READ_WRITE",
  "HOST_USER_SCOPE",
]);
export type FilesystemBoundary = z.infer<typeof FilesystemBoundarySchema>;

export const RequiredEnforcementSchema = z.enum(["OS_RESTRICTED", "HARD_SAFETY_ONLY"]);
export type RequiredEnforcement = z.infer<typeof RequiredEnforcementSchema>;

export const ApprovalPolicySchema = z.enum([
  "ALWAYS_ASK",
  "ON_BOUNDARY",
  "DANGEROUS_ONLY",
  "NEVER_ASK",
]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const CapabilitySchema = z.enum([
  "FS_READ",
  "FS_WRITE",
  "FS_DELETE",
  "SHELL_EXEC",
  "PROCESS_START",
  "PROCESS_KILL",
  "GIT_READ",
  "WEB_SEARCH",
  "WEB_FETCH",
  "OUTSIDE_WORKSPACE",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
