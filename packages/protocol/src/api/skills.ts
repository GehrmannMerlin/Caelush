import { z } from "zod";

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
