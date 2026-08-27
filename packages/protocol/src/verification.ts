import { z } from "zod";
import { JsonObjectSchema } from "./primitives/json.js";
import { RunIdSchema, VerificationResultIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";

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
