import { z } from "zod";
import { ApprovalRequestSchema, ApprovalResolutionSchema } from "../approval.js";

export const ApprovalListQuerySchema = z
  .object({
    status: z.literal("PENDING").default("PENDING"),
  })
  .strict();
export type ApprovalListQuery = z.infer<typeof ApprovalListQuerySchema>;

export const ApprovalListResponseSchema = z
  .object({
    items: z.array(ApprovalRequestSchema),
  })
  .strict();
export type ApprovalListResponse = z.infer<typeof ApprovalListResponseSchema>;

export const ApprovalResolutionRequestSchema = ApprovalResolutionSchema;
export type ApprovalResolutionRequest = z.infer<typeof ApprovalResolutionRequestSchema>;
