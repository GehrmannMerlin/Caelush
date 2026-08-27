import { z } from "zod";
import { ApprovalRequestSchema, ApprovalStatusSchema, ApprovalScopeSchema } from "../approval.js";
import { ApprovalRequestIdSchema } from "../primitives/ids.js";
import { createEventSchema } from "./base.js";

export const ApprovalRequestedEventSchema = createEventSchema(
  "approval.requested",
  z.object({ approval: ApprovalRequestSchema }).strict(),
);
export const ApprovalResolvedEventSchema = createEventSchema(
  "approval.resolved",
  z
    .object({
      approvalId: ApprovalRequestIdSchema,
      status: ApprovalStatusSchema,
      grantedScope: ApprovalScopeSchema.optional(),
    })
    .strict(),
);

export type ApprovalRequestedEvent = z.infer<typeof ApprovalRequestedEventSchema>;
export type ApprovalResolvedEvent = z.infer<typeof ApprovalResolvedEventSchema>;
