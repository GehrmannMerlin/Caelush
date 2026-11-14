import { z } from "zod";
import { SkillIdSchema, SkillNameSchema } from "../skills.js";

export const SkillCapabilityResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    catalog: z.boolean(),
    invocation: z.boolean(),
    scriptExecution: z.boolean(),
    presentationVersion: z.literal(4).nullable(),
  })
  .strict();
export type SkillCapabilityResponse = z.infer<typeof SkillCapabilityResponseSchema>;

const SkillCatalogQueryFields = {
  q: z.string().max(512).optional(),
  cursor: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[A-Za-z0-9._~-]+$/u)
    .optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export const SkillCatalogQuerySchema = z.object(SkillCatalogQueryFields).strict();
export type SkillCatalogQuery = z.infer<typeof SkillCatalogQuerySchema>;

export const SkillManagementQuerySchema = z.object(SkillCatalogQueryFields).strict();
export type SkillManagementQuery = z.infer<typeof SkillManagementQuerySchema>;

export const SkillImportTargetSchema = z.enum(["CURRENT_PROJECT", "ALL_PROJECTS"]);
export type SkillImportTarget = z.infer<typeof SkillImportTargetSchema>;

export const SKILL_IMPORT_MAX_FILES = 4096;

export const SkillImportFileManifestEntrySchema = z
  .object({
    field: z
      .string()
      .min(6)
      .max(16)
      .regex(/^file-[0-9]{1,4}$/u),
    relativePath: z.string().min(1).max(1024),
  })
  .strict();
export type SkillImportFileManifestEntry = z.infer<typeof SkillImportFileManifestEntrySchema>;

export const SkillImportManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    files: z.array(SkillImportFileManifestEntrySchema).min(1).max(SKILL_IMPORT_MAX_FILES),
  })
  .strict();
export type SkillImportManifestV1 = z.infer<typeof SkillImportManifestV1Schema>;

export const SkillImportReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    skillId: SkillIdSchema,
    name: SkillNameSchema,
    target: SkillImportTargetSchema,
    bundleRevision: z.string().min(1).max(256),
    replaced: z.boolean(),
  })
  .strict();
export type SkillImportReceiptV1 = z.infer<typeof SkillImportReceiptV1Schema>;

export const SkillSettingsUpdateRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    modelInvocable: z.boolean().optional(),
    expectedCatalogRevision: z.string().min(1).max(256),
  })
  .strict()
  .refine(
    (value) => value.enabled !== undefined || value.modelInvocable !== undefined,
    "At least one Skill setting must be provided.",
  );
export type SkillSettingsUpdateRequest = z.infer<typeof SkillSettingsUpdateRequestSchema>;

export const SkillSettingsUpdateResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    catalogRevision: z.string().min(1).max(256),
    settings: z
      .object({
        skillId: SkillIdSchema,
        enabled: z.boolean(),
        modelInvocable: z.boolean(),
        version: z.number().int().nonnegative().safe(),
      })
      .strict(),
  })
  .strict();
export type SkillSettingsUpdateResponse = z.infer<typeof SkillSettingsUpdateResponseSchema>;
