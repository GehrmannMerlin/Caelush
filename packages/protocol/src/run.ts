import { z } from "zod";
import { ModelRefSchema } from "./model.js";
import { ApprovalPolicySchema, PermissionProfileSchema } from "./policy.js";
import { JsonValueSchema } from "./primitives/json.js";
import { RunIdSchema, SessionIdSchema, StepIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";
import { RunLimitsSchema } from "./limits.js";
import { RunResourcePolicySchema } from "./resource-policy.js";
import { RuntimeRefSchema } from "./runtime.js";
import { WorkspaceRefSchema } from "./workspace.js";

export const RunStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "WAITING_APPROVAL",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "MAX_STEPS_REACHED",
  "BUDGET_EXCEEDED",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const AgentRunSchema = z
  .object({
    id: RunIdSchema,
    sessionId: SessionIdSchema,
    goal: z.string().min(1),
    status: RunStatusSchema,
    workspace: WorkspaceRefSchema,
    model: ModelRefSchema,
    runtime: RuntimeRefSchema,
    permissionProfile: PermissionProfileSchema,
    approvalPolicy: ApprovalPolicySchema,
    limits: RunLimitsSchema,
    resourcePolicy: RunResourcePolicySchema.optional(),
    currentStepId: StepIdSchema.optional(),
    createdAt: TimestampMsSchema,
    startedAt: TimestampMsSchema.optional(),
    finishedAt: TimestampMsSchema.optional(),
    finalResult: JsonValueSchema.optional(),
  })
  .strict();
export type AgentRun = z.infer<typeof AgentRunSchema>;
