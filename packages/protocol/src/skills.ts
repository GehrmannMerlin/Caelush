import { z } from "zod";
import { RunIdSchema, ToolInvocationIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";
import { WorkflowArtifactRefSchema } from "./prepared-resources.js";

export const SkillIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9:._-]+$/u);
export type SkillId = z.infer<typeof SkillIdSchema>;

export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
export type SkillName = z.infer<typeof SkillNameSchema>;

export const SkillDescriptionSchema = z
  .string()
  .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= 1024)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 4096);
export type SkillDescription = z.infer<typeof SkillDescriptionSchema>;

const OpaqueTokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9._~-]+$/u);
const DisplayNameSchema = z.string().min(1).max(256);

export const SkillSelectionV1Schema = z
  .object({
    skillId: SkillIdSchema,
    selectionToken: OpaqueTokenSchema,
  })
  .strict();
export type SkillSelectionV1 = z.infer<typeof SkillSelectionV1Schema>;

export const SkillDiagnosticV1Schema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Z0-9_]+$/u),
    severity: z.enum(["ERROR", "WARNING"]),
    safeMessage: z.string().min(1).max(256),
  })
  .strict();
export type SkillDiagnosticV1 = z.infer<typeof SkillDiagnosticV1Schema>;

export const SkillCatalogItemV1Schema = z
  .object({
    skillId: SkillIdSchema,
    name: SkillNameSchema,
    description: SkillDescriptionSchema,
    displayName: DisplayNameSchema.optional(),
    selectionToken: OpaqueTokenSchema,
    enabled: z.boolean(),
    userInvocable: z.boolean(),
    modelInvocable: z.boolean(),
  })
  .strict();
export type SkillCatalogItemV1 = z.infer<typeof SkillCatalogItemV1Schema>;

const CatalogRevisionSchema = z.string().min(1).max(256);
const CatalogCursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9._~-]+$/u);
const CatalogPageDiagnosticsSchema = z.array(SkillDiagnosticV1Schema).max(100).readonly();

export const SkillCatalogPageV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    catalogRevision: CatalogRevisionSchema,
    items: z.array(SkillCatalogItemV1Schema).max(100).readonly(),
    nextCursor: CatalogCursorSchema.optional(),
    complete: z.boolean(),
    diagnostics: CatalogPageDiagnosticsSchema,
  })
  .strict();
export type SkillCatalogPageV1 = z.infer<typeof SkillCatalogPageV1Schema>;

export const SkillManagementItemV1Schema = z
  .object({
    skillId: SkillIdSchema,
    name: SkillNameSchema,
    description: SkillDescriptionSchema,
    displayName: DisplayNameSchema.optional(),
    enabled: z.boolean(),
    userInvocable: z.boolean(),
    modelInvocable: z.boolean(),
  })
  .strict();
export type SkillManagementItemV1 = z.infer<typeof SkillManagementItemV1Schema>;

export const SkillManagementPageV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    catalogRevision: CatalogRevisionSchema,
    items: z.array(SkillManagementItemV1Schema).max(100).readonly(),
    nextCursor: CatalogCursorSchema.optional(),
    complete: z.boolean(),
    diagnostics: CatalogPageDiagnosticsSchema,
  })
  .strict();
export type SkillManagementPageV1 = z.infer<typeof SkillManagementPageV1Schema>;

export const SkillBundleRefV1Schema = z
  .object({
    bundleRevision: CatalogRevisionSchema,
    artifactRef: WorkflowArtifactRefSchema,
    manifestFingerprint: CatalogRevisionSchema,
  })
  .strict();
export type SkillBundleRefV1 = z.infer<typeof SkillBundleRefV1Schema>;

export const RunSkillBindingV1Schema = z
  .object({
    bindingId: z.string().min(1).max(256),
    runId: RunIdSchema,
    skillId: SkillIdSchema,
    name: SkillNameSchema,
    displayName: DisplayNameSchema.optional(),
    bundleRevision: CatalogRevisionSchema,
    sourceFingerprint: CatalogRevisionSchema,
    artifactRef: WorkflowArtifactRefSchema,
    origin: z.enum(["USER", "MODEL"]),
    sourceToolInvocationId: ToolInvocationIdSchema.optional(),
    createdAt: TimestampMsSchema,
  })
  .strict();
export type RunSkillBindingV1 = z.infer<typeof RunSkillBindingV1Schema>;

export const SkillFailureReasonSchema = z.enum([
  "SKILLS_UNAVAILABLE",
  "SKILL_NOT_FOUND",
  "SKILL_SELECTION_STALE",
  "SKILL_DISABLED",
  "SKILL_LOAD_FAILED",
  "SKILL_CORE_BUDGET_EXCEEDED",
  "SKILL_ARTIFACT_INVALID",
  "SKILL_RESOURCE_DENIED",
  "SKILL_SCRIPT_UNAVAILABLE",
]);
export type SkillFailureReason = z.infer<typeof SkillFailureReasonSchema>;
