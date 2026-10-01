import { z } from "zod";
import { WorkspaceIdSchema } from "../primitives/ids.js";
import {
  PermissionPresetSelectionSchema,
  PermissionPresetDescriptorSchema,
  SecurityCapabilitiesResponseSchema,
  SecurityPreparationRequestSchema,
  SecurityPreparationResponseSchema,
  WorkspaceSecurityCapabilitiesResponseSchema,
} from "../security-policy.js";

export {
  PermissionPresetSelectionSchema,
  PermissionPresetDescriptorSchema,
  SecurityCapabilitiesResponseSchema,
  SecurityPreparationRequestSchema,
  SecurityPreparationResponseSchema,
  WorkspaceSecurityCapabilitiesResponseSchema,
};

export type {
  PermissionPresetSelection,
  PermissionPresetDescriptor,
  SecurityCapabilitiesResponse,
  SecurityPreparationRequest,
  SecurityPreparationResponse,
  WorkspaceSecurityCapabilitiesResponse,
} from "../security-policy.js";

export const WorkspaceSecurityCapabilitiesRequestSchema = z
  .object({ workspaceId: WorkspaceIdSchema })
  .strict();
export type WorkspaceSecurityCapabilitiesRequest = z.infer<
  typeof WorkspaceSecurityCapabilitiesRequestSchema
>;
