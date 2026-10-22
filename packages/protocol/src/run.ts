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
import { AttachmentIdsSchema, SubmissionIdSchema } from "./attachment.js";

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

/** Immutable per-Run input/output reserve policy used by the Agent Context Engine. */
export const ContextRequestBudgetSnapshotSchema = z
  .object({
    version: z.literal("ADAPTIVE_V1"),
    outputReserveTokens: z.number().int().safe().positive(),
    safetyReserveTokens: z.number().int().safe().positive(),
  })
  .strict()
  .or(z.object({ version: z.literal("LEGACY_FULL_OUTPUT_V1") }).strict());

export const WorkingSetPolicyV2Schema = z
  .object({
    targetTokens: z.number().int().safe().positive().max(96_000),
    triggerRatio: z.number().finite().gt(0).lt(1),
    postCompactionRatio: z.number().finite().gt(0).lt(1),
    allowCurrentTurnPrefix: z.boolean(),
    cooldownTurns: z.number().int().safe().nonnegative().max(100),
  })
  .strict();

/**
 * The Run-frozen `HEADROOM_V1` parameters.
 *
 * A Run stores the *algorithm and its parameters*, never a per-turn quota: the allowance is derived
 * per turn from the input that is actually prepared, so freezing a number here would recreate the
 * fixed working set this variant replaces.
 */
export const TurnBudgetPolicySnapshotSchema = z
  .object({
    version: z.literal("TURN_BUDGET_V3"),
    algorithm: z.literal("HEADROOM_V1"),
    minOutputTokens: z.number().int().safe().positive(),
    preferredOutputTokens: z.number().int().safe().positive(),
    safetyTokens: z.number().int().safe().nonnegative(),
    expectedGrowthTokens: z.number().int().safe().positive(),
    postCompactionRatio: z.number().finite().gt(0).lt(1),
  })
  .strict();

export const ContextBudgetPolicySnapshotSchema = ContextRequestBudgetSnapshotSchema.or(
  z
    .object({
      version: z.literal("WORKING_SET_V2"),
      requestBudget: ContextRequestBudgetSnapshotSchema,
      workingSet: WorkingSetPolicyV2Schema,
    })
    .strict(),
).or(TurnBudgetPolicySnapshotSchema);
export type ContextBudgetPolicySnapshot = z.infer<typeof ContextBudgetPolicySnapshotSchema>;
export type ContextRequestBudgetSnapshot = z.infer<typeof ContextRequestBudgetSnapshotSchema>;
export type WorkingSetPolicyV2 = z.infer<typeof WorkingSetPolicyV2Schema>;
export type TurnBudgetPolicySnapshot = z.infer<typeof TurnBudgetPolicySnapshotSchema>;

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
    /** Actual user-authored text, distinct from the internal goal for attachment-only Runs. */
    userText: z.string().max(200_000).optional(),
    attachmentIds: AttachmentIdsSchema.optional(),
    submissionId: SubmissionIdSchema.optional(),
    status: RunStatusSchema,
    workspace: WorkspaceRefSchema,
    model: ModelRefSchema,
    reasoningLevel: ReasoningLevelSchema.optional(),
    runtime: RuntimeRefSchema,
    /** Optional only while legacy persisted Runs are decoded during migration. */
    securityPolicy: RunSecurityPolicySnapshotV1Schema.optional(),
    /** Optional only for historical Runs that retain the legacy context budget behavior. */
    contextBudgetPolicy: ContextBudgetPolicySnapshotSchema.optional(),
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
  contextBudgetPolicy: ContextBudgetPolicySnapshotSchema,
});
export type CurrentAgentRun = z.infer<typeof CurrentAgentRunSchema>;
