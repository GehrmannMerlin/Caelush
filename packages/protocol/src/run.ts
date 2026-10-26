import { z } from "zod";
import { ModelRefSchema } from "./model.js";
import { ApprovalPolicySchema, PermissionProfileSchema } from "./policy.js";
import { JsonValueSchema } from "./primitives/json.js";
import {
  RunIdSchema,
  SessionIdSchema,
  StepIdSchema,
  VerificationCheckIdSchema,
} from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";
import { RunLimitsSchema } from "./limits.js";
import { RunResourcePolicySchema } from "./resource-policy.js";
import { RuntimeRefSchema } from "./runtime.js";
import { WorkspaceRefSchema } from "./workspace.js";
import { ReasoningLevelSchema } from "./api/model-selection.js";
import { RunSecurityPolicySnapshotV1Schema } from "./security-policy.js";
import { AttachmentIdsSchema, SubmissionIdSchema } from "./attachment.js";
import { CompletionRequirementSchema } from "./verification.js";

export const CompletionDispositionSchema = z
  .object({
    version: z.literal("COMPLETION_DISPOSITION_V1"),
    type: z.literal("INCOMPLETE"),
    reasonCode: z.enum(["ACCEPTANCE_NOT_MET", "ACCEPTANCE_EVIDENCE_UNAVAILABLE"]),
    requirementSources: z
      .array(z.enum(["USER_EXPLICIT", "HOST_CONTRACT", "MODEL_PROPOSAL"]))
      .min(1)
      .max(3),
    failedCheckIds: z.array(VerificationCheckIdSchema).max(32),
  })
  .strict();
export type CompletionDisposition = z.infer<typeof CompletionDispositionSchema>;

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

const OutputRecoveryPolicySchema = z
  .object({
    version: z.literal("OUTPUT_RECOVERY_V1"),
    maxRecoveryTurns: z.literal(1),
    outputMultiplier: z.literal(2),
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
    /**
     * Proactive reorganization threshold, as a fraction of the usable input budget.
     *
     * Optional so a Run frozen before this parameter existed keeps the historical rule.
     */
    proactiveRatio: z.number().finite().gt(0).lt(1).optional(),
    outputRecovery: OutputRecoveryPolicySchema.optional(),
  })
  .strict();

/** Explicit source-retention contract for Runs created with the deep-compaction budget. */
export const DeepCompactionPolicyV1Schema = z
  .object({
    version: z.literal("DEEP_COMPACTION_V1"),
    triggerRatio: z.number().finite().gt(0).lt(1),
    recentTokens: z.number().int().safe().positive(),
    checkpointMaxTokens: z.number().int().safe().positive(),
    boundaryTokens: z.number().int().safe().nonnegative(),
  })
  .strict();

/** Elastic retention targets. The ratios are Run-frozen soft policy parameters. */
export const DeepCompactionPolicyV2Schema = z
  .object({
    version: z.literal("DEEP_COMPACTION_V2"),
    triggerRatio: z.number().finite().gt(0).lt(1),
    recentRatio: z.number().finite().gt(0).lt(1),
    minimumReleaseRatio: z.number().finite().gt(0).lt(1),
    checkpointMaxTokens: z.number().int().safe().positive(),
    boundaryTokens: z.number().int().safe().nonnegative(),
  })
  .strict();

export const DeepCompactionPolicySchema = DeepCompactionPolicyV1Schema.or(
  DeepCompactionPolicyV2Schema,
);

/** Run-frozen V4 policy: output headroom plus explicit post-compaction retention inputs. */
export const TurnBudgetPolicyV4SnapshotSchema = z
  .object({
    version: z.literal("TURN_BUDGET_V4"),
    algorithm: z.literal("HEADROOM_V1"),
    minOutputTokens: z.number().int().safe().positive(),
    preferredOutputTokens: z.number().int().safe().positive(),
    safetyTokens: z.number().int().safe().nonnegative(),
    expectedGrowthTokens: z.number().int().safe().positive(),
    deepCompaction: DeepCompactionPolicySchema,
    outputRecovery: OutputRecoveryPolicySchema.optional(),
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
)
  .or(TurnBudgetPolicySnapshotSchema)
  .or(TurnBudgetPolicyV4SnapshotSchema);
export type ContextBudgetPolicySnapshot = z.infer<typeof ContextBudgetPolicySnapshotSchema>;
export type ContextRequestBudgetSnapshot = z.infer<typeof ContextRequestBudgetSnapshotSchema>;
export type WorkingSetPolicyV2 = z.infer<typeof WorkingSetPolicyV2Schema>;
export type TurnBudgetPolicySnapshot = z.infer<typeof TurnBudgetPolicySnapshotSchema>;
export type DeepCompactionPolicyV1 = z.infer<typeof DeepCompactionPolicyV1Schema>;
export type DeepCompactionPolicyV2 = z.infer<typeof DeepCompactionPolicyV2Schema>;
export type TurnBudgetPolicyV4Snapshot = z.infer<typeof TurnBudgetPolicyV4SnapshotSchema>;

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
    /** Structured criteria that must be evidenced before a final answer may complete this Run. */
    acceptanceRequirements: z.array(CompletionRequirementSchema).max(8).optional(),
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
    /** User-authorized compaction retry reference; absent from model and Tool contracts. */
    contextCompactionRetryOf: z.string().min(1).max(200).optional(),
    completionDisposition: CompletionDispositionSchema.optional(),
  })
  .strict();
export type AgentRun = z.infer<typeof AgentRunSchema>;

/** New Run writes must use the immutable policy-bound shape; legacy decoding stays migration-only. */
export const CurrentAgentRunSchema = AgentRunSchema.extend({
  securityPolicy: RunSecurityPolicySnapshotV1Schema,
  contextBudgetPolicy: ContextBudgetPolicySnapshotSchema,
});
export type CurrentAgentRun = z.infer<typeof CurrentAgentRunSchema>;
