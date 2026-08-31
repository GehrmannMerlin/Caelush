import { z } from "zod";
import { FileChangeSummarySchema } from "./file.js";
import { JsonObjectSchema, JsonValueSchema, type JsonValue } from "./primitives/json.js";
import {
  RunIdSchema,
  StepIdSchema,
  VerificationCheckIdSchema,
  VerificationEvidenceIdSchema,
  VerificationPlanIdSchema,
  VerificationResultIdSchema,
} from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";
import { WorkspaceRefSchema } from "./workspace.js";

export const VerificationCheckKindSchema = z.enum(["PROJECT", "WORKSPACE", "GIT", "TASK"]);
export type VerificationCheckKind = z.infer<typeof VerificationCheckKindSchema>;

export const VerificationCheckSourceSchema = z.enum(["SYSTEM", "PROJECT", "USER"]);
export type VerificationCheckSource = z.infer<typeof VerificationCheckSourceSchema>;

export const VerificationCheckRequirementSchema = z.enum(["REQUIRED", "IF_AVAILABLE", "ADVISORY"]);
export type VerificationCheckRequirement = z.infer<typeof VerificationCheckRequirementSchema>;

export const VerificationCheckStageSchema = z.enum([
  "FAST_STATIC",
  "BEHAVIORAL",
  "BROAD",
  "CHANGE_REVIEW",
  "ACCEPTANCE",
]);
export type VerificationCheckStage = z.infer<typeof VerificationCheckStageSchema>;

export const VerificationCheckStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "PASSED",
  "FAILED",
  "ERROR",
  "SKIPPED",
  "CANCELLED",
]);
export type VerificationCheckStatus = z.infer<typeof VerificationCheckStatusSchema>;

export const VerificationCheckSkipReasonSchema = z.enum(["NOT_AVAILABLE", "NOT_APPLICABLE"]);
export type VerificationCheckSkipReason = z.infer<typeof VerificationCheckSkipReasonSchema>;

export const VerificationEvidenceKindSchema = z.enum([
  "COMMAND",
  "WORKSPACE",
  "GIT",
  "TASK",
  "DISCOVERY",
]);
export type VerificationEvidenceKind = z.infer<typeof VerificationEvidenceKindSchema>;

export const VerificationProjectCheckPurposeSchema = z.enum(["LINT", "TYPECHECK", "TEST", "BUILD"]);
export type VerificationProjectCheckPurpose = z.infer<typeof VerificationProjectCheckPurposeSchema>;

const VerificationProjectCheckSpecSchema = z
  .object({
    kind: z.literal("PROJECT"),
    purpose: VerificationProjectCheckPurposeSchema,
    source: VerificationCheckSourceSchema,
  })
  .strict();

const VerificationWorkspaceCheckSpecSchema = z
  .object({
    kind: z.literal("WORKSPACE"),
    purpose: z.literal("CHANGESET_SANITY"),
    source: VerificationCheckSourceSchema,
  })
  .strict();

const VerificationGitCheckSpecSchema = z
  .object({
    kind: z.literal("GIT"),
    purpose: z.literal("CHANGESET_REVIEW"),
    source: VerificationCheckSourceSchema,
  })
  .strict();

const VerificationTaskCheckSpecSchema = z
  .object({
    kind: z.literal("TASK"),
    purpose: z.literal("ACCEPTANCE"),
    source: VerificationCheckSourceSchema,
  })
  .strict();

export const VerificationCheckSpecSchema = z.discriminatedUnion("kind", [
  VerificationProjectCheckSpecSchema,
  VerificationWorkspaceCheckSpecSchema,
  VerificationGitCheckSpecSchema,
  VerificationTaskCheckSpecSchema,
]);
export type VerificationCheckSpec = z.infer<typeof VerificationCheckSpecSchema>;

export const VerificationCheckSchema = z
  .object({
    id: VerificationCheckIdSchema,
    planId: VerificationPlanIdSchema,
    ordinal: z.number().int().min(0).max(31),
    stage: VerificationCheckStageSchema,
    requirement: VerificationCheckRequirementSchema,
    spec: VerificationCheckSpecSchema,
    status: VerificationCheckStatusSchema,
    createdAt: TimestampMsSchema,
    startedAt: TimestampMsSchema.optional(),
    finishedAt: TimestampMsSchema.optional(),
    skipReason: VerificationCheckSkipReasonSchema.optional(),
  })
  .strict()
  .superRefine((check, context) => {
    if (check.status === "SKIPPED" && check.skipReason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["skipReason"],
        message: "Skipped checks need a reason",
      });
    }
    if (check.status !== "SKIPPED" && check.skipReason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["skipReason"],
        message: "Only skipped checks have a skip reason",
      });
    }
  });
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

