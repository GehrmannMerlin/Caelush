import { z } from "zod";

export const PermissionProfileSchema = z.enum(["READ_ONLY", "PROJECT_ACCESS", "FULL_ACCESS"]);
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

export const ApprovalPolicySchema = z.enum(["ALWAYS_ASK", "DANGEROUS_ONLY", "NEVER_ASK"]);
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
