import { z } from "zod";
import { ApprovalPolicySchema, PermissionProfileSchema } from "./policy.js";
import { ObservationSchema } from "./observation.js";
import { AgentErrorSchema } from "./error.js";
import { FileChangeSummarySchema } from "./file.js";
import { ProcessSummarySchema } from "./process.js";
import { UsageStateSchema } from "./usage.js";
import { VerificationStateSchema } from "./verification.js";
import { RunStatusSchema } from "./run.js";
import { RuntimeRefSchema } from "./runtime.js";
import { WorkspaceRefSchema } from "./workspace.js";
import { PlanItemSchema } from "./plan.js";
import { RunIdSchema, SessionIdSchema, StepIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";

const ModelOutputRecoveryStateSchema = z
  .discriminatedUnion("phase", [
    z
      .object({
        version: z.literal(1),
        sourceStepId: StepIdSchema,
        previousOutputTokens: z.number().int().safe().positive(),
        targetOutputTokens: z.number().int().safe().positive(),
        phase: z.literal("RESERVED"),
      })
      .strict(),
    z
      .object({
        version: z.literal(1),
        sourceStepId: StepIdSchema,
        previousOutputTokens: z.number().int().safe().positive(),
        targetOutputTokens: z.number().int().safe().positive(),
        phase: z.literal("OPENED"),
        recoveryStepId: StepIdSchema,
      })
      .strict(),
  ])
  .superRefine((recovery, context) => {
    if (recovery.targetOutputTokens <= recovery.previousOutputTokens) {
      context.addIssue({
        code: "custom",
        path: ["targetOutputTokens"],
        message: "target output tokens must exceed previous output tokens",
      });
    }
  });

export const AgentStateSchema = z
  .object({
    runId: RunIdSchema,
    sessionId: SessionIdSchema,
    goal: z.string().min(1),
    status: RunStatusSchema,
    workspace: WorkspaceRefSchema,
    runtime: RuntimeRefSchema,
    permissionProfile: PermissionProfileSchema,
    approvalPolicy: ApprovalPolicySchema,
    currentStepId: StepIdSchema.optional(),
    plan: z.array(PlanItemSchema),
    recentObservations: z.array(ObservationSchema),
    changedFiles: z.array(FileChangeSummarySchema),
    activeProcesses: z.array(ProcessSummarySchema),
    errors: z.array(AgentErrorSchema),
    verification: VerificationStateSchema,
    usage: UsageStateSchema,
    modelOutputRecovery: ModelOutputRecoveryStateSchema.optional(),
    startedAt: TimestampMsSchema.optional(),
    updatedAt: TimestampMsSchema,
  })
  .strict();
export type AgentState = z.infer<typeof AgentStateSchema>;