export const VerificationPlanSchema = z
  .object({
    id: VerificationPlanIdSchema,
    runId: RunIdSchema,
    sourceStepId: StepIdSchema,
    plannerVersion: z.string().min(1).max(128),
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    checks: z.array(VerificationCheckSchema).max(32),
    createdAt: TimestampMsSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    const ordinals = plan.checks.map((check) => check.ordinal);
    if (plan.checks.some((check) => check.planId !== plan.id)) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "Checks must belong to the plan",
      });
    }
    if (ordinals.some((ordinal, index) => ordinal !== index)) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "Check ordinals must be contiguous",
      });
    }
    const logicalChecks = plan.checks.map((check) => `${check.spec.kind}:${check.spec.purpose}`);
    if (new Set(logicalChecks).size !== logicalChecks.length) {
      context.addIssue({ code: "custom", path: ["checks"], message: "Duplicate check intent" });
    }
  });
export type VerificationPlan = z.infer<typeof VerificationPlanSchema>;

export const VerificationCheckDraftSchema = z
  .object({
    ordinal: z.number().int().min(0).max(31),
    stage: VerificationCheckStageSchema,
    requirement: VerificationCheckRequirementSchema,
    spec: VerificationCheckSpecSchema,
  })
  .strict();
export type VerificationCheckDraft = z.infer<typeof VerificationCheckDraftSchema>;

export const VerificationPlanDraftSchema = z
  .object({
    runId: RunIdSchema,
    sourceStepId: StepIdSchema,
    plannerVersion: z.string().min(1).max(128),
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    checks: z.array(VerificationCheckDraftSchema).max(32),
  })
  .strict();
export type VerificationPlanDraft = z.infer<typeof VerificationPlanDraftSchema>;

function isPlainJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every(isPlainJsonValue)
  );
}

const VerificationEvidenceDetailsSchema = JsonValueSchema.refine(isPlainJsonValue, {
  message: "Evidence details must be JSON-safe plain data",
});

export const VerificationEvidenceSchema = z
  .object({
    id: VerificationEvidenceIdSchema,
    planId: VerificationPlanIdSchema,
    checkId: VerificationCheckIdSchema,
    kind: VerificationEvidenceKindSchema,
    summary: z.string().min(1).max(2048),
    details: VerificationEvidenceDetailsSchema.optional(),
    capturedAt: TimestampMsSchema,
  })
  .strict();
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;

export const VerificationProjectFactsSchema = z
  .object({
    isCodeProject: z.boolean().optional(),
    isGitRepository: z.boolean().optional(),
  })
  .strict();
export type VerificationProjectFacts = z.infer<typeof VerificationProjectFactsSchema>;

export const VerificationPlanningInputSchema = z
  .object({
    runId: RunIdSchema,
    sourceStepId: StepIdSchema,
    goal: z.string().min(1).max(32_768),
    workspace: WorkspaceRefSchema,
    changedFiles: z.array(FileChangeSummarySchema).max(4096),
    projectFacts: VerificationProjectFactsSchema.optional(),
  })
  .strict();
export type VerificationPlanningInput = z.infer<typeof VerificationPlanningInputSchema>;

export const VerificationResultStatusSchema = z.enum(["PASSED", "FAILED", "SKIPPED"]);
export type VerificationResultStatus = z.infer<typeof VerificationResultStatusSchema>;

export const VerificationResultSchema = z
  .object({
    id: VerificationResultIdSchema,
    runId: RunIdSchema,
    type: z.string().min(1),
    command: z.string().min(1).optional(),
    status: VerificationResultStatusSchema,
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    evidence: JsonObjectSchema.optional(),
    startedAt: TimestampMsSchema,
    finishedAt: TimestampMsSchema,
  })
  .strict();
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const VerificationStateSchema = z.enum(["NOT_RUN", "RUNNING", "PASSED", "FAILED"]);
export type VerificationState = z.infer<typeof VerificationStateSchema>;
