import { z } from "zod";
import {
  ApprovalPolicySchema,
  FilesystemBoundarySchema,
  PermissionPresetIdSchema,
  PermissionProfileSchema,
  ProcessBoundarySchema,
  RequiredEnforcementSchema,
} from "../policy.js";
import { createEventSchema } from "./base.js";

export const RunSecurityPolicyBoundEventSchema = createEventSchema(
  "run.security_policy.bound",
  z
    .object({
      policySchemaVersion: z.literal(1),
      preset: z
        .object({ id: PermissionPresetIdSchema, version: z.number().int().positive().safe() })
        .strict(),
      permissionProfile: PermissionProfileSchema,
      approvalPolicy: ApprovalPolicySchema,
      filesystemBoundary: FilesystemBoundarySchema,
      processBoundary: ProcessBoundarySchema,
      requiredEnforcement: RequiredEnforcementSchema,
      hardSafetyPolicyVersion: z.string().min(1),
      commandPolicyVersion: z.string().min(1),
      secretPolicyVersion: z.string().min(1),
      policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
);
export type RunSecurityPolicyBoundEvent = z.infer<typeof RunSecurityPolicyBoundEventSchema>;
