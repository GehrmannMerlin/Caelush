import { z } from "zod";
import { RunIdSchema } from "../primitives/ids.js";

/**
 * Run input intake (V1).
 *
 * ```text
 * PENDING   durably accepted; not yet a canonical conversation message
 * RECORDED  one canonical USER(origin=STEERING) record exists for it
 * ASSIGNED  its message was part of a prepared model step this Run opened
 * ```
 *
 * The three stages are three different facts. `ASSIGNED` does not mean the provider received
 * the request, the model understood it, or the work it asked for was performed.
 */
export const RunInputStageSchema = z.enum(["PENDING", "RECORDED", "ASSIGNED"]);
export type RunInputStage = z.infer<typeof RunInputStageSchema>;

export const RUN_INPUT_STAGES = [
  "PENDING",
  "RECORDED",
  "ASSIGNED",
] as const satisfies readonly RunInputStage[];

/** Why a Run input could not be accepted. Closed on purpose: clients switch on it. */
export const RunInputErrorReasonSchema = z.enum([
  "NOT_SUPPORTED",
  "RUN_NOT_READY",
  "RUN_TERMINAL",
  "TARGET_MISMATCH",
  "IDEMPOTENCY_CONFLICT",
  "QUEUE_FULL",
  "TEXT_TOO_LARGE",
  "STORE_UNAVAILABLE",
]);
export type RunInputErrorReason = z.infer<typeof RunInputErrorReasonSchema>;

/* ------------------------------------------------------------------ limits */

/**
 * First-version engineering limits.
 *
 * They live in Protocol because the client and the daemon must agree on them without either
 * importing the other's private application code. They are not user settings.
 */
export const RUN_INPUT_TEXT_MAX_BYTES = 32 * 1024;
/** PENDING plus RECORDED inputs count against this: a stage change cannot dodge the cap. */
export const RUN_INPUT_UNASSIGNED_MAX_COUNT = 32;
export const RUN_INPUT_UNASSIGNED_MAX_BYTES = 256 * 1024;
/** One safe boundary materializes at most this much. */
export const RUN_INPUT_BATCH_MAX_COUNT = 8;
export const RUN_INPUT_BATCH_MAX_BYTES = 64 * 1024;
/** One input list page. */
export const RUN_INPUT_PAGE_MAX = 100;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/* ----------------------------------------------------------------- requests */

const RunInputTextSchema = z.string().superRefine((value, context) => {
  if (value.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Run input text must not be empty" });
    return;
  }
  if (utf8ByteLength(value) > RUN_INPUT_TEXT_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "Run input text exceeds the byte limit" });
  }
});

/**
 * One deliberate user submission.
 *
 * The identity is client-generated and stable across retries; a second, deliberate submission of
 * the same text is a new input with a new identity. Attachments, provider parameters and session
 * redirects are deliberately absent: this contract is text-only, and an unknown field fails.
 */
export const SubmitRunInputRequestSchema = z
  .object({
    inputId: z.string().uuid(),
    text: RunInputTextSchema,
  })
  .strict();
export type SubmitRunInputRequest = z.infer<typeof SubmitRunInputRequestSchema>;

/** The bounded public projection of one accepted input. */
export const RunInputReceiptSchema = z
  .object({
    inputId: z.string().uuid(),
    runId: RunIdSchema,
    acceptedSequence: z.number().int().positive(),
    stage: RunInputStageSchema,
    acceptedAt: z.number().int().nonnegative(),
    messageId: z.string().min(1).optional(),
    firstStepId: z.string().min(1).optional(),
  })
  .strict();
export type RunInputReceipt = z.infer<typeof RunInputReceiptSchema>;

export const RunInputListQuerySchema = z
  .object({
    after: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(RUN_INPUT_PAGE_MAX).default(50),
  })
  .strict();
export type RunInputListQuery = z.infer<typeof RunInputListQuerySchema>;

export const RunInputListResponseSchema = z
  .object({
    items: z.array(RunInputReceiptSchema),
    /** The largest accepted sequence in this page, when another page may follow. */
    nextCursor: z.number().int().positive().optional(),
  })
  .strict();
export type RunInputListResponse = z.infer<typeof RunInputListResponseSchema>;

/** The structured body a refused intake returns inside the existing ApiError envelope. */
export const RunInputErrorDetailsSchema = z
  .object({
    reason: RunInputErrorReasonSchema,
  })
  .strict();
export type RunInputErrorDetails = z.infer<typeof RunInputErrorDetailsSchema>;
