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
import { ReasoningLevelSchema } from "./api/model-selection.js";
import { RunSecurityPolicySnapshotV1Schema } from "./security-policy.js";

export const RunStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "WAITING_APPROVAL",
  "WAITING_RESOURCE",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "MAX_STEPS_REACHED",
  "BUDGET_EXCEEDED",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Explicit execution contract for Runs created after the natural-completion cutover. */
export const RunCompletionContractSchema = z.literal("NATURAL_V1");
export type RunCompletionContract = z.infer<typeof RunCompletionContractSchema>;

/**
 * A normal execution result. It records the exact final text and the model Step that produced it;
 * it makes no claim that project tests or independent verification passed.
 */
export const NormalRunFinalResultSchema = z
  .object({
    type: z.literal("NORMAL_COMPLETION"),
    text: z
      .string()
      .min(1)
      .max(32_768)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 32 * 1024,
        "normal final text exceeds its byte limit",
      ),
    sourceStepId: StepIdSchema,
  })
  .strict();
export type NormalRunFinalResult = z.infer<typeof NormalRunFinalResultSchema>;

export const AgentRunSchema = z
  .object({
    id: RunIdSchema,
    sessionId: SessionIdSchema,
    goal: z.string().min(1),
    status: RunStatusSchema,
    workspace: WorkspaceRefSchema,
    model: ModelRefSchema,
    reasoningLevel: ReasoningLevelSchema.optional(),
    runtime: RuntimeRefSchema,
    /** Optional only while legacy persisted Runs are decoded during migration. */
    securityPolicy: RunSecurityPolicySnapshotV1Schema.optional(),
    permissionProfile: PermissionProfileSchema,
    approvalPolicy: ApprovalPolicySchema,
    limits: RunLimitsSchema,
    resourcePolicy: RunResourcePolicySchema.optional(),
    currentStepId: StepIdSchema.optional(),
    createdAt: TimestampMsSchema,
    startedAt: TimestampMsSchema.optional(),
    finishedAt: TimestampMsSchema.optional(),
    finalResult: JsonValueSchema.optional(),
    /** Absent on historical Runs, which retain their verification completion contract. */
    completionContract: RunCompletionContractSchema.optional(),
  })
  .strict();
export type AgentRun = z.infer<typeof AgentRunSchema>;

/** New Run writes must use the immutable policy-bound shape; legacy decoding stays migration-only. */
export const CurrentAgentRunSchema = AgentRunSchema.extend({
  securityPolicy: RunSecurityPolicySnapshotV1Schema,
});
export type CurrentAgentRun = z.infer<typeof CurrentAgentRunSchema>;
